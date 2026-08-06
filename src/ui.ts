import GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import type { SimParams, VortexParams, PresetName, EngineName } from './types';
import { PRESET_ORDER, PRESET_RECOMMENDED } from './types';

export interface UiCallbacks {
  /** 参数变化，需要重建模拟 */
  onRegenerate(): void;
  onPauseToggle(paused: boolean): void;
  onBloomToggle(enabled: boolean): void;
  onHudToggle(show: boolean): void;
  /** 引擎切换（银河 / 旋涡能量球） */
  onEngineChange(engine: EngineName): void;
  /** 流线长度实时调整（无需重建） */
  onTrailChange(v: number): void;
  /** 流线宽度实时调整（无需重建） */
  onTrailWidthChange(v: number): void;
  /** 形成时长实时调整（无需重建，写回模拟内部参数） */
  onFormationChange(v: number): void;
  /** 颜色系统实时调整：蓝色饱和度/流线亮度/核心白半径/泛光强度（无需重建） */
  onColorLive(): void;
  /** Randomize：换一个新 seed 并重建 */
  onRandomize(): number;
}

/** 预设下拉显示名（中文 + 英文原名） */
const PRESET_LABELS: Record<PresetName, string> = {
  hero: '主银河 Hero Galaxy',
  spiral: '旋涡星系 Spiral',
  collision: '星系碰撞 Collision',
  chaos: '三体混沌 Chaos',
};

const ENGINE_LABELS: Record<EngineName, string> = {
  galaxy: '银河 Galaxy',
  vortex: '旋涡能量球 Vortex Energy',
};

/** 每个参数的帮助说明（? 图标弹出内容） */
const HELP = {
  engine:
    '选择模拟引擎。\n\n银河 Galaxy：N-body 引力模拟，含主银河 / 旋涡星系 / 星系碰撞 / 三体混沌四个场景（Art Preview 静态预览，URL 加 ?mode=sim 可恢复动画）。\n\n旋涡能量球 Vortex Energy：向心压缩 + 不规则旋涡驱动的三维查克拉能量球（螺旋丸式效果原型）——能量从不同方向流向中心、越近中心旋转越快。\n\n切换引擎会刷新页面并套用该引擎的默认参数。',
  preset:
    '选择模拟场景。\n\n主银河：艺术引导分布的银河（核球+双旋臂+星盘+星晕），第一眼即有星河结构。\n\n旋涡星系：单核心指数盘，验证基础轨道。\n\n星系碰撞：两个星系相向掠过、拉伸、交错。\n\n三体混沌：三个核心混沌互绕，粒子被撕裂甩出。\n\n切换会套用该场景的推荐参数并重建。',
  gravity:
    '引力常数 G 的倍率（0.2~3）。\n\n调大：轨道速度变快，结构更紧凑，核心更容易捕获粒子。\n调小：轨道松散，更多粒子漂移甩出。\n\n同时影响初始速度 v=√(GM/r) 与持续引力。',
  rotation:
    '初始角动量系数（0~1.6），乘在切向圆轨道速度 v=√(GM/r) 上。\n\n1.0 = 标准圆轨道；\n0 = 无切向速度，粒子直接坍缩向核心；\n>1 = 超速，盘更膨胀，甩出增多。\n\n只影响初始速度，不影响播放速度（见时间流速）。',
  chaos:
    '混沌扰动强度（0~1），同时控制两件事：\n\n1. 每个粒子初速度的随机扰动——越大轨道越偏心，入轨/坍缩/甩出分化越明显；\n2. 引力核心的初始位置与速度偏移（仅多核心场景生效）。',
  timeScale:
    '播放速度倍率（0~1），独立于「旋转」。\n\n0 = 物理完全静止（镜头仍可动）；\n0.18 = 默认值，缓慢演化的星河；\n1 = 实时物理速度。\n\n只缩放时间流，不改变物理步长，模拟稳定性与可复现性不受影响。实时生效，无需重建。',
  particleCount:
    '示踪粒子数量（2k~80k）。\n\n桌面默认 40000，移动端默认 12000。\n数量只影响视觉密度，不影响单个粒子的运动规律（粒子之间不互算引力）。修改后自动重建。',
  seed:
    '随机种子（1~99999）。\n\n所有初始位置、速度、颜色、闪烁都由它决定：相同 seed + 相同参数 = 完全相同的宇宙。想换 layout 就改种子或点「随机生成」。',
  radius:
    '能量球半径（5~60）。\n\n调大：球体更大，粒子分布更稀疏，旋转周期更长；\n调小：更紧凑、更密集。\n\n相机距离与能量雾范围会随之自动调整。修改后重建。',
  swirl:
    '旋转强度（0~3），局部旋涡角速度的整体倍率。\n\n角速度 ∝ 1/(r+ε)^0.8：越靠近中心旋转越快（高旋转密度），不是整体匀速自转。\n\n调大：查克拉流旋转更快、更有力量感；\n调小：缓慢翻涌；\n0 = 只剩向心压缩与湍流。\n\n默认 0.85。注意：轨迹弧线长度由「轨迹持续」控制，不靠提高转速。修改后重建。',
  compression:
    '向心压缩强度（0~2），默认 0.7。\n\n所有 Flow 粒子持续向球心流动的速度倍率——这是「查克拉从不同方向流动、向中心凝聚压缩」的核心参数：\n\n调大：向心流更快，流线明显向核心俯冲汇聚；\n调小：流动缓慢舒展，螺旋更松；\n0 = 无向心流，退化为纯旋涡绕圈（旧版球壳感）。\n\n流入核心的粒子会确定性重生到外缘，维持持续压缩。修改后重建。',
  axisMix:
    '多轴混合（0~1）。\n\n能量球保留 15 个 Orbit Family，每族有独立的局部旋转轴——粒子在向心流动中被所属族的旋向偏折，形成不规则交错的螺旋流。\n\n0 = 所有族共用一条轴（退化为单轴螺旋）；\n1 = 15 族完全分轴，多向交错缠绕；\n默认 0.62：分轴为主、保留少量整体一致性。\n\n这是「不同方向都有查克拉流」的关键参数。修改后重建。',
  turbulence:
    '湍流扰动（0~2），默认 0.1。\n\nCurl Noise 无散度噪声只作为少量局部扰动（占整体速度 5%~12%），让流线出现自然的抖动与不规则感，不能主导运动。\n\n调大：流线更毛糙不羁；\n调小：流线更光滑规整。修改后重建。',
  confinement:
    '球形约束力（0~3）。\n\n粒子超出约 0.85R 后受到向内的柔性回复力，越大回拉越强、球体轮廓越清晰；\n过小：粒子逐渐逃逸，球体发散；\n过大：边缘反弹感明显，不自然。修改后重建。',
  drag:
    '阻尼系数（0~1），与速度成正比的减速力。\n\n调大：流动更快趋于平稳、能量感下降；\n调小：流动更自由持久。\n\n与湍流、约束力共同决定稳态下的运动烈度。修改后重建。',
  trailPersistence:
    '轨迹持续时间（0.2~3 模拟秒，默认 2.4）。\n\n100 条代表粒子的真实历史轨迹（头亮尾淡的长弧），该参数控制轨迹可见的时间长度：\n\n调大：弧线更长更完整，可环绕球体；\n调小：只剩头部短弧。\n\n与播放速度完全解耦——即使时间流速很低或暂停，长弧依然清晰。\n\n实时生效，无需重建。',
  formationDuration:
    '形成时长（1~20 模拟秒，默认 6）。\n\n能量球从核心向外生长的总时间：\n核心先出现并旋转 → 内层循环线 → 逐层向外扩张 → 外围气流最后登场。\n\n调大：生长过程更慢更有仪式感；\n调小：更快成型。\n\n实时生效，无需重建。',
  coreRadiusRatio:
    '初始核心大小（0.05~0.4，相对球半径，默认 0.15）。\n\n形成起点 activeRadius 的下限——t=0 时只有这个范围内的粒子与流线可见。\n\n调大：起始核更大；\n调小：从一个更小的点长出来。修改后重建。',
  trailWidth:
    '流线宽度基准（0.5~3 px，默认 1.3）。\n\n中层主线的线宽；内层高亮线 ×1.3，外层气流线 ×0.6。\n\n调大：能量流更粗更有力量感；\n调小：更纤细通透。\n\n实时生效，无需重建。',
  trailDensity:
    '流线密度（60~300 条，默认 140）。\n\n按 12% / 60% / 28% 分到 内层高亮 / 中层主线 / 外层气流 三层。\n\n调大：循环线更密集饱满；\n调小：更疏朗留白。修改后重建。',
  outerFlowStrength:
    '外围气流强度（0~2，默认 0.6）。\n\n形成后段（progress² 渐入），外层粒子被旋转带着向外鼓出的径向分量——\n「被甩出来」的气流感，球形约束兜底不会逃逸。\n\n调大：外围气流更张扬；\n0 = 无甩出，纯向心压缩。修改后重建。',
  blueSaturation:
    '蓝色饱和度（0~2.5，默认 1.4）。\n\n围绕亮度轴缩放流线与粒子的色相纯度：\n\n调大：蓝色更纯更艳（电光蓝更"电"）；\n调小：趋向灰蓝；\n0 = 灰度。\n\n只改色相纯度，不改明暗。有饱和度钳制兜底——任何值都不会漂出白色。实时生效，无需重建。',
  coreWhiteRadius:
    '核心白半径（0.04~0.2，相对球半径，默认 0.1）。\n\n白色只允许出现在独立的 Core Compression 核心层，该参数控制白色区域的大小：\n\n调大：白色核心更大更亮；\n调小：白色收缩成一点，球体几乎全蓝。\n\n核心之外会立刻过渡回高饱和蓝。流线与粒子不承担制造白色的职责。实时生效，无需重建。',
  trailBrightness:
    '流线亮度倍率（0.3~2，默认 1.0）。\n\n整体缩放轨迹流线的明暗，不改变色相：\n\n调大：流线更亮更有能量感；\n调小：流线变暗，核心与粒子相对突出。\n\n实时生效，无需重建。',
  bloomStrength:
    '泛光强度（0~1.2，默认 0.38）。\n\nBloom 后期效果的强度。阈值固定 0.75——只拾取最亮的流线头部与核心，保留蓝色色相，不会把高亮蓝漂成纯白。\n\n调大：光晕更宽更柔；\n调小：画面更锐利干净。实时生效，无需重建。',
  vTimeScale:
    '播放速度倍率（0~1）。\n\n0 = 物理完全静止（镜头仍可动）；\n0.22 = 默认值，缓慢压缩演化的能量球；\n1 = 实时物理速度。\n\n只缩放时间流，不改变物理步长。实时生效，无需重建。',
  vParticleCount:
    '粒子数量（2k~60k）。\n\n桌面默认 15000，移动端默认 8000。\n粒子只做辅助质感（主视觉是流线轨迹），数量只影响填充密度，不影响运动规律。修改后自动重建。',
  vSeed:
    '随机种子（1~99999）。\n\n15 个轨道族的轴方向/速度、初始分布、湍流噪声场、颜色抖动、回收重生顺序都由它决定：相同 seed + 相同参数 = 完全相同的能量球。修改后重建。',
  paused:
    '暂停/继续物理步进。\n\n暂停时粒子冻结，但镜头仍可旋转缩放，方便观察三维结构。',
  bloom:
    '泛光后期效果开关。\n\n开启时高亮恒星与核心有柔和光晕（普通星体不参与，避免大面积白球）。性能吃紧时可关闭。',
  showHud:
    '左上角调试信息开关：\n\n实时 FPS、粒子数量、已执行物理步数。',
  reset: '按当前参数重新生成整个模拟（物理时间归零）。',
  randomize: '随机换一个新 seed 并立即重建——快速浏览不同的宇宙布局。',
};

/**
 * lil-gui 控制面板（中文标签 + ? 帮助图标）+ HUD 调试层。
 * 顶部引擎切换；银河与旋涡参数分组在两个文件夹中，按当前引擎显隐。
 */
export class Ui {
  readonly gui: GUI;
  private params: SimParams;
  private tooltipEl: HTMLElement;

  private hudEl: HTMLElement;
  private hudFps: HTMLElement;
  private hudParticles: HTMLElement;
  private hudStep: HTMLElement;
  private hintEl: HTMLElement | null;

  constructor(
    params: SimParams,
    vortexParams: VortexParams,
    engine: EngineName,
    callbacks: UiCallbacks
  ) {
    this.params = params;

    this.hudEl = document.getElementById('hud')!;
    this.hudFps = document.getElementById('hud-fps')!;
    this.hudParticles = document.getElementById('hud-particles')!;
    this.hudStep = document.getElementById('hud-step')!;
    this.hintEl = document.getElementById('hint');

    // 共享的帮助气泡（单例，点击 ? 显示，点击别处关闭）
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.id = 'gui-tooltip';
    this.tooltipEl.className = 'hidden';
    document.body.appendChild(this.tooltipEl);
    document.addEventListener('pointerdown', (e) => {
      if (!this.tooltipEl.classList.contains('hidden') &&
          !this.tooltipEl.contains(e.target as Node)) {
        this.tooltipEl.classList.add('hidden');
      }
    });

    this.gui = new GUI({ title: 'N-body 宇宙生成器' });

    // ------------------------------------------------------------ 引擎切换
    const engineOptions: Record<string, EngineName> = {};
    for (const name of ['galaxy', 'vortex'] as EngineName[]) {
      engineOptions[ENGINE_LABELS[name]] = name;
    }
    const engineState = { engine };
    this.addHelp(
      this.gui
        .add(engineState, 'engine', engineOptions)
        .name('引擎')
        .onChange((v: EngineName) => callbacks.onEngineChange(v)),
      HELP.engine
    );

    // ------------------------------------------------------------ 银河参数
    const galaxyFolder = this.gui.addFolder('银河参数');
    galaxyFolder.domElement.style.display = engine === 'galaxy' ? '' : 'none';

    const presetOptions: Record<string, PresetName> = {};
    for (const name of PRESET_ORDER) {
      presetOptions[PRESET_LABELS[name]] = name;
    }

    this.addHelp(
      galaxyFolder
        .add(params, 'preset', presetOptions)
        .name('预设场景')
        .onChange((v: PresetName) => {
          // 切换预设时套用该预设的推荐参数
          const rec = PRESET_RECOMMENDED[v];
          params.gravity = rec.gravity;
          params.rotation = rec.rotation;
          params.chaos = rec.chaos;
          params.timeScale = rec.timeScale;
          this.refreshDisplay();
          callbacks.onRegenerate();
        }),
      HELP.preset
    );

    this.addHelp(
      galaxyFolder
        .add(params, 'gravity', 0.2, 3.0, 0.05)
        .name('引力强度')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.gravity
    );

    this.addHelp(
      galaxyFolder
        .add(params, 'rotation', 0.0, 1.6, 0.02)
        .name('旋转（角动量）')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.rotation
    );

    this.addHelp(
      galaxyFolder
        .add(params, 'chaos', 0.0, 1.0, 0.02)
        .name('混沌扰动')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.chaos
    );

    // Time Scale 实时生效，无需重建
    this.addHelp(
      galaxyFolder.add(params, 'timeScale', 0, 1, 0.01).name('时间流速'),
      HELP.timeScale
    );

    this.addHelp(
      galaxyFolder
        .add(params, 'particleCount', 2000, 80000, 1000)
        .name('粒子数量')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.particleCount
    );

    this.addHelp(
      galaxyFolder
        .add(params, 'seed', 1, 99999, 1)
        .name('随机种子')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.seed
    );

    // ------------------------------------------------------------ 旋涡参数
    const vortexFolder = this.gui.addFolder('旋涡参数');
    vortexFolder.domElement.style.display = engine === 'vortex' ? '' : 'none';

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'radius', 5, 60, 1)
        .name('球体半径')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.radius
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'swirl', 0, 3, 0.05)
        .name('旋转强度')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.swirl
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'compression', 0, 2, 0.05)
        .name('压缩强度')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.compression
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'axisMix', 0, 1, 0.02)
        .name('多轴混合')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.axisMix
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'turbulence', 0, 2, 0.05)
        .name('湍流强度')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.turbulence
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'confinement', 0, 3, 0.05)
        .name('球形约束')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.confinement
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'drag', 0, 1, 0.01)
        .name('阻尼')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.drag
    );

    // 轨迹持续 / 时间流速：实时生效，无需重建
    this.addHelp(
      vortexFolder
        .add(vortexParams, 'trailPersistence', 0.2, 3.0, 0.05)
        .name('轨迹持续')
        .onChange((v: number) => callbacks.onTrailChange(v)),
      HELP.trailPersistence
    );

    // ---- V7 形成与流线系统 ----
    this.addHelp(
      vortexFolder
        .add(vortexParams, 'formationDuration', 1, 20, 0.5)
        .name('形成时长')
        .onChange((v: number) => callbacks.onFormationChange(v)),
      HELP.formationDuration
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'coreRadiusRatio', 0.05, 0.4, 0.01)
        .name('初始核心大小')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.coreRadiusRatio
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'trailWidth', 0.5, 3, 0.05)
        .name('流线宽度')
        .onChange((v: number) => callbacks.onTrailWidthChange(v)),
      HELP.trailWidth
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'trailDensity', 60, 300, 5)
        .name('流线密度')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.trailDensity
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'outerFlowStrength', 0, 2, 0.05)
        .name('外围气流强度')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.outerFlowStrength
    );

    // ---- 颜色系统（实时生效，无需重建）----
    this.addHelp(
      vortexFolder
        .add(vortexParams, 'blueSaturation', 0, 2.5, 0.05)
        .name('蓝色饱和度')
        .onChange(() => callbacks.onColorLive()),
      HELP.blueSaturation
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'trailBrightness', 0.3, 2, 0.05)
        .name('流线亮度')
        .onChange(() => callbacks.onColorLive()),
      HELP.trailBrightness
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'coreWhiteRadius', 0.04, 0.2, 0.005)
        .name('核心白半径')
        .onChange(() => callbacks.onColorLive()),
      HELP.coreWhiteRadius
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'bloomStrength', 0, 1.2, 0.02)
        .name('泛光强度')
        .onChange(() => callbacks.onColorLive()),
      HELP.bloomStrength
    );

    this.addHelp(
      vortexFolder.add(vortexParams, 'timeScale', 0, 1, 0.01).name('时间流速'),
      HELP.vTimeScale
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'particleCount', 2000, 60000, 1000)
        .name('粒子数量')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.vParticleCount
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'seed', 1, 99999, 1)
        .name('随机种子')
        .onFinishChange(() => callbacks.onRegenerate()),
      HELP.vSeed
    );

    // ------------------------------------------------------------ 通用控制
    this.addHelp(
      this.gui
        .add(params, 'paused')
        .name('暂停 / 继续')
        .onChange((v: boolean) => callbacks.onPauseToggle(v)),
      HELP.paused
    );

    this.addHelp(
      this.gui
        .add(params, 'bloom')
        .name('泛光')
        .onChange((v: boolean) => callbacks.onBloomToggle(v)),
      HELP.bloom
    );

    this.addHelp(
      this.gui
        .add(params, 'showHud')
        .name('调试信息')
        .onChange((v: boolean) => callbacks.onHudToggle(v)),
      HELP.showHud
    );

    const actions = {
      重置: () => callbacks.onRegenerate(),
      随机生成: () => {
        callbacks.onRandomize();
        this.refreshDisplay();
      },
    };
    this.addHelp(this.gui.add(actions, '重置'), HELP.reset);
    this.addHelp(this.gui.add(actions, '随机生成'), HELP.randomize);

    this.setHudVisible(params.showHud);

    // 首次交互后淡出操作提示
    const fade = () => {
      this.hintEl?.classList.add('faded');
      window.removeEventListener('pointerdown', fade);
      window.removeEventListener('wheel', fade);
    };
    window.addEventListener('pointerdown', fade);
    window.addEventListener('wheel', fade);
  }

  /** 在控制器名称右侧追加 ? 帮助图标，点击弹出说明气泡 */
  private addHelp<T extends Controller>(controller: T, text: string): T {
    const nameEl = controller.domElement.querySelector('.name');
    if (!nameEl) return controller;
    const icon = document.createElement('span');
    icon.className = 'help-icon';
    icon.textContent = '?';
    icon.addEventListener('pointerdown', (e) => e.stopPropagation());
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTooltip(icon, text);
    });
    nameEl.appendChild(icon);
    return controller;
  }

  private toggleTooltip(anchor: HTMLElement, text: string): void {
    const tip = this.tooltipEl;
    const isSame = tip.dataset.for === text && !tip.classList.contains('hidden');
    if (isSame) {
      tip.classList.add('hidden');
      return;
    }
    tip.dataset.for = text;
    tip.textContent = text;
    tip.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    // 面板在右侧，气泡显示在图标左侧；底部防溢出
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left - tipRect.width - 12;
    if (left < 8) left = rect.right + 12; // 空间不足时放右侧
    let top = rect.top - 6;
    if (top + tipRect.height > window.innerHeight - 8) {
      top = window.innerHeight - tipRect.height - 8;
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  /** 程序化改参后同步所有控制器显示 */
  private refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  setHudVisible(show: boolean): void {
    this.hudEl.classList.toggle('hidden', !show);
  }

  updateHud(fps: number, particles: number, steps: number): void {
    if (!this.params.showHud) return;
    this.hudFps.textContent = `${fps.toFixed(0)} fps`;
    this.hudParticles.textContent = `${particles.toLocaleString()} 粒子`;
    this.hudStep.textContent = `${steps.toLocaleString()} 步`;
  }

  dispose(): void {
    this.tooltipEl.remove();
    this.gui.destroy();
  }
}
