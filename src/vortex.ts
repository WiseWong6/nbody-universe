import { createRng, createNoise3D, type Rng } from './rng';
import type { VortexParams } from './types';
import type { ParticleSimulation } from './simulation-interface';

/**
 * VortexFieldSimulation —— 三维旋涡能量球（Visual V3：向心压缩查克拉流模型）。
 *
 * 不再是球壳轨道绕圈：Flow 粒子持续向球心流动，流动过程中被所属
 * Orbit Family 的局部旋转轴偏折，形成不规则交错、越近中心越快的螺旋流。
 *
 * 每步目标速度：
 *   target = inwardCompression + irregularSwirl + spiralInflow + turbulence
 *   inwardCompression = -normalize(p) · compression · 0.08R · smoothstep(0.10, 0.45, r/R)
 *   irregularSwirl    = tangent · swirl · 11 · ((R+ε)/(r+ε))^α · famSpeedMul[g]
 *                       α = 0.5·(0.5+0.5·coreSpin)，ε=0.12R：越靠近核心旋转越快
 *   spiralInflow      = -r̂_in · |vTan| · 0.12（轨道面内向内分量，把大圆轨道扭成
 *                       卷入核心的螺旋；切向:径向 ≈ 3.5:1，长弧包裹而非直落）
 *   turbulence        = curlNoise · turbulence · 4   （只占 5%~12% 局部扰动）
 *   accel             = FOLLOW·(target − v) − drag·v
 *
 * 核心驱动的 Formation 动画（中心先形成、能量体再向外扩张）由
 * ChakraVolume Shader 的径向显现遮罩负责（V6），粒子全程处于稳态流。
 *
 * 15 个 Orbit Family 只提供「局部旋向」（seed 确定的独立旋转轴 + 极慢进动），
 * 不再把粒子绑在固定轨道半径上。流入核心（r < 0.085R）的 Flow 粒子
 * 由 seed 确定性重生到外缘，维持持续压缩流，不坍缩不逃逸。
 *
 * 粒子/流线颜色由所属 Orbit Family 的稳定基础色决定（深蓝/电光蓝/亮蓝/少量青蓝），
 * 半径只控亮度不改色相；白色只属于独立核心层。
 * 固定步长半隐式 Euler，mulberry32(seed) 全程确定。
 */

/** 固定物理步长（秒） */
const DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 8;
/** 速度场跟随强度（内部常量） */
const FOLLOW = 2.5;
/** Curl Noise 网格分辨率（每边格子数） */
const CURL_GRID = 24;
/** Orbit Family 数量（12~18 中取 15） */
const FAMILIES = 15;
/** 湍流扰动基准（相对主旋涡速度的比例系数） */
const TURB_BASE = 4.0;
/** 向心压缩速度基准（乘以 compression 与球半径）。
 * 取值保证切向速度明显大于径向（约 3.5:1）——粒子是「绕核心卷入的长弧螺旋」，
 * 而不是直落核心的放射线 */
const COMPRESS_BASE = 0.08;
/** 角速度径向衰减指数（越近中心越快；0.5 温和加速，内层不缠成毛线球） */
const SWIRL_ALPHA = 0.5;
/** Flow 粒子流入该半径后回收重生到外缘 */
const RECYCLE_RN = 0.12;
/** 螺旋拓扑：轨道面内向内径向分量与切向速度的比值（大圆轨道 → 卷入核心的螺旋）。
 * 与 COMPRESS_BASE 共同决定螺距：过大会变成放射状直落，过小则退回球面绕圈 */
const SPIRAL_PITCH = 0.12;

export class VortexFieldSimulation implements ParticleSimulation {
  readonly params: VortexParams;

  count = 0;
  position = new Float32Array(0);
  velocity = new Float32Array(0);
  speed = new Float32Array(0);
  color = new Float32Array(0);
  starSize = new Float32Array(0);
  twinkle = new Float32Array(0);
  brightStart = 0;

  time = 0;
  stepCount = 0;

  private rng: Rng = createRng(1);
  private accumulator = 0;

  // ---- Orbit Family 状态 ----
  /** 每族旋转轴（单位向量，含进动），FAMILIES×3 */
  private famAxis = new Float32Array(FAMILIES * 3);
  /** 进动：每族围绕的次轴与角速度 */
  private precessAxis = new Float32Array(FAMILIES * 3);
  private precessRate = new Float32Array(FAMILIES);
  /** 每族目标半径（世界单位） */
  private famRadius = new Float32Array(FAMILIES);
  /** 每族角速度倍率（含方向 ±） */
  private famSpeedMul = new Float32Array(FAMILIES);
  /** 每族轨道宽度（世界单位） */
  private famWidth = new Float32Array(FAMILIES);
  /** 每族轨道面基向量 u,v（随轴进动一起更新），各 FAMILIES×3 */
  private famU = new Float32Array(FAMILIES * 3);
  private famV = new Float32Array(FAMILIES * 3);
  /** 共享轴（axisMix=0 时所有族退化为同一轴） */
  private sharedAxis = new Float32Array(3);
  /** 每粒子所属族（0~FAMILIES-1；非 flow 粒子也有，用于着色一致性） */
  private family = new Uint8Array(0);
  /** 渲染层读取：每粒子所属族（流线按族取稳定基础色）。
   *  用 getter：buildParticles 会重建 this.family 数组 */
  get particleFamily(): Uint8Array {
    return this.family;
  }
  /** 每族稳定基础色 rgb（FAMILIES×3，init 时按配色比例 seed 分配，运动过程不变） */
  famColors = new Float32Array(FAMILIES * 3);
  /** 每粒子分组：0=Flow（压缩流+回收）1=Core 2=Spark */
  private group = new Uint8Array(0);
  /** 每粒子固定亮度抖动（动态按半径上色时避免闪烁） */
  private colorJit = new Float32Array(0);
  /** 轴进动累积角 */
  private precessAngle = 0;

  // Curl Noise 网格（每格 3 分量，无散度湍流场）
  private curlGrid = new Float32Array(0);
  private curlExtent = 1; // 网格覆盖半径（世界单位）

  constructor(params: VortexParams) {
    this.params = { ...params };
    this.init();
  }

  init(): void {
    this.rng = createRng(this.params.seed);
    this.accumulator = 0;
    this.stepCount = 0;
    this.time = 0;
    this.precessAngle = 0;
    this.buildFamilies();
    this.buildCurlGrid();
    this.buildParticles();
  }

  reset(): void {
    this.init();
  }

  dispose(): void {
    // TypedArray 由 GC 回收
  }

  // ---------------------------------------------------------------- 构建

  /** 15 个轨道族：斐波那契球面均布轴 + seed 扰动；半径/速度/宽度/相位分层 */
  private buildFamilies(): void {
    const rng = this.rng;
    const R = this.params.radius;
    const golden = Math.PI * (3 - Math.sqrt(5));

    // 共享轴（axisMix=0 的退化方向）：seed 决定
    {
      const t = rng.next() * Math.PI * 2;
      const z = rng.next() * 2 - 1;
      const s = Math.sqrt(1 - z * z);
      this.sharedAxis[0] = s * Math.cos(t);
      this.sharedAxis[1] = z;
      this.sharedAxis[2] = s * Math.sin(t);
    }

    for (let g = 0; g < FAMILIES; g++) {
      // 斐波那契球面均匀方向
      const z = 1 - (2 * (g + 0.5)) / FAMILIES;
      const theta = golden * g;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      let x = s * Math.cos(theta);
      let y = z;
      let zz = s * Math.sin(theta);
      // seed 小扰动（±0.15），保持均布大致结构
      x += (rng.next() * 2 - 1) * 0.15;
      y += (rng.next() * 2 - 1) * 0.15;
      zz += (rng.next() * 2 - 1) * 0.15;
      const inv = 1 / Math.hypot(x, y, zz);
      x *= inv;
      y *= inv;
      zz *= inv;
      this.famAxis[g * 3] = x;
      this.famAxis[g * 3 + 1] = y;
      this.famAxis[g * 3 + 2] = zz;

      // 目标半径：0.30R~0.92R 按族均匀 + 扰动
      this.famRadius[g] =
        R * (0.3 + (0.62 * (g + 0.5)) / FAMILIES + (rng.next() * 2 - 1) * 0.04);
      // 角速度倍率：0.75~1.25，约 1/3 族反向
      const dir = rng.next() < 0.34 ? -1 : 1;
      this.famSpeedMul[g] = dir * (0.75 + rng.next() * 0.5);
      // 轨道宽度：0.06R~0.14R
      this.famWidth[g] = R * (0.06 + rng.next() * 0.08);

      // 进动次轴：与主轴不平行的 seeded 方向；角速度极慢
      let px = rng.next() * 2 - 1;
      let py = rng.next() * 2 - 1;
      let pz = rng.next() * 2 - 1;
      const pinv = 1 / Math.max(Math.hypot(px, py, pz), 1e-6);
      this.precessAxis[g * 3] = px * pinv;
      this.precessAxis[g * 3 + 1] = py * pinv;
      this.precessAxis[g * 3 + 2] = pz * pinv;
      this.precessRate[g] = 0.008 + rng.next() * 0.012;

      // 轨道面基向量 u,v
      this.buildBasis(g);
    }

    // ---- 每族稳定基础色（配色比例：~53% 深蓝/电光蓝，40% 主体亮蓝，7% 青蓝）----
    // 色相只由族决定，运动过程中不随半径变化；半径只控制明暗（见 applyColor）。
    // 白色不允许出现在族色中——白色只属于独立的 Core Compression 核心层。
    {
      const PALETTE: [number, number, number][] = [
        [0.027, 0.361, 1.0], // #075CFF 深蓝
        [0.039, 0.404, 1.0], // #0A67FF 电光蓝
        [0.231, 0.722, 1.0], // #3BB8FF 主体亮蓝
        [0.455, 0.898, 1.0], // #74E5FF 青蓝（少量）
      ];
      // 15 族的固定色票配额：深蓝×4 + 电光蓝×4 + 主体蓝×6 + 青蓝×1
      const tickets = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3];
      for (let i = tickets.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        const tmp = tickets[i];
        tickets[i] = tickets[j];
        tickets[j] = tmp;
      }
      for (let g = 0; g < FAMILIES; g++) {
        const c = PALETTE[tickets[g]];
        this.famColors[g * 3] = c[0];
        this.famColors[g * 3 + 1] = c[1];
        this.famColors[g * 3 + 2] = c[2];
      }
    }
  }

  /** 由 famAxis[g] 构建正交基 u,v（进动后重算） */
  private buildBasis(g: number): void {
    const ax = this.famAxis[g * 3];
    const ay = this.famAxis[g * 3 + 1];
    const az = this.famAxis[g * 3 + 2];
    // 取一个不平行参考向量
    let rx = 1;
    let ry = 0;
    let rz = 0;
    if (Math.abs(ax) > 0.9) {
      rx = 0;
      ry = 1;
    }
    // u = normalize(axis × ref)
    let ux = ay * rz - az * ry;
    let uy = az * rx - ax * rz;
    let uz = ax * ry - ay * rx;
    const uinv = 1 / Math.max(Math.hypot(ux, uy, uz), 1e-6);
    ux *= uinv;
    uy *= uinv;
    uz *= uinv;
    // v = axis × u
    const vx = ay * uz - az * uy;
    const vy = az * ux - ax * uz;
    const vz = ax * uy - ay * ux;
    this.famU[g * 3] = ux;
    this.famU[g * 3 + 1] = uy;
    this.famU[g * 3 + 2] = uz;
    this.famV[g * 3] = vx;
    this.famV[g * 3 + 1] = vy;
    this.famV[g * 3 + 2] = vz;
  }

  /** 预计算无散度湍流场：向量势 A 的 curl，采到网格，粒子处三线性插值 */
  private buildCurlGrid(): void {
    const R = this.params.radius;
    const n = CURL_GRID;
    this.curlExtent = R * 1.25;
    this.curlGrid = new Float32Array(n * n * n * 3);

    // 三个互相偏移的标量噪声场构成向量势
    const n1 = createNoise3D(this.params.seed);
    const n2 = createNoise3D((this.params.seed ^ 0x51ab3) >>> 0);
    const n3 = createNoise3D((this.params.seed ^ 0x9e377) >>> 0);
    const e = R * 0.08; // 差分步长
    const scale = 2.2 / R; // 低频：整球约 2~3 个涡

    let idx = 0;
    for (let iz = 0; iz < n; iz++) {
      for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
          const x = -this.curlExtent + (2 * this.curlExtent * ix) / (n - 1);
          const y = -this.curlExtent + (2 * this.curlExtent * iy) / (n - 1);
          const z = -this.curlExtent + (2 * this.curlExtent * iz) / (n - 1);
          const sx = x * scale;
          const sy = y * scale;
          const sz = z * scale;

          // curl = ∇×A，中心差分
          const dA3_dy = n3(sx, sy + e * scale, sz) - n3(sx, sy - e * scale, sz);
          const dA2_dz = n2(sx, sy, sz + e * scale) - n2(sx, sy, sz - e * scale);
          const dA1_dz = n1(sx, sy, sz + e * scale) - n1(sx, sy, sz - e * scale);
          const dA3_dx = n3(sx + e * scale, sy, sz) - n3(sx - e * scale, sy, sz);
          const dA2_dx = n2(sx, sy, sz - e * scale) - n2(sx, sy, sz - e * scale);
          const dA1_dy = n1(sx, sy + e * scale, sz) - n1(sx, sy - e * scale, sz);

          const invE = 1 / (2 * e * scale);
          this.curlGrid[idx++] = (dA3_dy - dA2_dz) * invE;
          this.curlGrid[idx++] = (dA1_dz - dA3_dx) * invE;
          this.curlGrid[idx++] = (dA2_dx - dA1_dy) * invE;
        }
      }
    }
  }

  /** 三线性插值取湍流场 */
  private sampleCurl(x: number, y: number, z: number, out: Float32Array, o: number): void {
    const n = CURL_GRID;
    const ext = this.curlExtent;
    const gx = ((x + ext) / (2 * ext)) * (n - 1);
    const gy = ((y + ext) / (2 * ext)) * (n - 1);
    const gz = ((z + ext) / (2 * ext)) * (n - 1);
    if (gx < 0 || gy < 0 || gz < 0 || gx > n - 1 || gy > n - 1 || gz > n - 1) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      return;
    }
    const ix = Math.min(Math.floor(gx), n - 2);
    const iy = Math.min(Math.floor(gy), n - 2);
    const iz = Math.min(Math.floor(gz), n - 2);
    const fx = gx - ix;
    const fy = gy - iy;
    const fz = gz - iz;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    for (let c = 0; c < 8; c++) {
      const cx = c & 1;
      const cy = (c >> 1) & 1;
      const cz = (c >> 2) & 1;
      const w =
        (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy) * (cz ? fz : 1 - fz);
      const gi =
        ((iz + cz) * n * n + (iy + cy) * n + (ix + cx)) * 3;
      rx += this.curlGrid[gi] * w;
      ry += this.curlGrid[gi + 1] * w;
      rz += this.curlGrid[gi + 2] * w;
    }
    out[o] = rx;
    out[o + 1] = ry;
    out[o + 2] = rz;
  }

  /**
   * 粒子上色：色相 = 所属族的稳定基础色（init 分配，运动不变），
   * 半径只控制亮度——越靠近核心越亮，但色相保持高饱和蓝，绝不漂向白色。
   * 白色只允许出现在独立的 Core Compression 核心层（billboard），不由粒子承担。
   * blueSaturation 实时从参数读取（饱和度围绕亮度轴缩放）。
   */
  private applyColor(
    g: number,
    group: number,
    rn: number,
    jit: number,
    out: Float32Array,
    o: number
  ): void {
    let r = this.famColors[g * 3];
    let gg = this.famColors[g * 3 + 1];
    let b = this.famColors[g * 3 + 2];
    // Core 组（中心密集粒子）：向电光蓝偏移提亮，最亮也只到蓝，不到青白
    if (group === 1) {
      r = r * 0.4 + 0.12;
      gg = gg * 0.3 + 0.38;
      b = 1.0;
    }
    // 蓝色饱和度：围绕 luma 缩放（>1 更饱和，<1 更灰）
    const sat = this.params.blueSaturation;
    if (sat !== 1) {
      const luma = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      r = luma + (r - luma) * sat;
      gg = luma + (gg - luma) * sat;
      b = luma + (b - luma) * sat;
    }
    // 饱和度钳制：G ≤ 0.62B、R ≤ 0.42B——钳得比通道均值更狠，
    // additive 多层叠加 + ACES 高光去饱和后仍保持电光蓝，不漂成青白
    if (gg > b * 0.62) gg = b * 0.62;
    if (r > b * 0.42) r = b * 0.42;
    if (r < 0) r = 0;
    if (gg < 0) gg = 0;
    if (b > 1) b = 1;
    // 半径只控制亮度：核心 0.75 → 外缘 0.4，色相不变。
    // 内层投影密度极高，亮度必须随密度反压，否则 additive/半透明堆叠必然漂白
    const depth = Math.min(Math.max(rn, 0), 1.2);
    const lum = (0.75 - 0.35 * Math.min(depth / 0.9, 1)) * jit;
    out[o] = r * lum;
    out[o + 1] = gg * lum;
    out[o + 2] = b * lum;
  }

  private buildParticles(): void {
    const rng = this.rng;
    const R = this.params.radius;
    const n = this.params.particleCount;
    this.count = n;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.speed = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.starSize = new Float32Array(n);
    this.twinkle = new Float32Array(n * 2);
    this.family = new Uint8Array(n);
    this.group = new Uint8Array(n);
    this.colorJit = new Float32Array(n);

    // 分组标记：Edge Sparks + 高速 Flow 亮点走高亮层
    const isBright = new Int8Array(n);

    // flow 粒子按 shuffled round-robin 分族
    const famOrder = new Uint8Array(FAMILIES * 4);
    for (let i = 0; i < famOrder.length; i++) famOrder[i] = i % FAMILIES;
    for (let i = famOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = famOrder[i];
      famOrder[i] = famOrder[j];
      famOrder[j] = tmp;
    }
    let famCursor = 0;

    for (let i = 0; i < n; i++) {
      const pick = rng.next();
      const io = i * 3;

      if (pick < 0.85) {
        // ---- 85% Flow：全体积分布（不再是球壳），随后向心压缩流动 ----
        const g = famOrder[famCursor++ % famOrder.length];
        this.family[i] = g;
        this.group[i] = 0;
        let dx = rng.gauss();
        let dy = rng.gauss();
        let dz = rng.gauss();
        const inv = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
        dx *= inv;
        dy *= inv;
        dz *= inv;
        // cbrt 均匀体积采样，映射到 0.12R~1.0R
        const r = R * (0.12 + 0.88 * Math.cbrt(rng.next()));
        this.position[io] = dx * r;
        this.position[io + 1] = dy * r;
        this.position[io + 2] = dz * r;

        // 尺寸 1.0~1.9px（粒子是辅助，不是主视觉）；约 4% 亮点走高亮层
        if (rng.next() < 0.04) {
          isBright[i] = 1;
          this.starSize[i] = rng.range(0.9, 1.5);
        } else {
          this.starSize[i] = rng.range(1.0, 1.9);
        }
      } else if (pick < 0.97) {
        // ---- 12% Core：0.22R 内密集压缩核 ----
        const g = Math.floor(rng.next() * FAMILIES);
        this.family[i] = g;
        this.group[i] = 1;
        let dx = rng.gauss();
        let dy = rng.gauss();
        let dz = rng.gauss();
        const inv = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
        dx *= inv;
        dy *= inv;
        dz *= inv;
        const r = R * 0.22 * Math.cbrt(rng.next());
        this.position[io] = dx * r;
        this.position[io + 1] = dy * r;
        this.position[io + 2] = dz * r;
        this.starSize[i] = rng.range(1.2, 2.0);
      } else {
        // ---- 3% Edge Sparks：外缘高速碎光（高亮层，数量克制）----
        const g = Math.floor(rng.next() * FAMILIES);
        this.family[i] = g;
        this.group[i] = 2;
        let dx = rng.gauss();
        let dy = rng.gauss();
        let dz = rng.gauss();
        const inv = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
        dx *= inv;
        dy *= inv;
        dz *= inv;
        const r = R * rng.range(0.9, 1.08);
        this.position[io] = dx * r;
        this.position[io + 1] = dy * r;
        this.position[io + 2] = dz * r;
        isBright[i] = 1;
        this.starSize[i] = rng.range(0.8, 1.5);
      }

      // 初速度 = 该点族目标速度 + 小噪声
      const tv = this.targetAt(
        this.position[io],
        this.position[io + 1],
        this.position[io + 2],
        this.family[i],
        this.targetScratch,
        0
      );
      this.velocity[io] = tv[0] + rng.gauss() * 0.4;
      this.velocity[io + 1] = tv[1] + rng.gauss() * 0.4;
      this.velocity[io + 2] = tv[2] + rng.gauss() * 0.4;

      // 颜色：族稳定基础色 × 半径亮度 × 固定亮度抖动（每步随半径刷新亮度，见 step）
      const rn = Math.hypot(
        this.position[io],
        this.position[io + 1],
        this.position[io + 2]
      ) / R;
      const f = 0.85 + rng.next() * 0.3;
      this.colorJit[i] = f;
      this.applyColor(this.family[i], this.group[i], rn, f, this.color, io);

      // 闪烁：4% 粒子，克制
      if (rng.next() < 0.04) {
        this.twinkle[i * 2] = rng.range(0.05, 0.1);
        this.twinkle[i * 2 + 1] = rng.next() * Math.PI * 2;
      }
    }

    // 高亮粒子（Edge Sparks + 高速 Flow 亮点）排到数组尾部
    const order = new Int32Array(n);
    let head = 0;
    let tail = n;
    for (let i = 0; i < n; i++) if (!isBright[i]) order[head++] = i;
    for (let i = 0; i < n; i++) if (isBright[i]) order[--tail] = i;
    this.brightStart = tail;
    this.permute3(this.position, order);
    this.permute3(this.velocity, order);
    this.permute3(this.color, order);
    this.permute1(this.speed, order);
    this.permute1(this.starSize, order);
    this.permute2(this.twinkle, order);
    this.permuteFamily(order);
    this.permuteGroup(this.group, order);
    this.permute1(this.colorJit, order);

    this.syncSpeed();
  }

  // ---------------------------------------------------------------- 力场

  /**
   * 目标速度场 = 向心压缩 + 不规则局部旋转 + 少量湍流。
   * axisMix < 1 时轴向共享轴方向混合；Orbit Family 只提供局部旋向，
   * 不再绑定固定轨道半径。
   */
  private targetAt(
    px: number,
    py: number,
    pz: number,
    g: number,
    out: Float32Array,
    o: number
  ): Float32Array {
    const {
      swirl,
      axisMix,
      turbulence,
      compression,
      radius: R,
      coreSpin,
    } = this.params;

    // 有效轴 = mix(sharedAxis, famAxis, axisMix)
    let ax = this.sharedAxis[0] * (1 - axisMix) + this.famAxis[g * 3] * axisMix;
    let ay = this.sharedAxis[1] * (1 - axisMix) + this.famAxis[g * 3 + 1] * axisMix;
    let az = this.sharedAxis[2] * (1 - axisMix) + this.famAxis[g * 3 + 2] * axisMix;
    const ainv = 1 / Math.max(Math.hypot(ax, ay, az), 1e-6);
    ax *= ainv;
    ay *= ainv;
    az *= ainv;

    const r = Math.max(Math.hypot(px, py, pz), 1e-6);
    const rn = r / R;

    // tangent = normalize(cross(axis, p))；近轴处 cross 退化，用族基 u 兜底
    let tx = ay * pz - az * py;
    let ty = az * px - ax * pz;
    let tz = ax * py - ay * px;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-4 * r) {
      const tinv = 1 / tl;
      tx *= tinv;
      ty *= tinv;
      tz *= tinv;
    } else {
      tx = this.famU[g * 3];
      ty = this.famU[g * 3 + 1];
      tz = this.famU[g * 3 + 2];
    }

    // 切向速度：角速度 ∝ 1/(r+ε)^α，越靠近中心旋转越快（高旋转密度）。
    // α = 0.5·(0.5+0.5·coreSpin)：coreSpin 越大核心旋转主导性越强。
    // V6：粒子全程处于稳态流——Formation（中心先形成、再向外扩张）
    // 由 ChakraVolume Shader 的径向显现遮罩负责，不再用传播延迟拖慢粒子启动
    const eps = 0.12 * R;
    const alpha = SWIRL_ALPHA * (0.5 + 0.5 * coreSpin);
    const vTan = swirl * 11 * Math.pow((R + eps) / (r + eps), alpha) * this.famSpeedMul[g];

    // 螺旋拓扑：在轨道面内加入向内的径向分量，把「球面大圆轨道」
    // 扭成「围绕核心卷入的螺旋流线」（反向旋转族同样始终向内卷）
    const pdot = px * ax + py * ay + pz * az;
    let rx = px - ax * pdot;
    let ry = py - ay * pdot;
    let rz = pz - az * pdot;
    const rl = Math.hypot(rx, ry, rz);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (rl > 1e-4 * r) {
      const rinv = 1 / rl;
      const sp = Math.abs(vTan) * SPIRAL_PITCH;
      sx = -rx * rinv * sp;
      sy = -ry * rinv * sp;
      sz = -rz * rinv * sp;
    }

    // 向心压缩：-normalize(p)·compression·0.32R·smoothstep(0.10, 0.45, rn)
    // 中心附近渐零（避免与回收/防坍缩打架），中外部恒定拉向球心
    const cs = Math.min(Math.max((rn - 0.1) / 0.35, 0), 1);
    const vIn = compression * COMPRESS_BASE * R * cs * cs * (3 - 2 * cs);
    const inx = (-px / r) * vIn;
    const iny = (-py / r) * vIn;
    const inz = (-pz / r) * vIn;

    // 湍流扰动（只占 5%~12%，不能主导结构）
    this.sampleCurl(px, py, pz, this.turbScratch, 0);
    const ts = turbulence * TURB_BASE;

    out[o] = tx * vTan + sx + inx + this.turbScratch[0] * ts;
    out[o + 1] = ty * vTan + sy + iny + this.turbScratch[1] * ts;
    out[o + 2] = tz * vTan + sz + inz + this.turbScratch[2] * ts;
    return out;
  }

  private targetScratch = new Float32Array(3);
  private turbScratch = new Float32Array(3);

  /** 极慢进动：每步只更新 15 条轴与基向量（Rodrigues 小增量旋转） */
  private precessAxes(): void {
    this.precessAngle += DT;
    const { axisMix } = this.params;
    if (axisMix < 0.02) return; // 共轴时无需进动
    for (let g = 0; g < FAMILIES; g++) {
      const rate = this.precessRate[g];
      const kx = this.precessAxis[g * 3];
      const ky = this.precessAxis[g * 3 + 1];
      const kz = this.precessAxis[g * 3 + 2];
      // v' = v·cosΔ + (k×v)·sinΔ + k(k·v)(1−cosΔ)，Δ = rate·DT
      const dA = rate * DT;
      const cd = Math.cos(dA);
      const sd = Math.sin(dA);
      const vx = this.famAxis[g * 3];
      const vy = this.famAxis[g * 3 + 1];
      const vz = this.famAxis[g * 3 + 2];
      const kxv = ky * vz - kz * vy;
      const kyv = kz * vx - kx * vz;
      const kzv = kx * vy - ky * vx;
      const kdv = kx * vx + ky * vy + kz * vz;
      const nx = vx * cd + kxv * sd + kx * kdv * (1 - cd);
      const ny = vy * cd + kyv * sd + ky * kdv * (1 - cd);
      const nz = vz * cd + kzv * sd + kz * kdv * (1 - cd);
      const ninv = 1 / Math.max(Math.hypot(nx, ny, nz), 1e-6);
      this.famAxis[g * 3] = nx * ninv;
      this.famAxis[g * 3 + 1] = ny * ninv;
      this.famAxis[g * 3 + 2] = nz * ninv;
      this.buildBasis(g);
    }
  }

  step(): void {
    const { confinement, drag, radius: R } = this.params;
    const n = this.count;
    const { position, velocity, family } = this;

    this.precessAxes();

    for (let i = 0; i < n; i++) {
      const io = i * 3;
      const px = position[io];
      const py = position[io + 1];
      const pz = position[io + 2];

      // 目标速度 = 族旋涡 + 平面/径向修正 + 湍流扰动
      const tv = this.targetAt(px, py, pz, family[i], this.targetScratch, 0);

      const vx = velocity[io];
      const vy = velocity[io + 1];
      const vz = velocity[io + 2];

      let ax = FOLLOW * (tv[0] - vx) - drag * vx;
      let ay = FOLLOW * (tv[1] - vy) - drag * vy;
      let az = FOLLOW * (tv[2] - vz) - drag * vz;

      // 柔性球形约束
      const r = Math.hypot(px, py, pz);
      const rn = r / R;
      if (rn > 0.85 && r > 1e-6) {
        // 外侧向内：0.85R 起渐强，出 R 后二次增强
        const over = (rn - 0.85) / 0.15;
        const extra = rn > 1 ? (rn - 1) * (rn - 1) * 8 : 0;
        const f = (-confinement * 14 * (over + extra)) / r;
        ax += f * px;
        ay += f * py;
        az += f * pz;
      } else if (rn < 0.12 && r > 1e-6) {
        // 中心轻微向外，防坍缩
        const f = (confinement * 6 * (0.12 - rn)) / (0.12 * r);
        ax += f * px;
        ay += f * py;
        az += f * pz;
      }

      const nvx = vx + ax * DT;
      const nvy = vy + ay * DT;
      const nvz = vz + az * DT;
      velocity[io] = nvx;
      velocity[io + 1] = nvy;
      velocity[io + 2] = nvz;
      position[io] = px + nvx * DT;
      position[io + 1] = py + nvy * DT;
      position[io + 2] = pz + nvz * DT;

      // Flow 粒子流入核心（r < 0.085R）→ seed 确定性重生到外缘 0.88~1.0R，
      // 维持「外层查克拉持续向中心凝聚」的压缩流，而不是在核心堆积
      let nr2 =
        position[io] * position[io] +
        position[io + 1] * position[io + 1] +
        position[io + 2] * position[io + 2];
      if (this.group[i] === 0 && nr2 < RECYCLE_RN * RECYCLE_RN * R * R) {
        let dx = this.rng.gauss();
        let dy = this.rng.gauss();
        let dz = this.rng.gauss();
        const inv = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
        const rr = R * (0.88 + this.rng.next() * 0.12);
        position[io] = dx * inv * rr;
        position[io + 1] = dy * inv * rr;
        position[io + 2] = dz * inv * rr;
        const tv = this.targetAt(
          position[io],
          position[io + 1],
          position[io + 2],
          this.family[i],
          this.targetScratch,
          0
        );
        velocity[io] = tv[0] + this.rng.gauss() * 0.3;
        velocity[io + 1] = tv[1] + this.rng.gauss() * 0.3;
        velocity[io + 2] = tv[2] + this.rng.gauss() * 0.3;
        nr2 = rr * rr;
      }

      // 动态按半径刷新亮度：流向中心 → 变亮，但色相保持族基础色（高饱和蓝），不漂白
      this.applyColor(
        this.family[i],
        this.group[i],
        Math.sqrt(nr2) / R,
        this.colorJit[i],
        this.color,
        io
      );
    }

    this.stepCount++;
    this.time += DT;
  }

  update(frameDt: number): void {
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= DT && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.accumulator -= DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  syncSpeed(): void {
    const { velocity, speed, count } = this;
    for (let i = 0; i < count; i++) {
      const io = i * 3;
      const vx = velocity[io];
      const vy = velocity[io + 1];
      const vz = velocity[io + 2];
      speed[i] = Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
  }

  private permute1(arr: Float32Array, order: Int32Array): void {
    const copy = arr.slice();
    for (let i = 0; i < order.length; i++) arr[i] = copy[order[i]];
  }

  private permute2(arr: Float32Array, order: Int32Array): void {
    const copy = arr.slice();
    for (let i = 0; i < order.length; i++) {
      arr[i * 2] = copy[order[i] * 2];
      arr[i * 2 + 1] = copy[order[i] * 2 + 1];
    }
  }

  private permute3(arr: Float32Array, order: Int32Array): void {
    const copy = arr.slice();
    for (let i = 0; i < order.length; i++) {
      arr[i * 3] = copy[order[i] * 3];
      arr[i * 3 + 1] = copy[order[i] * 3 + 1];
      arr[i * 3 + 2] = copy[order[i] * 3 + 2];
    }
  }

  private permuteFamily(order: Int32Array): void {
    const copy = this.family.slice();
    for (let i = 0; i < order.length; i++) this.family[i] = copy[order[i]];
  }

  private permuteGroup(arr: Uint8Array, order: Int32Array): void {
    const copy = arr.slice();
    for (let i = 0; i < order.length; i++) arr[i] = copy[order[i]];
  }
}
