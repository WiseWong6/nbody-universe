import { createRng, createNoise2D, type Rng } from './rng';
import { PRESETS } from './presets';
import type { SimParams, CoreSpec } from './types';
import type { ParticleSimulation } from './simulation-interface';

/**
 * 受限 N-body 模拟。
 *
 * - 2~5 个有质量引力核心：核心之间 O(k²) 互算引力，自身积分运动。
 * - 大量无质量示踪粒子：只受核心引力，粒子之间不互算。
 * - 力：a = Σ G·mᵢ·(rᵢ−r) / (|rᵢ−r|² + ε²)^(3/2)，ε 为 softening。
 * - 积分：Leapfrog KDK（等价 Velocity Verlet），固定步长 SIM_DT。
 *
 * 初始分布分两种：
 * - 经典预设（spiral/collision/chaos）：指数盘 + 切向速度。
 * - hero：艺术引导分布（核球 + 对数螺旋臂 + 星盘 + 星晕 + 尘埃带），
 *   N-body 只负责后续演化。
 *
 * 纯 TypeScript、不依赖 three，可在 Node 中无头运行做稳定性验证。
 */

/** 固定物理步长（模拟秒） */
export const SIM_DT = 0.006;
/** 每渲染帧最多物理步数（慢设备慢动作而不跳变） */
const MAX_STEPS_PER_FRAME = 40;
/** softening 参数 epsilon（防近距离数值爆炸） */
const SOFTENING = 0.9;
/** 速度上限，兜底防止个别粒子被弹弓效应打飞成 NaN 量级 */
const V_MAX = 90;
const V_MAX_SQ = V_MAX * V_MAX;

/** 恒星类别 */
const CLASS_DUST = 0; // 99% 微小恒星
const CLASS_BRIGHT = 2; // 1% 高亮恒星

export class NBodySimulation implements ParticleSimulation {
  readonly params: SimParams;

  /** 核心数 */
  coreCount = 0;
  /** 核心状态：每核心 7 个分量 [m, x, y, z, vx, vy, vz] */
  cores = new Float32Array(0);
  /** 核心加速度缓存（Leapfrog 跨步复用） */
  coreAccel = new Float32Array(0);

  count = 0;
  /** 粒子位置 xyz */
  position = new Float32Array(0);
  /** 粒子速度 xyz */
  velocity = new Float32Array(0);
  /** 粒子加速度缓存 xyz */
  accel = new Float32Array(0);
  /** 粒子速率标量（供 shader 亮度/大小） */
  speed = new Float32Array(0);
  /** 粒子基础颜色 rgb（init 时写入，含尘埃暗化与类别亮度，之后不变） */
  color = new Float32Array(0);
  /** 每个粒子归属的核心索引 */
  coreOf = new Int32Array(0);
  /** 每粒子基准像素尺寸（按恒星类别，init 时写入） */
  starSize = new Float32Array(0);
  /** 每粒子闪烁参数 [amp, phase]，仅少数粒子 amp>0 */
  twinkle = new Float32Array(0);
  /** 渲染分层：索引 >= brightStart 的是高亮恒星（排在数组尾部） */
  brightStart = 0;

  /** 已执行的物理步数（确定性审计 + HUD） */
  stepCount = 0;
  /** 模拟时间 */
  time = 0;

  private rng: Rng = createRng(1);
  private accumulator = 0;

  constructor(params: SimParams) {
    this.params = { ...params };
    this.init();
  }

  /** 按当前参数（重新）生成初始状态 */
  init(): void {
    this.rng = createRng(this.params.seed);
    this.accumulator = 0;
    this.stepCount = 0;
    this.time = 0;
    this.build();
  }

  reset(): void {
    this.init();
  }

  dispose(): void {
    // TypedArray 由 GC 回收；接口对称保留
  }

  /** 推进模拟：frameDt（秒，已乘 Time Scale）→ 固定步长整数步 */
  update(frameDt: number): void {
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.accumulator -= SIM_DT;
      steps++;
    }
    // 物理跑不满实时就丢弃残余时间（慢设备上宁可慢动作也不跳变）
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  // ---------------------------------------------------------------- 初始化

  private build(): void {
    const { particleCount } = this.params;
    const spec = PRESETS[this.params.preset];
    const rng = this.rng;

    // --- 引力核心 ---
    const k = spec.cores.length;
    this.coreCount = k;
    this.cores = new Float32Array(k * 7);
    this.coreAccel = new Float32Array(k * 3);

    spec.cores.forEach((c: CoreSpec, i: number) => {
      const o = i * 7;
      // Chaos 同时扰动核心初始位置与速度（由 seed 决定，保证可复现）。
      // 单核心预设不做速度扰动，避免星系整体漂移出画面中心。
      const jitterScale = k > 1 ? 1 : 0;
      const posJitter = this.params.chaos * 6.0 * jitterScale;
      const velJitter = this.params.chaos * 1.2 * jitterScale;
      this.cores[o + 0] = c.mass;
      this.cores[o + 1] = c.position[0] + (rng.next() * 2 - 1) * posJitter;
      this.cores[o + 2] = c.position[1] + (rng.next() * 2 - 1) * posJitter;
      this.cores[o + 3] = c.position[2] + (rng.next() * 2 - 1) * posJitter;
      this.cores[o + 4] = c.velocity[0] + (rng.next() * 2 - 1) * velJitter;
      this.cores[o + 5] = c.velocity[1] + (rng.next() * 2 - 1) * velJitter;
      this.cores[o + 6] = c.velocity[2] + (rng.next() * 2 - 1) * velJitter;
    });

    // --- 示踪粒子 ---
    const n = particleCount;
    this.count = n;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.accel = new Float32Array(n * 3);
    this.speed = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.coreOf = new Int32Array(n);
    this.starSize = new Float32Array(n);
    this.twinkle = new Float32Array(n * 2);

    // 粒子归属结构（hero：0 核球 / 1 旋臂 / 2 星盘 / 3 星晕；其他：-1）
    const structure = new Int32Array(n).fill(-1);

    if (this.params.preset === 'hero') {
      this.buildHeroGalaxy(structure);
    } else {
      this.buildClassicDisks();
      this.colorClassic();
    }

    // 恒星分类、尺寸、闪烁、着色收尾 + 高亮排序（所有预设共用）
    this.classifyAndSort(structure);

    // Leapfrog 需要 t=0 时刻的加速度
    this.computeCoreAccel();
    this.computeParticleAccel();
    this.syncSpeed();
  }

  // ------------------------------------------------------------ 经典预设

  private buildClassicDisks(): void {
    const { chaos, rotation, gravity } = this.params;
    const spec = PRESETS[this.params.preset];
    const rng = this.rng;
    const k = this.coreCount;
    const n = this.count;

    // 按 diskFraction 前缀和分配粒子归属核心
    const fracPrefix = new Array<number>(k);
    let acc = 0;
    for (let i = 0; i < k; i++) {
      acc += spec.cores[i].diskFraction;
      fracPrefix[i] = acc;
    }

    for (let i = 0; i < n; i++) {
      // 选核心
      const pick = rng.next() * acc;
      let ci = 0;
      while (ci < k - 1 && pick > fracPrefix[ci]) ci++;
      const c = spec.cores[ci];
      const co = ci * 7;

      // 指数盘半径：r = -R_d * ln(1-u)，截断
      const u = Math.min(rng.next(), 0.999);
      let r = -c.diskRadius * Math.log(1 - u);
      r = Math.min(Math.max(r, c.diskRadius * 0.12), c.diskMaxRadius);
      const theta = rng.next() * Math.PI * 2;
      // 盘面厚度：随半径略增的薄高斯
      const thickness = 0.12 + r * 0.045;
      const px = r * Math.cos(theta);
      const py = rng.gauss() * thickness;
      const pz = r * Math.sin(theta);

      // 盘面倾斜（绕 X 再绕 Z）
      const cx = Math.cos(c.tiltX);
      const sx = Math.sin(c.tiltX);
      const cz = Math.cos(c.tiltZ);
      const sz = Math.sin(c.tiltZ);
      const y1 = py * cx - pz * sx;
      const z1 = py * sx + pz * cx;
      const x1 = px;
      const x2 = x1 * cz - y1 * sz;
      const y2 = x1 * sz + y1 * cz;

      const io = i * 3;
      this.position[io + 0] = this.cores[co + 1] + x2;
      this.position[io + 1] = this.cores[co + 2] + y2;
      this.position[io + 2] = this.cores[co + 3] + z1;

      // 切向速度 v = sqrt(GM_eff / r)，M_eff 含核心 + 盘内包络质量近似
      const enclosed = c.mass * (1 + 0.22 * Math.min(r / c.diskRadius, 3));
      let vMag = Math.sqrt((gravity * enclosed) / r);
      vMag *= rotation * (1 + (rng.next() * 2 - 1) * chaos * 0.55);
      const radialKick = (rng.next() * 2 - 1) * chaos * 0.3 * vMag;

      const tvx = -Math.sin(theta) * vMag + Math.cos(theta) * radialKick;
      const tvy = rng.gauss() * 0.06 * vMag;
      const tvz = Math.cos(theta) * vMag + Math.sin(theta) * radialKick;
      const vy1 = tvy * cx - tvz * sx;
      const vz1 = tvy * sx + tvz * cx;
      const vx2 = tvx * cz - vy1 * sz;
      const vy2 = tvx * sz + vy1 * cz;

      this.velocity[io + 0] = this.cores[co + 4] + vx2;
      this.velocity[io + 1] = this.cores[co + 5] + vy2;
      this.velocity[io + 2] = this.cores[co + 6] + vz1;

      this.coreOf[i] = ci;
    }
  }

  /** 经典预设配色：按所属核心与盘半径映射到暖白/淡蓝/淡紫 */
  private colorClassic(): void {
    const spec = PRESETS[this.params.preset];
    const rng = this.rng;
    const n = this.count;
    const inner: [number, number, number] = [1.0, 0.88, 0.66];
    const mid: [number, number, number] = [0.42, 0.6, 1.0];
    const outer: [number, number, number] = [0.66, 0.42, 1.0];
    for (let i = 0; i < n; i++) {
      const io = i * 3;
      const ci = this.coreOf[i];
      const co = ci * 7;
      const dx = this.position[io] - this.cores[co + 1];
      const dy = this.position[io + 1] - this.cores[co + 2];
      const dz = this.position[io + 2] - this.cores[co + 3];
      const rNorm = Math.min(
        Math.sqrt(dx * dx + dy * dy + dz * dz) / spec.cores[ci].diskMaxRadius,
        1
      );
      let cr: number;
      let cg: number;
      let cb: number;
      if (rNorm < 0.4) {
        const t = rNorm / 0.4;
        cr = inner[0] + (mid[0] - inner[0]) * t;
        cg = inner[1] + (mid[1] - inner[1]) * t;
        cb = inner[2] + (mid[2] - inner[2]) * t;
      } else {
        const t = (rNorm - 0.4) / 0.6;
        cr = mid[0] + (outer[0] - mid[0]) * t;
        cg = mid[1] + (outer[1] - mid[1]) * t;
        cb = mid[2] + (outer[2] - mid[2]) * t;
      }
      const jitter = 0.85 + rng.next() * 0.3;
      this.color[io] = cr * jitter;
      this.color[io + 1] = cg * jitter;
      this.color[io + 2] = cb * jitter;
    }
  }

  // ------------------------------------------------------------ Hero 银河

  /**
   * 艺术引导初始分布：15% 核球 / 50% 对数螺旋臂 / 30% 星盘 / 5% 星晕。
   * N-body 只负责后续演化。
   */
  private buildHeroGalaxy(structure: Int32Array): void {
    const { chaos, rotation, gravity, seed } = this.params;
    const spec = PRESETS.hero;
    const c = spec.cores[0];
    const rng = this.rng;
    const n = this.count;
    const dustNoise = createNoise2D(seed);

    // 对数螺旋臂参数：r = A * exp(B * θ)
    // B 取较大值 → 臂更开展（ grand-design 风格，约 1.2 圈），
    // 差速旋转卷绕时结构衰减更慢
    const ARM_A = 2.5;
    const ARM_B = 0.34;
    const ARM_R_MAX = 35;
    const TILT = c.tiltX;
    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);

    /** 尘埃暗化系数：低频噪声，旋臂间区域更暗 [0.25, 1] */
    const dustAt = (x: number, z: number): number => {
      const d = dustNoise(x * 0.085 + 3.1, z * 0.085 + 7.7);
      if (d > 0.55) return 1;
      return 0.25 + (d / 0.55) * 0.75;
    };

    // 写入一个粒子（局部盘坐标 → 倾斜 → 世界），并给切向初速度
    const place = (
      i: number,
      lx: number,
      ly: number,
      lz: number,
      r: number,
      scatter: number
    ): void => {
      const io = i * 3;
      // 绕 X 倾斜
      const y1 = ly * cosT - lz * sinT;
      const z1 = ly * sinT + lz * cosT;
      this.position[io] = lx;
      this.position[io + 1] = y1;
      this.position[io + 2] = z1;

      // v = sqrt(GM_eff / r)，倍率 = rotation × (1 ± chaos·0.4) 轻扰动
      const rr = Math.max(r, 0.8);
      const enclosed = c.mass * (1 + 0.22 * Math.min(rr / c.diskRadius, 3));
      let vMag = Math.sqrt((gravity * enclosed) / rr);
      vMag *= rotation * (1 + (rng.next() * 2 - 1) * chaos * 0.4);

      // 切向（盘面内，逆时针）+ 少量径向/垂向扰动
      const inv = 1 / Math.max(Math.hypot(lx, lz), 1e-6);
      const tx = -lz * inv;
      const tz = lx * inv;
      const radial = (rng.next() * 2 - 1) * chaos * 0.25 * vMag;
      let vx = tx * vMag + lx * inv * radial + rng.gauss() * scatter * vMag;
      let vy = rng.gauss() * (0.04 + scatter * 0.5) * vMag;
      let vz = tz * vMag + lz * inv * radial + rng.gauss() * scatter * vMag;
      // 与位置一致的倾斜
      const vy1 = vy * cosT - vz * sinT;
      const vz1 = vy * sinT + vz * cosT;
      this.velocity[io] = vx;
      this.velocity[io + 1] = vy1;
      this.velocity[io + 2] = vz1;
      this.coreOf[i] = 0;
    };

    for (let i = 0; i < n; i++) {
      const pick = rng.next();
      const io = i * 3;

      if (pick < 0.15) {
        // ---- 中央核球：三维高斯球（收缩核心面积），较厚 ----
        structure[i] = 0;
        let r = 0;
        let lx = 0;
        let ly = 0;
        let lz = 0;
        do {
          lx = rng.gauss() * 2.0;
          ly = rng.gauss() * 1.5;
          lz = rng.gauss() * 2.0;
          r = Math.hypot(lx, ly, lz);
        } while (r > 4.5);
        place(i, lx, ly, lz, r, 0.28);
      } else if (pick < 0.65) {
        // ---- 对数螺旋臂（含宽度/角度扰动、分叉、外端密度渐稀、尘埃拒绝采样）----
        structure[i] = 1;
        let lx = 0;
        let lz = 0;
        let r = 0;
        let dust = 1;
        for (let attempt = 0; attempt < 8; attempt++) {
          const arm = rng.next() < 0.5 ? 0 : Math.PI;
          // 沿半径均匀采样（而不是沿 θ），避免粒子全挤在内圈
          r = ARM_A + rng.next() * (ARM_R_MAX - ARM_A);
          // 外端密度渐稀：按 r 拒绝
          if (rng.next() < 0.4 * (r / ARM_R_MAX) && attempt < 6) continue;
          let theta = Math.log(r / ARM_A) / ARM_B;
          // 分叉：约 18% 粒子放到弱化的次级分叉臂（更宽更散）
          let fork = false;
          if (rng.next() < 0.18 && theta > 2.5) {
            theta = theta - 0.9 + rng.gauss() * 0.15;
            r = ARM_A * Math.exp(ARM_B * theta);
            fork = true;
          }
          // 角度扰动
          theta += (rng.next() * 2 - 1) * 0.06;
          const th = theta + arm;
          r = ARM_A * Math.exp(ARM_B * theta);
          // 宽度扰动：法向高斯，外侧变宽
          const w = (0.45 + r * 0.09) * (fork ? 1.6 : 1);
          const perp = rng.gauss() * w;
          const rad = rng.gauss() * w * 0.5;
          const ca = Math.cos(th);
          const sa = Math.sin(th);
          lx = r * ca - sa * perp + ca * rad;
          lz = r * sa + ca * perp + sa * rad;
          dust = dustAt(lx, lz);
          // 暗尘带：旋臂内侧（perp 负侧）噪声遮罩强暗化 + 强拒绝
          const laneT = perp / w;
          if (laneT > -2.0 && laneT < -0.35) {
            const ln = dustNoise(lx * 0.3 + 11.0, lz * 0.3 + 4.0);
            const laneDust = 0.1 + ln * 0.35;
            if (laneDust < dust) dust = laneDust;
          }
          // 尘埃带：以 (1-dust) 概率拒绝重采，降低局部密度
          if (rng.next() < 0.35 + 0.65 * dust || attempt === 7) break;
        }
        const ly = rng.gauss() * (0.35 + r * 0.02);
        place(i, lx, ly, lz, r, 0.05);
        // 尘埃暗化暂存到 color 槽位，着色收尾时读取（init 内部约定）
        this.color[io] = -dust;
      } else if (pick < 0.95) {
        // ---- 稀疏星盘：指数盘，更薄 ----
        structure[i] = 2;
        let r = 0;
        let lx = 0;
        let lz = 0;
        let dust = 1;
        for (let attempt = 0; attempt < 6; attempt++) {
          const u = Math.min(rng.next(), 0.999);
          r = Math.min(-c.diskRadius * Math.log(1 - u), c.diskMaxRadius);
          r = Math.max(r, c.diskRadius * 0.15);
          const theta = rng.next() * Math.PI * 2;
          lx = r * Math.cos(theta);
          lz = r * Math.sin(theta);
          dust = dustAt(lx, lz);
          if (rng.next() < 0.4 + 0.6 * dust || attempt === 5) break;
        }
        const ly = rng.gauss() * (0.18 + r * 0.022);
        place(i, lx, ly, lz, r, 0.06);
        this.color[io] = -dust;
      } else {
        // ---- 外围星晕：稀疏球壳 ----
        structure[i] = 3;
        // 随机方向 + 大半径
        let dx = rng.gauss();
        let dy = rng.gauss();
        let dz = rng.gauss();
        const inv = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
        dx *= inv;
        dy *= inv;
        dz *= inv;
        const r = Math.min(Math.max(Math.abs(rng.gauss()) * 24 + 12, 12), 60);
        place(i, dx * r, dy * r * 0.6, dz * r, r, 0.5);
      }
    }

    // ---- Hero 配色：按结构分区（尘埃暗化已存入 color[io] 负值约定）----
    // 中心暖白淡金 / 旋臂冷白灰蓝 / 星晕暗淡，整体降饱和
    const gold: [number, number, number] = [1.0, 0.85, 0.58];
    const armBlue: [number, number, number] = [0.6, 0.68, 0.9];
    const diskWhite: [number, number, number] = [0.78, 0.78, 0.88];
    const haloDim: [number, number, number] = [0.58, 0.62, 0.8];
    for (let i = 0; i < n; i++) {
      const io = i * 3;
      const stored = this.color[io];
      const dust = stored < 0 ? -stored : 1;
      let base: [number, number, number];
      let bright: number;
      switch (structure[i]) {
        case 0: // 核球：暖白淡金，亮度压低（防中心过曝）
          base = gold;
          bright = 0.22;
          break;
        case 1: // 旋臂：冷白灰蓝
          base = armBlue;
          bright = 0.7;
          break;
        case 2: // 星盘：冷白
          base = diskWhite;
          bright = 0.5;
          break;
        default: // 星晕：暗淡冷色
          base = haloDim;
          bright = 0.32;
          break;
      }
      const jitter = 0.85 + rng.next() * 0.3;
      const f = bright * dust * jitter;
      this.color[io] = base[0] * f;
      this.color[io + 1] = base[1] * f;
      this.color[io + 2] = base[2] * f;
    }
  }

  // ------------------------------------------------------------ 分类与分层

  /**
   * 恒星分类（尺寸、闪烁、高亮着色增强），并把高亮恒星排到数组尾部，
   * 供渲染层用 drawRange 拆分。确定性置换，物理与顺序无关。
   */
  private classifyAndSort(structure: Int32Array): void {
    const rng = this.rng;
    const n = this.count;
    const cls = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const p = rng.next();
      // 99% 微小恒星（星河质感）/ 1% 高亮恒星（克制，仅这层参与 Bloom）
      cls[i] = p < 0.99 ? CLASS_DUST : CLASS_BRIGHT;
      const io = i * 3;

      // 尺寸（CSS px 基准，渲染层再乘 DPR 与透视）
      if (cls[i] === CLASS_DUST) {
        this.starSize[i] = rng.range(0.35, 0.9);
      } else {
        this.starSize[i] = rng.range(1.5, 3.5);
      }

      // 闪烁：约 8% 粒子，缓慢克制、相位错开
      if (rng.next() < 0.08) {
        this.twinkle[i * 2] = rng.range(0.05, 0.15);
        this.twinkle[i * 2 + 1] = rng.next() * Math.PI * 2;
      }

      // 类别亮度/色温微调
      if (cls[i] === CLASS_BRIGHT) {
        // 高亮恒星：提亮并带极淡紫色调（低饱和）
        const boost = 3.0;
        this.color[io] = Math.min(this.color[io] * boost * 0.98, 1.45);
        this.color[io + 1] = Math.min(this.color[io + 1] * boost * 0.92, 1.35);
        this.color[io + 2] = Math.min(this.color[io + 2] * boost * 1.1, 1.5);
      } else if (cls[i] === CLASS_DUST) {
        const dim = 0.8;
        this.color[io] *= dim;
        this.color[io + 1] *= dim;
        this.color[io + 2] *= dim;
      }
    }

    // 高亮恒星排到尾部（稳定排序：非高亮保持原顺序在前）
    const order = new Int32Array(n);
    let head = 0;
    let tail = n;
    for (let i = 0; i < n; i++) if (cls[i] !== CLASS_BRIGHT) order[head++] = i;
    for (let i = 0; i < n; i++) if (cls[i] === CLASS_BRIGHT) order[--tail] = i;
    this.brightStart = tail;

    this.permute3(this.position, order);
    this.permute3(this.velocity, order);
    this.permute3(this.color, order);
    this.permute1(this.speed, order);
    this.permute1(this.starSize, order);
    this.permute2(this.twinkle, order);
    const coreOfCopy = this.coreOf.slice();
    const structureCopy = structure.slice();
    for (let i = 0; i < n; i++) {
      this.coreOf[i] = coreOfCopy[order[i]];
      structure[i] = structureCopy[order[i]];
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

  // ---------------------------------------------------------------- 力计算

  /** 核心间互算引力（O(k²)，k≤5） */
  private computeCoreAccel(): void {
    const { cores, coreAccel, coreCount } = this;
    const g = this.params.gravity;
    const eps2 = SOFTENING * SOFTENING;
    coreAccel.fill(0);
    for (let i = 0; i < coreCount; i++) {
      const io = i * 7;
      const ia = i * 3;
      for (let j = i + 1; j < coreCount; j++) {
        const jo = j * 7;
        const ja = j * 3;
        const dx = cores[jo + 1] - cores[io + 1];
        const dy = cores[jo + 2] - cores[io + 2];
        const dz = cores[jo + 3] - cores[io + 3];
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const inv = 1 / (r2 * Math.sqrt(r2));
        const fi = g * cores[jo] * inv; // 作用在 i 上
        const fj = g * cores[io] * inv; // 作用在 j 上
        coreAccel[ia] += fi * dx;
        coreAccel[ia + 1] += fi * dy;
        coreAccel[ia + 2] += fi * dz;
        coreAccel[ja] -= fj * dx;
        coreAccel[ja + 1] -= fj * dy;
        coreAccel[ja + 2] -= fj * dz;
      }
    }
  }

  /** 粒子受所有核心的引力 */
  private computeParticleAccel(): void {
    const { position, accel, cores, coreCount, count } = this;
    const g = this.params.gravity;
    const eps2 = SOFTENING * SOFTENING;
    for (let i = 0; i < count; i++) {
      const io = i * 3;
      const px = position[io];
      const py = position[io + 1];
      const pz = position[io + 2];
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let j = 0; j < coreCount; j++) {
        const jo = j * 7;
        const dx = cores[jo + 1] - px;
        const dy = cores[jo + 2] - py;
        const dz = cores[jo + 3] - pz;
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const inv = (g * cores[jo]) / (r2 * Math.sqrt(r2));
        ax += inv * dx;
        ay += inv * dy;
        az += inv * dz;
      }
      accel[io] = ax;
      accel[io + 1] = ay;
      accel[io + 2] = az;
    }
  }

  // ---------------------------------------------------------------- 积分

  /** 单个固定步长的 Leapfrog KDK 推进 */
  step(): void {
    const dt = SIM_DT;
    const h = dt * 0.5;
    const { cores, coreAccel, coreCount, position, velocity, accel, count } =
      this;

    // 核心：kick-drift
    for (let i = 0; i < coreCount; i++) {
      const io = i * 7;
      const ia = i * 3;
      cores[io + 4] += coreAccel[ia] * h;
      cores[io + 5] += coreAccel[ia + 1] * h;
      cores[io + 6] += coreAccel[ia + 2] * h;
      cores[io + 1] += cores[io + 4] * dt;
      cores[io + 2] += cores[io + 5] * dt;
      cores[io + 3] += cores[io + 6] * dt;
    }
    // 核心位置已更新，先更新粒子（粒子不反作用于核心，顺序不影响各自确定性）

    // 粒子：kick-drift
    for (let i = 0; i < count; i++) {
      const io = i * 3;
      velocity[io] += accel[io] * h;
      velocity[io + 1] += accel[io + 1] * h;
      velocity[io + 2] += accel[io + 2] * h;
      position[io] += velocity[io] * dt;
      position[io + 1] += velocity[io + 1] * dt;
      position[io + 2] += velocity[io + 2] * dt;
    }

    // 新时刻加速度
    this.computeCoreAccel();
    this.computeParticleAccel();

    // 核心：kick
    for (let i = 0; i < coreCount; i++) {
      const io = i * 7;
      const ia = i * 3;
      cores[io + 4] += coreAccel[ia] * h;
      cores[io + 5] += coreAccel[ia + 1] * h;
      cores[io + 6] += coreAccel[ia + 2] * h;
    }

    // 粒子：kick + 速度上限兜底
    for (let i = 0; i < count; i++) {
      const io = i * 3;
      let vx = velocity[io] + accel[io] * h;
      let vy = velocity[io + 1] + accel[io + 1] * h;
      let vz = velocity[io + 2] + accel[io + 2] * h;
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 > V_MAX_SQ) {
        const s = V_MAX / Math.sqrt(v2);
        vx *= s;
        vy *= s;
        vz *= s;
      }
      velocity[io] = vx;
      velocity[io + 1] = vy;
      velocity[io + 2] = vz;
    }

    this.stepCount++;
    this.time += dt;
  }

  /** 刷新速率标量缓存（每渲染帧调用一次即可） */
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
}

/** 兼容旧引用（check-sim 等） */
export { NBodySimulation as Simulation };
