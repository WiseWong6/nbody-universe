/**
 * 统一的粒子模拟接口：渲染层（particles.ts）只依赖这些数组，
 * 不关心背后是 N-body 引力还是 Vortex 力场。
 */
export interface ParticleSimulation {
  /** 粒子数量 */
  readonly count: number;
  /** 位置 xyz（渲染层直接引用，就地更新） */
  readonly position: Float32Array;
  /** 速度 xyz（流线拉伸用） */
  readonly velocity: Float32Array;
  /** 速率标量 */
  readonly speed: Float32Array;
  /** 基础颜色 rgb（init 时写入） */
  readonly color: Float32Array;
  /** 每粒子基准像素尺寸 */
  readonly starSize: Float32Array;
  /** 闪烁参数 [amp, phase] */
  readonly twinkle: Float32Array;
  /** 高亮层分界：索引 >= brightStart 的粒子走高亮渲染层 */
  readonly brightStart: number;
  /** 模拟时间（秒） */
  readonly time: number;
  /** 已执行物理步数 */
  readonly stepCount: number;
  /** 可选：每粒子所属轨道族（Vortex 流线按族取稳定基础色） */
  readonly particleFamily?: Uint8Array;
  /** 可选：每族稳定基础色 rgb（FAMILIES×3） */
  readonly famColors?: Float32Array;
  /** 可选：每粒子激活半径（相对球半径，Vortex 形成生长用） */
  readonly birthRadius?: Float32Array;
  /** 可选：当前激活半径（相对球半径，随形成进度从核心向外扩张） */
  readonly activeRn?: number;
  /** 可选：形成进度 0~1（核心淡入 / 雾层延后用） */
  readonly formationProgress?: number;

  /** 按当前参数（重新）生成初始状态 */
  init(): void;
  /**
   * 推进模拟。frameDt 为渲染帧间隔（秒，已乘 Time Scale），
   * 实现内部用固定步长 accumulator 切分，保证确定性。
   */
  update(frameDt: number): void;
  /** 回到初始状态（同 seed 同参数结果一致） */
  reset(): void;
  /** 释放内部资源（TypedArray 由 GC 回收，主要供语义对称） */
  dispose(): void;
  /** 刷新速率标量缓存（渲染帧调用） */
  syncSpeed(): void;
}
