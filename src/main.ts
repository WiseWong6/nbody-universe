import './style.css';
import { NBodySimulation } from './simulation';
import { VortexFieldSimulation } from './vortex';
import type { ParticleSimulation } from './simulation-interface';
import { createStarField, createCoreGlow, createVortexCore, createTrailRenderer, type StarField, type CoreGlow, type VortexCore, type TrailRenderer } from './particles';
import { createChakraVolume, type ChakraVolume } from './chakraVolume';
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
  // V6：粒子只是少量边缘碎光（视觉 ≤5%），数量减半再减
  particleCount: mobile ? 3000 : 5000,
  seed,
};

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new Renderer(canvas, params.bloom);

let sim: ParticleSimulation;
let stars: StarField;
let coreGlow: CoreGlow | null = null;
let glowPlane: GlowPlane | null = null;
let volume: ChakraVolume | null = null;
let vortexCore: VortexCore | null = null;
let trails: TrailRenderer | null = null;

/** URL ?paused=1：加载即暂停（验收截图用） */
const urlPaused = urlParams.get('paused') === '1';
if (urlPaused) params.paused = true;

function regenerate(): void {
  // 释放旧资源
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
  if (volume) {
    renderer.scene.remove(volume.object);
    volume.dispose();
    volume = null;
  }
  if (vortexCore) {
    renderer.scene.remove(vortexCore.mesh);
    vortexCore.dispose();
    vortexCore = null;
  }
  if (trails) {
    renderer.scene.remove(trails.object);
    trails.dispose();
    trails = null;
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
    sim = new VortexFieldSimulation(vortexParams);
    // 粒子是辅助层（边缘碎光，视觉占比 ≤5%）；V6 主视觉是 ChakraVolume 体积 Shader；
    // dynamicColor：颜色每物理步按半径刷新（外蓝内白）
    stars = createStarField(sim, renderer.pixelRatio, { speedRef: 12.0, boost: 0.35, brightMaxLum: 1.6, dynamicColor: true });
    // V6 主视觉：球体 Raymarch 体积能量体（连续蓝白查克拉流，Formation 径向显现）
    volume = createChakraVolume(vortexParams.radius);
    volume.setSpin(vortexParams.coreSpin, vortexParams.outerSpin);
    volume.setDensity(vortexParams.volumeDensity);
    volume.setTurbulence(vortexParams.turbulence);
    volume.setFormationDuration(vortexParams.formationDuration);
    vortexCore = createVortexCore(vortexParams.radius);
    // V6 辅助能量丝：少量（Ribbon Amount）、细线、低透明、Catmull-Rom 平滑短弧
    trails = createTrailRenderer(sim, vortexParams.ribbonAmount);
    trails.setPersistence(vortexParams.trailPersistence);
    trails.setBrightness(vortexParams.trailBrightness);
    trails.setSaturation(vortexParams.blueSaturation);
    trails.setWidth(vortexParams.trailWidth);
    trails.setScrollSpeed(vortexParams.flowScrollSpeed);
    trails.setResolution(window.innerWidth, window.innerHeight);
    vortexCore.setWhiteRadius(vortexParams.coreWhiteRadius);
    // ?layers= 调试图层隔离：trails / points / none
    const layers = urlParams.get('layers');
    if (layers !== 'trails' && layers !== 'none') {
      renderer.scene.add(stars.normal);
      renderer.scene.add(stars.bright);
    }
    if (layers !== 'none') {
      renderer.scene.add(volume.object);
      // ?core=0 调试：隔离核心层
      if (urlParams.get('core') !== '0') renderer.scene.add(vortexCore.mesh);
    }
    if (layers !== 'points' && layers !== 'none') {
      renderer.scene.add(trails.object);
    }

    // 预热：只快进 12 步（0.2 模拟秒）——Formation 形成动画从头对用户可见
    for (let i = 0; i < 12; i++) {
      sim.update(1 / 60);
      trails.sync(sim.time);
    }
    sim.syncSpeed();
    stars.sync(sim.time);
    volume.sync(sim.time);
    vortexCore.sync(sim.time);

    const azim = Number.isFinite(urlAzim) ? urlAzim : 28;
    renderer.frameVortexCamera(vortexParams.radius, azim);
    renderer.setExposure(0.9);
    // Bloom 克制档：threshold 0.75 只拾取最亮的流线头部与核心，
    // strength 0.38 保留蓝色色相，不把高亮蓝漂成纯白
    renderer.setBloomParams(vortexParams.bloomStrength, 0.3, 0.75);
    renderer.controls.autoRotate = true;
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
  // V6 实时调整（无需重建）：体积旋转/密度/湍流/Formation 时长 + 泛光强度，
  // 以及核心旋转 / 压缩 / 湍流同步进 sim.params（构造时被浅拷贝）
  onColorLive: () => {
    volume?.setSpin(vortexParams.coreSpin, vortexParams.outerSpin);
    volume?.setDensity(vortexParams.volumeDensity);
    volume?.setTurbulence(vortexParams.turbulence);
    volume?.setFormationDuration(vortexParams.formationDuration);
    vortexCore?.setWhiteRadius(vortexParams.coreWhiteRadius);
    renderer.setBloomParams(vortexParams.bloomStrength, 0.3, 0.75);
    if (sim instanceof VortexFieldSimulation) {
      sim.params.coreSpin = vortexParams.coreSpin;
      sim.params.compression = vortexParams.compression;
      sim.params.turbulence = vortexParams.turbulence;
    }
  },
  // Ribbon Amount 变化：只重建辅助能量丝层（不重建模拟）
  onTrailRebuild: () => {
    if (!trails || !sim) return;
    const inScene = trails.object.parent === renderer.scene;
    renderer.scene.remove(trails.object);
    trails.dispose();
    trails = createTrailRenderer(sim, vortexParams.ribbonAmount);
    trails.setPersistence(vortexParams.trailPersistence);
    trails.setBrightness(vortexParams.trailBrightness);
    trails.setSaturation(vortexParams.blueSaturation);
    trails.setWidth(vortexParams.trailWidth);
    trails.setScrollSpeed(vortexParams.flowScrollSpeed);
    trails.setResolution(window.innerWidth, window.innerHeight);
    if (inScene) renderer.scene.add(trails.object);
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

  // 帧间隔截断，防止后台切回时一口气追太多步
  const frameDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (!params.paused) {
    // Time Scale 只影响播放速度，物理步长不变（稳定性/确定性不受影响）
    const ts = engine === 'galaxy' ? params.timeScale : vortexParams.timeScale;
    sim.update(frameDt * ts);
    sim.syncSpeed();
    stars.sync(sim.time);
    coreGlow?.sync(sim.time);
    // 流线跟随模拟时间记录：Time Scale 降低时弧线长度不变，暂停时冻结
    trails?.sync(sim.time);
    volume?.sync(sim.time);
    vortexCore?.sync(sim.time);
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
  volume?.dispose();
  vortexCore?.dispose();
  trails?.dispose();
  renderer.dispose();
});

// LineMaterial.resolution 跟随视口
renderer.onResize = (w, h) => trails?.setResolution(w, h);

regenerate();
requestAnimationFrame(tick);
