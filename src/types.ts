export type PresetName = 'hero' | 'spiral' | 'collision' | 'chaos';
export type EngineName = 'galaxy' | 'vortex';

/** Vortex Energy 参数（旋涡能量球） */
export interface VortexParams {
  /** 球体半径 */
  radius: number;
  /** 旋转强度（基础角速度；实际角速度 ∝ 1/(r+ε)^0.8，越近中心越快） */
  swirl: number;
  /** 向心压缩强度：Flow 粒子持续向球心流动的速度倍率 */
  compression: number;
  /** 多轴程度（0=全部共轴，1=15 个轨道族完全分轴，局部旋向不规则交错） */
  axisMix: number;
  /** 湍流扰动强度（Curl Noise，只占整体速度 5%~12%） */
  turbulence: number;
  /** 球形约束力 */
  confinement: number;
  /** 阻尼 */
  drag: number;
  /** 轨迹持续时间（秒），独立于物理速度 */
  trailPersistence: number;
  /** 播放速度 */
  timeScale: number;
  /** 蓝色饱和度（流线/粒子色相饱和度倍率，实时生效） */
  blueSaturation: number;
  /** 核心白半径（相对球半径 R，只有该范围内允许接近白色，实时生效） */
  coreWhiteRadius: number;
  /** 流线亮度倍率（只控制明暗，不改变色相，实时生效） */
  trailBrightness: number;
  /** Bloom 泛光强度（实时生效） */
  bloomStrength: number;
  /** 核心旋转强度：旋转径向衰减指数 α = 0.5·(0.5+0.5·coreSpin)，越大核心旋转主导性越强（实时生效） */
  coreSpin: number;
  /** 旋转传播延迟（秒）：t_eff = t − propagationDelay·(r/R)，中心先转、外层后跟（实时生效）。
   * V6 起仅作内部保留（Formation 由体积 Shader 的径向显现遮罩负责），默认 0 */
  propagationDelay: number;
  /** 主轨迹数量（180~260，重建流线层生效）。
   * V6 起由 ribbonAmount 取代（辅助能量丝 24~48 条），仅作内部保留 */
  trailDensity: number;
  /** 主轨迹宽度 px（1~3，实时生效） */
  trailWidth: number;
  /** 亮纹沿轨迹滚动速度（0~3，实时生效） */
  flowScrollSpeed: number;
  // ---- V6 Chakra Volume ----
  /** 形成动画时长（模拟秒）：核心先亮 → 能量体径向扩张到外缘 */
  formationDuration: number;
  /** 体积纹理外层旋转速度（rad/s），内层由 coreSpin 决定且必须更快 */
  outerSpin: number;
  /** 体积密度倍率（Raymarch 能量体浓度） */
  volumeDensity: number;
  /** 辅助能量丝数量（24~48，重建流线层生效） */
  ribbonAmount: number;
  particleCount: number;
  seed: number;
}

export const DEFAULT_VORTEX: Omit<VortexParams, 'particleCount' | 'seed'> = {
  radius: 24,
  swirl: 0.85,
  compression: 0.7,
  axisMix: 0.62,
  turbulence: 0.1,
  confinement: 1.1,
  drag: 0.1,
  trailPersistence: 1.5,
  timeScale: 0.22,
  blueSaturation: 1.4,
  coreWhiteRadius: 0.1,
  trailBrightness: 0.7,
  bloomStrength: 0.38,
  coreSpin: 1.2,
  propagationDelay: 0,
  trailDensity: 36,
  trailWidth: 0.9,
  flowScrollSpeed: 0.8,
  formationDuration: 2.5,
  outerSpin: 0.35,
  volumeDensity: 1.1,
  ribbonAmount: 36,
};

/** 用户可调参数（面板可见） */
export interface SimParams {
  preset: PresetName;
  /** 引力常数 G 的倍率 */
  gravity: number;
  /** 初始切向速度系数（角动量） */
  rotation: number;
  /** 速度扰动 + 引力核心初始位置偏移幅度 */
  chaos: number;
  /** 播放速度倍率（0 = 静止，1 = 实时），不影响物理步长 */
  timeScale: number;
  particleCount: number;
  seed: number;
  bloom: boolean;
  showHud: boolean;
  paused: boolean;
}

/** 预设中单个引力核心（及其粒子盘）的定义 */
export interface CoreSpec {
  mass: number;
  position: [number, number, number];
  velocity: [number, number, number];
  /** 该核心盘分到的粒子比例（全部核心的 diskFraction 之和应为 1） */
  diskFraction: number;
  /** 粒子盘特征半径（指数盘 scale length） */
  diskRadius: number;
  /** 盘最大半径 */
  diskMaxRadius: number;
  /** 盘面倾斜：绕 X 轴旋转角度（弧度），让各盘不共面 */
  tiltX: number;
  /** 盘面倾斜：绕 Z 轴旋转角度（弧度） */
  tiltZ: number;
}

export interface PresetSpec {
  label: string;
  cores: CoreSpec[];
  /** 推荐相机距离 */
  cameraDistance: number;
}

export const PRESET_ORDER: PresetName[] = ['hero', 'spiral', 'collision', 'chaos'];

/** 各预设的推荐面板参数（切换预设时套用） */
export const PRESET_RECOMMENDED: Record<
  PresetName,
  { gravity: number; rotation: number; chaos: number; timeScale: number }
> = {
  hero: { gravity: 0.85, rotation: 0.98, chaos: 0.12, timeScale: 0.18 },
  spiral: { gravity: 1.0, rotation: 1.0, chaos: 0.35, timeScale: 1.0 },
  collision: { gravity: 1.0, rotation: 1.0, chaos: 0.35, timeScale: 1.0 },
  chaos: { gravity: 1.0, rotation: 1.0, chaos: 0.35, timeScale: 1.0 },
};
