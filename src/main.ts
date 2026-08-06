import './style.css';
import * as THREE from 'three';
import { NBodySimulation } from './simulation';
import { VortexFieldSimulation } from './vortex';
import type { ParticleSimulation } from './simulation-interface';
import { createStarField, createCoreGlow, createEnergyHaze, createVortexCore, createTrailRenderer, type StarField, type CoreGlow, type EnergyHaze, type VortexCore, type TrailRenderer } from './particles';
import { createGlowPlane, type GlowPlane } from './glowPlane';
import { Renderer } from './renderer';
import { Ui } from './ui';
import { PRESETS } from './presets';
import { PRESET_RECOMMENDED, DEFAULT_VORTEX } from './types';
import type { SimParams, VortexParams, PresetName, EngineName } from './types';

/**
 * 入口：组装渲染器 / 模拟 / 面板，驱动主循环。
 *
 * 双引擎（面板顶部或 URL ?engine= 切换）：
 * - vortex：三维旋涡能量球（默认引擎）
 * - galaxy：N-body 银河（Art Preview 静态预览 或 ?mode=sim 动画）
 */

function isMobile(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    Math.min(window.innerWidth, window.innerHeight) < 640
  );
}

const mobile = isMobile();

// 支持 URL 参数：?engine=galaxy&preset=collision&seed=7&mode=sim&azim=90
const urlParams = new URLSearchParams(window.location.search);
const urlPreset = urlParams.get('preset');
const urlSeed = Number(urlParams.get('seed'));
const urlAzim = Number(urlParams.get('azim'));

const engine: EngineName = urlParams.get('engine') === 'galaxy' ? 'galaxy' : 'vortex';

/** Art Preview 静态预览模式（仅 galaxy 引擎，默认）；?mode=sim 恢复 N-body 动画 */
const artMode = urlParams.get('mode') !== 'sim';

function parsePreset(v: string | null): PresetName {
  return v === 'spiral' || v === 'collision' || v === 'chaos' || v === 'hero'
    ? v
    : 'hero';
}

const seed = Number.isInteger(urlSeed) && urlSeed > 0 ? urlSeed : 42;

const params: SimParams = {
  preset: artMode ? 'hero' : parsePreset(urlPreset),
  gravity: 0.85,
  rotation: 0.98,
  chaos: 0.12,
  timeScale: 0.18,
  particleCount: mobile ? 12000 : 40000,
  seed,
  bloom: true,
  showHud: false,
  paused: artMode && engine === 'galaxy', // Art Preview：物理静止
};

// URL 指定了预设时套用该预设的推荐参数
if (urlPreset) {
  const rec = PRESET_RECOMMENDED[params.preset];
  params.gravity = rec.gravity;
  params.rotation = rec.rotation;
  params.chaos = rec.chaos;
  params.timeScale = rec.timeScale;
}

const vortexParams: VortexParams = {
  ...DEFAULT_VORTEX,
  particleCount: mobile ? 8000 : 15000,
  seed,
};

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new Renderer(canvas, params.bloom);

let sim: ParticleSimulation;
/** vortex 引擎时指向具体模拟实例（形成进度写回用） */
let vortexSim: VortexFieldSimulation | null = null;
/** V8：vortex 全部可视对象的统一根节点——真实空间缩放与整体主旋转都作用在它上面 */
let vortexRoot: THREE.Group | null = null;
/** V8：形成动画已逝真实时间（秒，未乘 timeScale） */
let formationElapsed = 0;
/** V8：整体主旋转轴（seed 无关，构图稳定） */
const dominantAxis = new THREE.Vector3(0.25, 1, 0.18).normalize();
/** ?spin=0：调试/测量用，关闭整体主旋转（排除 2D 轮廓的朝向噪声） */
const spinEnabled = urlParams.get('spin') !== '0';

/**
 * V8 分阶段生长曲线（formationDuration 默认 5 真实秒）：
 * - p 0~0.12（0~0.6s）：scale 0.08 → 0.14，只有核心 + 少量内层短循环线
 * - p 0.12~0.76（0.6~3.8s）：scale 0.14 → 0.82，easeInOutCubic，循环线逐渐增多
 * - p 0.76~1（3.8~5s）：scale 0.82 → 1.0，外围气流与雾层登场；缩放增益一路维持到
 *   形成结束的最后一帧，压住此窗口内向心压缩的物理收缩，保证外轮廓全程单调增大，
 *   完成后回到 V7 最终形态
 */
function growthScale(p: number): number {
  if (p <= 0.12) return 0.08 + 0.06 * (p / 0.12);
  if (p <= 0.76) {
    const t = (p - 0.12) / 0.64;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    return 0.14 + 0.68 * e;
  }
  return 0.82 + 0.18 * ((p - 0.76) / 0.24);
}

/** V8 整体主旋转速度（rad/s）：核心阶段最明显，随尺寸增大减弱，完成后极慢漂移 */
function spinSpeed(p: number): number {
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return 2.4 + (0.12 - 2.4) * e;
}

/**
 * V8 粒子可见包络（相对 R）：只有 r < envelope 的粒子点可见（15% 软淡出带）。
 * 实测外围粒子光晕（局部半径）在形成后段呈「山峰形」：p≈0.7 膨胀到 ~1.3R，
 * 随后回收下潜收缩到 ~0.9R——直接显示会让外轮廓在末段回缩。
 * 包络取一条始终贴在光晕下沿、单调上升的曲线（0.8R → 0.9R）：
 * 真实尺寸增长仍由 vortexRoot.scale 承担，包络只削掉超出下沿的瞬态外鼓；
 * p=1 时跳到 1.35R（> 球形约束上限 1.3R），稳态不裁剪任何粒子，最终形态与 V7 一致。
 */
function pointsEnvelope(p: number): number {
  if (p >= 1) return 1.35;
  const t = Math.min(Math.max((p - 0.55) / 0.45, 0), 1);
  const s = t * t * (3 - 2 * t);
  return 0.8 + 0.1 * s;
}

/** ?env= 调试用包络覆盖（相对 R，>0 时取代 pointsEnvelope） */
const envOverride = Number(urlParams.get('env'));
function envelopeWorld(p: number): number {
  const rn = Number.isFinite(envOverride) && envOverride > 0 ? envOverride : pointsEnvelope(p);
  return rn * vortexParams.radius;
}

let stars: StarField;
let coreGlow: CoreGlow | null = null;
let glowPlane: GlowPlane | null = null;
let haze: EnergyHaze | null = null;
let vortexCore: VortexCore | null = null;
let trails: TrailRenderer | null = null;

/** URL ?paused=1：加载即暂停（验收截图用） */
const urlPaused = urlParams.get('paused') === '1';
if (urlPaused) params.paused = true;

/** URL ?ts=：覆盖 vortex 播放速度（验收截图定格形成阶段用，如 ?ts=1 实时） */
const urlTs = Number(urlParams.get('ts'));
if (Number.isFinite(urlTs) && urlTs >= 0) vortexParams.timeScale = urlTs;

function regenerate(): void {
  // 释放旧资源
  formationElapsed = 0;
  if (stars) {
    renderer.scene.remove(stars.normal);
    renderer.scene.remove(stars.bright);
    stars.dispose();
  }
  if (coreGlow) {
    renderer.scene.remove(coreGlow.points);
    coreGlow.dispose();
    coreGlow = null;
  }
  if (glowPlane) {
    renderer.scene.remove(glowPlane.mesh);
    glowPlane.dispose();
    glowPlane = null;
  }
  if (haze) {
    renderer.scene.remove(haze.mesh);
    haze.dispose();
    haze = null;
  }
  if (vortexCore) {
    renderer.scene.remove(vortexCore.mesh);
    vortexCore.dispose();
    vortexCore = null;
  }
  if (trails) {
    if (trails.object.parent) trails.object.parent.remove(trails.object);
    trails.dispose();
    trails = null;
  }
  if (vortexRoot) {
    renderer.scene.remove(vortexRoot);
    vortexRoot = null;
  }

  if (engine === 'galaxy') {
    const nbody = new NBodySimulation(params);
    sim = nbody;
    stars = createStarField(sim, renderer.pixelRatio);
    coreGlow = createCoreGlow(nbody, renderer.pixelRatio);
    renderer.scene.add(stars.normal);
    renderer.scene.add(stars.bright);
    renderer.scene.add(coreGlow.points);

    // Art Preview：连续银河光雾层（仅在 hero 场景下添加）
    if (artMode && params.preset === 'hero') {
      glowPlane = createGlowPlane();
      renderer.scene.add(glowPlane.mesh);
    }

    if (artMode) {
      renderer.frameArtCamera();
      // Art Preview：固定镜头
      renderer.controls.autoRotate = false;
      renderer.controls.enabled = false;
    } else {
      renderer.frameCamera(PRESETS[params.preset].cameraDistance);
      renderer.controls.autoRotate = true;
      renderer.controls.enabled = true;
    }
  } else {
    vortexSim = new VortexFieldSimulation(vortexParams);
    sim = vortexSim;
    // 粒子是辅助层：boost 1.0 弱化噪点感，主视觉交给流线；
    // dynamicColor：颜色每物理步按半径刷新（外蓝内白）
    stars = createStarField(sim, renderer.pixelRatio, { speedRef: 12.0, boost: 1.0, brightMaxLum: 1.6, dynamicColor: true });
    haze = createEnergyHaze(vortexParams.radius);
    vortexCore = createVortexCore(vortexParams.radius);
    trails = createTrailRenderer(sim, {
      density: vortexParams.trailDensity,
      width: vortexParams.trailWidth,
    });
    trails.setPersistence(vortexParams.trailPersistence);
    trails.setBrightness(vortexParams.trailBrightness);
    trails.setSaturation(vortexParams.blueSaturation);
    trails.setWidth(vortexParams.trailWidth);
    trails.setResolution(window.innerWidth, window.innerHeight);
    vortexCore.setWhiteRadius(vortexParams.coreWhiteRadius);
    // V8：全部 vortex 可视对象挂到统一根节点——真实空间缩放与整体主旋转的载体
    vortexRoot = new THREE.Group();
    vortexRoot.scale.setScalar(growthScale(0));
    // ?layers= 调试图层隔离：trails / points / none
    const layers = urlParams.get('layers');
    if (layers !== 'trails' && layers !== 'none') {
      vortexRoot.add(stars.normal);
      vortexRoot.add(stars.bright);
    }
    if (layers !== 'trails' && layers !== 'points') {
      vortexRoot.add(haze.mesh);
      // ?core=0 调试：隔离核心层
      if (urlParams.get('core') !== '0') vortexRoot.add(vortexCore.mesh);
    }
    if (layers !== 'points' && layers !== 'none') {
      vortexRoot.add(trails.object);
    }
    renderer.scene.add(vortexRoot);

    // V8 物理预热（不可见）：快进 180 步（3 模拟秒），让向心压缩 + 回收流建立稳态，
    // 形成完成时（t≈5s）立即呈现完整 V7 最终形态。预热时长经过校准：过短则第一波
    // 回收下潜未完成、外圈暂时变空；过长则模拟年龄偏大、光晕在形成末段进入 V7 固有
    // 的缓慢收缩，外轮廓会在缩放增益尾声被压回。
    // 流线不同步预热：所有轨迹历史为空，到达各自 birthProgress 后从短弧开始生长。
    for (let i = 0; i < 180; i++) sim.update(1 / 60);

    // V8：形成动画由 tick 以真实时间驱动（无预热，首帧只见缩小后的核心）。
    // 初始进度同步（暂停/首帧也正确）
    vortexSim.setFormationProgress(0);
    sim.syncSpeed();
    stars.sync(sim.time);
    stars.setActiveRn(sim.activeRn ?? 1e9);
    stars.setMaxRadius(envelopeWorld(0));
    trails.sync(sim.time, 0);
    haze.sync(sim.time);
    haze.setFormation(0);
    vortexCore.sync(sim.time);
    vortexCore.setFormation(0);

    // URL ?ff=秒：确定性快进到形成时间线上的指定真实秒（验收截图用）。
    // 按 1/60s 步进同时推进 formationElapsed 与物理（等价实时播放），与低帧率无关。
    const ff = Number(urlParams.get('ff'));
    if (Number.isFinite(ff) && ff > 0 && vortexSim && trails && haze && vortexCore) {
      const step = 1 / 60;
      const dur = Math.max(vortexParams.formationDuration, 0.5);
      let p = 0;
      for (let e = 0; e < ff; e += step) {
        formationElapsed += step;
        p = Math.min(formationElapsed / dur, 1);
        vortexSim.setFormationProgress(p);
        sim.update(step * vortexParams.timeScale);
        trails.sync(sim.time, p);
        // 与实时 tick 一致：主旋转按每帧增量积分（而非一次总转），
        // 保证各验收截图的朝向与真实播放该时刻一致
        if (spinEnabled) vortexRoot.rotateOnAxis(dominantAxis, spinSpeed(p) * step);
      }
      vortexRoot.scale.setScalar(growthScale(p));
      sim.syncSpeed();
      stars.sync(sim.time);
      stars.setActiveRn(sim.activeRn ?? 1e9);
      stars.setMaxRadius(envelopeWorld(p));
      haze.sync(sim.time);
      haze.setFormation(p);
      vortexCore.sync(sim.time);
      vortexCore.setFormation(p);
    }

    const azim = Number.isFinite(urlAzim) ? urlAzim : 28;
    renderer.frameVortexCamera(vortexParams.radius, azim);
    renderer.setExposure(0.9);
    // Bloom 克制档：threshold 0.75 只拾取最亮的流线头部与核心，
    // strength 0.38 保留蓝色色相，不把高亮蓝漂成纯白
    renderer.setBloomParams(vortexParams.bloomStrength, 0.3, 0.75);
    // V8：关闭相机自动环绕——旋转由能量球自身的主旋转表达，不用相机转动冒充
    renderer.controls.autoRotate = false;
    renderer.controls.enabled = true;
  }
}

// ---------------------------------------------------------------- 主循环

let lastTime = performance.now();
let running = true;

// FPS 统计
let fpsFrames = 0;
let fpsLast = performance.now();
let fps = 0;

const ui = new Ui(params, vortexParams, engine, {
  onRegenerate: () => regenerate(),
  onPauseToggle: (v) => {
    params.paused = v;
  },
  onBloomToggle: (v) => renderer.setBloom(v),
  onHudToggle: (v) => ui.setHudVisible(v),
  onTrailChange: (v) => trails?.setPersistence(v),
  onTrailWidthChange: (v) => trails?.setWidth(v),
  // 颜色系统四项实时调整（无需重建）：饱和度 / 流线亮度 / 核心白半径 / 泛光强度
  onColorLive: () => {
    trails?.setSaturation(vortexParams.blueSaturation);
    trails?.setBrightness(vortexParams.trailBrightness);
    vortexCore?.setWhiteRadius(vortexParams.coreWhiteRadius);
    renderer.setBloomParams(vortexParams.bloomStrength, 0.3, 0.75);
  },
  onEngineChange: (e) => {
    // 引擎切换通过刷新页面完成：两个引擎的参数/相机/模式差异较大，重载最干净
    const p = new URLSearchParams(window.location.search);
    p.set('engine', e);
    window.location.search = p.toString();
  },
  onRandomize: () => {
    const newSeed = 1 + Math.floor(Math.random() * 99998);
    if (engine === 'galaxy') params.seed = newSeed;
    else vortexParams.seed = newSeed;
    regenerate();
    return newSeed;
  },
});

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (!running) {
    lastTime = now;
    return;
  }

  // 帧间隔截断，防止后台切回时一口气追太多步（物理用）
  const realDt = (now - lastTime) / 1000; // 真实墙钟间隔（形成动画用）
  const frameDt = Math.min(realDt, 0.05);
  lastTime = now;

  if (!params.paused) {
    // V8：形成动画使用真实墙钟时间（未截断、未乘 timeScale），默认 5 秒完成。
    // 低帧率设备上物理步进会放慢，但形成时长不变。
    let formP = 1;
    if (engine === 'vortex' && vortexRoot && vortexSim) {
      formationElapsed += realDt;
      formP = Math.min(
        formationElapsed / Math.max(vortexParams.formationDuration, 0.5),
        1
      );
      // 真实空间缩放：视觉尺寸只由 vortexRoot.scale 决定（activeRn 不再承担尺寸职责）
      vortexRoot.scale.setScalar(growthScale(formP));
      // 统一主旋转：核心阶段最明显，随尺寸增大减弱，完成后只剩极慢漂移
      if (spinEnabled) vortexRoot.rotateOnAxis(dominantAxis, spinSpeed(formP) * realDt);
      // 形成进度写回模拟：activeRn 只控制各层粒子的出现顺序
      vortexSim.setFormationProgress(formP);
    }

    // Time Scale 只影响播放速度，物理步长不变（稳定性/确定性不受影响）
    const ts = engine === 'galaxy' ? params.timeScale : vortexParams.timeScale;
    sim.update(frameDt * ts);
    sim.syncSpeed();
    stars.sync(sim.time);
    coreGlow?.sync(sim.time);
    // 流线跟随模拟时间记录：Time Scale 降低时弧线长度不变，暂停时冻结；
    // formP 驱动每条轨迹的 birthProgress（开始记录 + 淡入）
    trails?.sync(sim.time, formP);
    haze?.sync(sim.time);
    vortexCore?.sync(sim.time);
    // 形成进度驱动各层显隐（粒子层顺序 / 核心与雾淡入）
    stars.setActiveRn(sim.activeRn ?? 1e9);
    // V8 粒子可见包络：仅 vortex 生效（galaxy 保持默认 1e9 不裁剪）
    if (engine === 'vortex') stars.setMaxRadius(envelopeWorld(formP));
    haze?.setFormation(sim.formationProgress ?? 1);
    vortexCore?.setFormation(sim.formationProgress ?? 1);
  }

  renderer.render();

  // HUD
  fpsFrames++;
  if (now - fpsLast >= 500) {
    fps = (fpsFrames * 1000) / (now - fpsLast);
    fpsFrames = 0;
    fpsLast = now;
    ui.updateHud(fps, sim.count, sim.stepCount);
  }
}

// 页面隐藏时暂停（rAF 本身会停，这里额外保证 lastTime 不漂移）
document.addEventListener('visibilitychange', () => {
  running = document.visibilityState === 'visible';
  if (running) lastTime = performance.now();
});

window.addEventListener('beforeunload', () => {
  ui.dispose();
  stars.dispose();
  coreGlow?.dispose();
  glowPlane?.dispose();
  haze?.dispose();
  vortexCore?.dispose();
  trails?.dispose();
  renderer.dispose();
});

// LineMaterial.resolution 跟随视口
renderer.onResize = (w, h) => trails?.setResolution(w, h);

regenerate();
requestAnimationFrame(tick);
