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
  /** 颜色系统实时调整：蓝色饱和度/流线亮度/核心白半径/泛光强度（无需重建） */
  onColorLive(): void;
  /** 轨迹密度变化：只重建流线层（无需重建模拟） */
  onTrailRebuild(): void;
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
    '选择模拟引擎。\n\n银河 Galaxy：N-body 引力模拟，含主银河 / 旋涡星系 / 星系碰撞 / 三体混沌四个场景（Art Preview 静态预览，URL 加 ?mode=sim 可恢复动画）。\n\n旋涡能量球 Vortex Energy：V6 Chakra Volume——球体 Raymarch 体积 Shader 的连续蓝白查克拉能量体（螺旋丸式效果原型）：核心先形成并旋转、能量体再向外扩张，稳态下外层能量持续向内压缩、越近中心旋转越快；少量平滑能量丝与边缘碎光只作辅助。\n\n切换引擎会刷新页面并套用该引擎的默认参数。',
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
  compression:
    '向心压缩强度（0~2），默认 0.7。\n\n所有 Flow 粒子持续向球心流动的速度倍率——这是「查克拉从不同方向流动、向中心凝聚压缩」的核心参数：\n\n调大：向心流更快，能量明显向核心汇聚；\n调小：流动缓慢舒展，螺旋更松；\n0 = 无向心流，退化为纯旋涡绕圈。\n\n流入核心的粒子会确定性重生到外缘，维持持续压缩。实时生效，无需重建。',
  turbulence:
    '湍流扰动（0~2），默认 0.1。\n\n同时作用于两处：\n1. 粒子的 Curl Noise 局部扰动（占整体速度 5%~12%）；\n2. 体积纹理的 domain warping 幅度——让能量体出现不规则卷动而非均匀条纹。\n\n调大：能量体更毛糙不羁；\n调小：更光滑规整。实时生效，无需重建。',
  formationDuration:
    '形成时长（0.5~6 模拟秒，默认 2.5）。\n\n螺旋丸的形成动画（Formation）节奏，由体积 Shader 的径向显现遮罩驱动：\n\n0~20%：中心先出现并开始旋转；\n20%~100%：能量体从中心逐步扩张到外缘；\n之后进入稳定状态（外层能量持续向内压缩、核心高速旋转）。\n\n调小：快速成形；调大：缓慢凝聚。\n\n只影响视觉显现，不再用延迟拖慢粒子启动。实时生效，无需重建。',
  outerSpin:
    '外层旋转速度（0~2 rad/s，默认 0.35）。\n\n体积纹理在外缘的角速度。内层角速度由「核心旋转」决定且始终更快：\n\nomega(r) = mix(核心旋转, 外层旋转, (r/R)^0.7)\n\n两个不同轴向/速度的旋转域叠加，形成不规则但统一围绕核心的旋涡——没有经纬线，没有原子轨道。\n\n实时生效，无需重建。',
  volumeDensity:
    '体积密度（0~2.5，默认 1.1）。\n\nRaymarch 能量体的浓度倍率：\n\n调大：能量体更实更亮，中心更饱满；\n调小：更通透稀薄，暗缝更明显；\n0 = 只剩辅助能量丝与核心。\n\n实时生效，无需重建。',
  ribbonAmount:
    '能量丝数量（0~64 条，默认 36）。\n\n辅助层：少量短弧能量丝（Catmull-Rom 平滑细线，透明度低于体积主体），只为体积能量补充局部高光丝，不能勾勒完整球壳。\n\n0 = 纯体积能量体。修改后只重建能量丝层，模拟不重置。',
  coreSpin:
    '核心旋转强度（0~3，默认 1.2）。\n\n同时驱动两件事：\n1. 体积纹理内层角速度——omega(r) = mix(核心旋转, 外层旋转, (r/R)^0.7)，核心快、外围慢；\n2. 粒子旋转径向变陡指数 α = 0.5·(0.5+0.5·coreSpin)。\n\n调大：核心旋涡主导性更强（中心高密度快旋，外缘缓慢）；\n调小：各层旋转速度趋于平均。\n\n实时生效，无需重建。',
  bloomStrength:
    '泛光强度（0~1.2，默认 0.38）。\n\nBloom 后期效果的强度。阈值固定 0.75——只拾取最亮的流线头部与核心，保留蓝色色相，不会把高亮蓝漂成纯白。\n\n调大：光晕更宽更柔；\n调小：画面更锐利干净。实时生效，无需重建。',
  vTimeScale:
    '播放速度倍率（0~1）。\n\n0 = 物理完全静止（镜头仍可动）；\n0.22 = 默认值，缓慢压缩演化的能量球；\n1 = 实时物理速度。\n\n只缩放时间流，不改变物理步长。实时生效，无需重建。',
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
    // V6 Chakra Volume：只保留体积/形成/辅助丝相关 8 个参数 + 时间流速，
    // V5 只服务于历史轨迹的参数（Propagation Delay / Trail Density /
    // Trail Persistence 等）已从面板移除
    const vortexFolder = this.gui.addFolder('旋涡参数');
    vortexFolder.domElement.style.display = engine === 'vortex' ? '' : 'none';

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'formationDuration', 0.5, 6, 0.1)
        .name('形成时长')
        .onChange(() => callbacks.onColorLive()),
      HELP.formationDuration
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'coreSpin', 0, 3, 0.05)
        .name('核心旋转')
        .onChange(() => callbacks.onColorLive()),
      HELP.coreSpin
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'outerSpin', 0, 2, 0.05)
        .name('外层旋转')
        .onChange(() => callbacks.onColorLive()),
      HELP.outerSpin
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'compression', 0, 2, 0.05)
        .name('压缩强度')
        .onChange(() => callbacks.onColorLive()),
      HELP.compression
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'volumeDensity', 0, 2.5, 0.05)
        .name('体积密度')
        .onChange(() => callbacks.onColorLive()),
      HELP.volumeDensity
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'turbulence', 0, 2, 0.05)
        .name('湍流强度')
        .onChange(() => callbacks.onColorLive()),
      HELP.turbulence
    );

    this.addHelp(
      vortexFolder
        .add(vortexParams, 'ribbonAmount', 0, 64, 4)
        .name('能量丝数量')
        .onFinishChange(() => callbacks.onTrailRebuild()),
      HELP.ribbonAmount
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
