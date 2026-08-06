import * as THREE from 'three';
import type { ParticleSimulation } from './simulation-interface';
import type { Simulation } from './simulation';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * 发光粒子渲染：双渲染层。
 *
 * - 普通层（星尘 + 普通恒星，约 95%）：NormalBlending，不参与强光叠加，
 *   中心密度再高也不会堆成纯白圆斑。
 * - 高亮层（5% 高亮恒星 + 核心辉光点）：AdditiveBlending，
 *   是 Bloom 的主要来源。
 *
 * 两层共享同一份 position/aSpeed BufferAttribute，用 setDrawRange 分层，
 * 每帧零拷贝零分配。
 *
 * Shader：柔边圆点；尺寸 = 恒星类别基准 px × DPR × 透视（带下限）；
 * 少数粒子缓慢闪烁（相位错开）；最终亮度有硬上限。
 */

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSpeed;
  attribute float aSize;
  attribute vec2 aTwinkle; // x: 幅度, y: 相位
  attribute vec3 aVel;

  uniform float uPixelRatio;
  uniform float uSpeedRef;
  uniform float uTime;
  uniform float uMaxLum;
  uniform float uRefDist;
  uniform float uTrail; // 流线拉伸强度（0 = 圆形点）
  uniform float uBoost; // 整体亮度增益（vortex 用，galaxy 保持 1.0）

  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vDir;  // 屏幕空间速度方向
  varying float vLen; // 拉伸系数

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec4 clip1 = projectionMatrix * mv;

    float speedNorm = clamp(aSpeed / uSpeedRef, 0.0, 1.6);

    // 屏幕空间速度方向与拉伸系数
    vLen = 0.0;
    vDir = vec2(1.0, 0.0);
    if (uTrail > 0.001 && aSpeed > 0.001) {
      vec4 mv2 = modelViewMatrix * vec4(position + aVel, 1.0);
      vec4 clip2 = projectionMatrix * mv2;
      vec2 s1 = clip1.xy / clip1.w;
      vec2 s2 = clip2.xy / clip2.w;
      vec2 d = s2 - s1;
      float dl = length(d);
      if (dl > 1e-6) vDir = d / dl;
      vLen = clamp(speedNorm * uTrail, 0.0, 2.5);
    }

    // 基准尺寸 × 速度微调 × DPR × 透视衰减；拉伸时放大点精灵容纳流线
    float size = aSize * (0.85 + speedNorm * 0.25) * (1.0 + vLen);
    gl_PointSize = clamp(
      size * uPixelRatio * (uRefDist / -mv.z),
      0.5 * uPixelRatio,
      9.0 * uPixelRatio * (1.0 + vLen)
    );

    // 缓慢克制的闪烁（amp=0 的粒子不受影响）
    float tw = 1.0 + aTwinkle.x * sin(uTime * 0.6 + aTwinkle.y);

    vec3 col = aColor * (0.55 + 0.5 * speedNorm) * tw * uBoost;

    // 亮度硬上限：任何粒子都不许爆白
    float lum = max(max(col.r, col.g), col.b);
    if (lum > uMaxLum) col *= uMaxLum / lum;

    vColor = col;
    vAlpha = min((0.62 + 0.3 * min(speedNorm, 1.0)) * uBoost, 1.0);

    gl_Position = clip1;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform float uAlphaScale;

  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vDir;
  varying float vLen;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);

    float a;
    if (vLen > 0.02) {
      // 流线：沿速度方向的椭圆高斯
      float along = dot(uv, vDir);
      float across = dot(uv, vec2(-vDir.y, vDir.x));
      float rb = 0.5 / (1.0 + vLen); // 横向半径（quad 单位）
      float ra = rb * (1.0 + vLen);  // 纵向半径
      float e = (along * along) / (ra * ra) + (across * across) / (rb * rb);
      a = exp(-3.5 * e) * vAlpha;
      if (e > 1.0) discard;
    } else {
      // 柔边圆点：从中心向边缘幂次衰减，避免方形像素感
      float d = length(uv);
      if (d > 0.5) discard;
      float glow = smoothstep(0.5, 0.0, d);
      glow = pow(glow, 2.2);
      float core = smoothstep(0.15, 0.0, d) * 0.5;
      a = (glow + core) * vAlpha;
    }
    gl_FragColor = vec4(vColor, a * uAlphaScale);
  }
`;

function createStarMaterial(
  pixelRatio: number,
  blending: THREE.Blending,
  alphaScale: number,
  speedRef = 18.0,
  boost = 1.0,
  maxLum = 1.1
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uSpeedRef: { value: speedRef },
      uTime: { value: 0 },
      uMaxLum: { value: maxLum },
      uRefDist: { value: 68.0 },
      uAlphaScale: { value: alphaScale },
      uTrail: { value: 0 },
      uBoost: { value: boost },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending,
  });
}

export interface StarField {
  /** 普通星体层（NormalBlending） */
  normal: THREE.Points;
  /** 高亮星体层（AdditiveBlending，Bloom 主力） */
  bright: THREE.Points;
  /** 每帧：同步模拟数据与闪烁时间（就地更新，零分配） */
  sync(time: number): void;
  /** 设置高亮层流线拉伸强度（0 = 圆形点；普通层恒为 0） */
  setTrail(v: number): void;
  dispose(): void;
}

/** 示踪粒子：普通层 + 高亮层，共享 attribute，drawRange 分层 */
export function createStarField(
  sim: ParticleSimulation,
  pixelRatio: number,
  opts?: { speedRef?: number; boost?: number; brightMaxLum?: number; dynamicColor?: boolean }
): StarField {
  const speedRef = opts?.speedRef ?? 18.0;
  const boost = opts?.boost ?? 1.0;
  const dynamicColor = opts?.dynamicColor ?? false;
  const posAttr = new THREE.BufferAttribute(sim.position, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);

  const velAttr = new THREE.BufferAttribute(sim.velocity, 3);
  velAttr.setUsage(THREE.DynamicDrawUsage);

  const speedAttr = new THREE.BufferAttribute(sim.speed, 1);
  speedAttr.setUsage(THREE.DynamicDrawUsage);

  const colorAttr = new THREE.BufferAttribute(sim.color, 3);
  // vortex 颜色每物理步按半径刷新，需要动态上传；galaxy 颜色静态
  if (dynamicColor) colorAttr.setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(sim.starSize, 1);
  const twinkleAttr = new THREE.BufferAttribute(sim.twinkle, 2);

  // 普通层：索引 [0, brightStart)
  const normalGeo = new THREE.BufferGeometry();
  normalGeo.setAttribute('position', posAttr);
  normalGeo.setAttribute('aVel', velAttr);
  normalGeo.setAttribute('aSpeed', speedAttr);
  normalGeo.setAttribute('aColor', colorAttr);
  normalGeo.setAttribute('aSize', sizeAttr);
  normalGeo.setAttribute('aTwinkle', twinkleAttr);
  normalGeo.setDrawRange(0, sim.brightStart);
  const normalMat = createStarMaterial(pixelRatio, THREE.NormalBlending, 1.0, speedRef, boost);
  const normal = new THREE.Points(normalGeo, normalMat);
  normal.frustumCulled = false;

  // 高亮层：索引 [brightStart, n)
  const brightGeo = new THREE.BufferGeometry();
  brightGeo.setAttribute('position', posAttr);
  brightGeo.setAttribute('aVel', velAttr);
  brightGeo.setAttribute('aSpeed', speedAttr);
  brightGeo.setAttribute('aColor', colorAttr);
  brightGeo.setAttribute('aSize', sizeAttr);
  brightGeo.setAttribute('aTwinkle', twinkleAttr);
  brightGeo.setDrawRange(sim.brightStart, sim.count - sim.brightStart);
  const brightMat = createStarMaterial(
    pixelRatio,
    THREE.AdditiveBlending,
    0.9,
    speedRef,
    boost,
    opts?.brightMaxLum ?? 1.1
  );
  const bright = new THREE.Points(brightGeo, brightMat);
  bright.frustumCulled = false;

  return {
    normal,
    bright,
    sync(time: number) {
      posAttr.needsUpdate = true;
      velAttr.needsUpdate = true;
      speedAttr.needsUpdate = true;
      if (dynamicColor) colorAttr.needsUpdate = true;
      normalMat.uniforms.uTime.value = time;
      brightMat.uniforms.uTime.value = time;
    },
    setTrail(v: number) {
      brightMat.uniforms.uTrail.value = v;
    },
    dispose() {
      normalGeo.dispose();
      brightGeo.dispose();
      normalMat.dispose();
      brightMat.dispose();
    },
  };
}

export interface CoreGlow {
  points: THREE.Points;
  /** 每帧同步核心位置 */
  sync(time: number): void;
  dispose(): void;
}

/** 引力核心的辉光点（Additive，温暖克制，参与 Bloom） */
export function createCoreGlow(sim: Simulation, pixelRatio: number): CoreGlow {
  const k = sim.coreCount;
  const geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(k * 3);
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);

  // 核心点：温暖、中等亮度，不是小太阳
  const speeds = new Float32Array(k).fill(7);
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

  const colors = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) {
    colors[i * 3] = 0.85;
    colors[i * 3 + 1] = 0.68;
    colors[i * 3 + 2] = 0.45;
  }
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

  const sizes = new Float32Array(k).fill(6.5);
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const twinkle = new Float32Array(k * 2); // 不闪烁
  geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 2));

  const vels = new Float32Array(k * 3); // 核心点不做流线拉伸
  geometry.setAttribute('aVel', new THREE.BufferAttribute(vels, 3));

  const material = createStarMaterial(pixelRatio, THREE.AdditiveBlending, 0.8);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  function sync(time: number) {
    for (let i = 0; i < k; i++) {
      positions[i * 3] = sim.cores[i * 7 + 1];
      positions[i * 3 + 1] = sim.cores[i * 7 + 2];
      positions[i * 3 + 2] = sim.cores[i * 7 + 3];
    }
    posAttr.needsUpdate = true;
    material.uniforms.uTime.value = time;
  }

  sync(0);

  return {
    points,
    sync,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export interface EnergyHaze {
  mesh: THREE.Mesh;
  /** 每帧同步流动时间（噪声漂移，雾是活的） */
  sync(time: number): void;
  dispose(): void;
}

/**
 * Inner Energy Volume：球体内部的查克拉体积雾（不是外壳）。
 * BackSide 球面 + 视角中心亮/边缘暗的体积衰减 + 双层 fBm 噪声随时间漂移，
 * 不均匀、缓慢流动，峰值 alpha 0.06，没有完整边缘，不像玻璃罩，不参与 Bloom。
 */
export function createEnergyHaze(radius: number): EnergyHaze {
  const geometry = new THREE.SphereGeometry(radius * 0.98, 64, 48);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vObjPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalMatrix * normal;
        vViewDir = -mv.xyz;
        vObjPos = normalize(position);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vObjPos;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash(i);
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));
        return mix(
          mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
          mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
          f.z
        );
      }
      float fbm(vec3 p) {
        return vnoise(p) * 0.55 + vnoise(p * 2.3) * 0.3 + vnoise(p * 5.1) * 0.15;
      }

      void main() {
        // 体积感：视线穿过球心方向最厚（亮），边缘最薄（暗），无清晰轮廓
        float f = abs(dot(normalize(vNormal), normalize(vViewDir)));
        // 双层噪声随时间反向漂移：不均匀、缓慢流动的能量体
        float n1 = fbm(vObjPos * 3.0 + vec3(uTime * 0.05, uTime * 0.04, -uTime * 0.045));
        float n2 = fbm(vObjPos * 6.5 - vec3(uTime * 0.03, -uTime * 0.035, uTime * 0.025));
        float n = n1 * 0.7 + n2 * 0.3;
        // 噪声阈值制造局部缺口，不允许形成完整壳层
        float mask = smoothstep(0.3, 0.75, n);
        float a = f * f * mask * 0.05 + f * f * n * 0.012;
        // 外层深蓝 #0A67FF → 主体蓝 #3BB8FF（不用青白，保持通透的蓝）
        vec3 col = mix(vec3(0.039, 0.404, 1.0), vec3(0.231, 0.722, 1.0), n);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return {
    mesh,
    sync(time: number) {
      material.uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------- 中心光晕

export interface VortexCore {
  mesh: THREE.Mesh;
  /** 每帧同步流动时间（核心缓慢旋动，表现压缩聚核） */
  sync(time: number): void;
  /** 白色核心半径（相对球半径 R，默认 0.1），实时生效 */
  setWhiteRadius(rn: number): void;
  dispose(): void;
}

/**
 * Core Compression：小型高密度查克拉核心——白色只被允许出现在这里。
 * billboard：rn < uWhiteRadius 内接近 #F7FEFF（面积很小），
 * 之外立刻过渡回高饱和蓝 #3BB8FF 并快速衰减透明；
 * 随时间缓慢旋动的噪声纹理保留内部颗粒层次，不成纯白圆洞。
 */
export function createVortexCore(radius: number): VortexCore {
  const size = radius * 0.44; // 半宽 0.22R：d = length(uv)·2 → rn = d·0.22
  const geometry = new THREE.PlaneGeometry(size, size);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWhiteRadius: { value: 0.1 }, // 相对 R
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // billboard：抵消模型旋转，始终面向相机
        vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(
          length(vec3(modelMatrix[0])),
          length(vec3(modelMatrix[1]))
        );
        vec4 mv = center + vec4((position.xy) * scale, 0.0, 0.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform float uTime;
      uniform float uWhiteRadius;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec2 uv = vUv - vec2(0.5);
        float d = length(uv) * 2.0; // 0 中心 → 1 平面边缘（=0.3R）
        if (d > 1.0) discard;
        float rn = d * 0.22; // 相对球半径
        // 压缩高斯（中心更紧实）+ 缓慢旋动的噪声纹理（内部颗粒层次）
        float g = exp(-18.0 * d * d);
        float ang = uTime * 0.22;
        float ca = cos(ang);
        float sa = sin(ang);
        vec2 ruv = vec2(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca);
        // 径向拉伸噪声 → 旋涡状纹理，表现「压缩汇聚」而不是均匀光斑
        float n = vnoise(vec2(ruv.x * 10.0, ruv.y * 22.0) + vec2(uTime * 0.1)) * 0.5
                + vnoise(vec2(ruv.x * 24.0, ruv.y * 48.0) - vec2(uTime * 0.07)) * 0.5;
        float tex = 0.75 + 0.25 * n;
        // 白色核心是小而亮的点：0.25·uWhiteRadius 内全白，到 0.55·uWhiteRadius
        // 就过渡回高饱和蓝并消失——白色只是一个亮点，不是棉球
        float w = 1.0 - smoothstep(uWhiteRadius * 0.25, uWhiteRadius * 0.55, rn);
        vec3 col = mix(vec3(0.231, 0.722, 1.0), vec3(0.93, 0.98, 1.0), w);
        float a = g * tex * (0.004 + 0.4 * w * w * w);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return {
    mesh,
    sync(time: number) {
      material.uniforms.uTime.value = time;
    },
    setWhiteRadius(rn: number) {
      material.uniforms.uWhiteRadius.value = rn;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------- 真实流线

/** 默认轨迹条数（V6：辅助能量丝 24~48 条；Ribbon Amount 可调重建）与历史深度 */
const TRAIL_COUNT = 36;
const TRAIL_HISTORY = 160;
/** 记录间隔（模拟秒）：跟随模拟时间，与播放速度解耦 */
const TRAIL_DT = 1 / 60;
/** 三组轨迹：外层长弧 40% / 中层弯折弧 35% / 核心短旋流 25%，各自持续倍率 */
const TRAIL_GROUPS = [
  { share: 0.4, rMin: 0.65, rMax: 99, persist: 1.0 }, // 外层长弧
  { share: 0.35, rMin: 0.35, rMax: 0.65, persist: 0.85 }, // 中层弯折弧
  { share: 0.25, rMin: 0, rMax: 0.35, persist: 0.6 }, // 核心高密度短旋流
];

export interface TrailRenderer {
  object: THREE.Object3D;
  /**
   * 每渲染帧调用：按模拟时间 60Hz 记录历史位置并刷新线段。
   * 跟随 sim.time——Time Scale 降低时弧线空间长度不变，
   * 暂停时历史冻结、长弧保持可见。
   */
  sync(simTime: number): void;
  /** 轨迹持续时间（模拟秒），实时生效 */
  setPersistence(seconds: number): void;
  /** 流线亮度倍率（只控制明暗，不改色相），实时生效 */
  setBrightness(v: number): void;
  /** 蓝色饱和度倍率（围绕 luma 缩放族基础色），实时生效 */
  setSaturation(v: number): void;
  /** 轨迹宽度 px，实时生效 */
  setWidth(px: number): void;
  /** 流动亮纹滚动速度（波形/秒，0 = 静止），实时生效 */
  setScrollSpeed(v: number): void;
  /** 视口尺寸变化时更新 LineMaterial.resolution */
  setResolution(width: number, height: number): void;
  dispose(): void;
}

/**
 * 辅助能量丝（V6 起降级为辅助层，主视觉是 ChakraVolume 体积 Shader）：
 * 挑选 24~48 个代表 Flow 粒子，保存最近 160 个 60Hz 采样的历史位置，
 * 用 LineSegments2（fat lines，细线 0.6~1.2px）绘制短弧与局部能量丝。
 * 每个历史间隔输出 2 段（Catmull-Rom 中点平滑），禁止折角；
 * 透明度低于体积主体，不勾勒完整球壳。
 * 颜色系统（V4）：色相 = 粒子所属轨道族的稳定基础色（init 分配，全程不变），
 * 半径只控制亮度（外暗内亮），头部更亮但仍然是蓝——白色只属于核心层；
 * 回收重生跳变时单条轨迹清零重记。
 * Trail Persistence 只控制可见段数，与物理速度完全解耦。
 */
export function createTrailRenderer(sim: ParticleSimulation, count = TRAIL_COUNT): TrailRenderer {
  const T = count;
  const H = TRAIL_HISTORY;

  // 代表粒子：按初始半径分三组确定性抽样——外层长弧 / 中层弯折弧 / 核心短旋流。
  // 不做径向速度过滤——向心压缩模型下 Flow 粒子本来就要螺旋潜入核心，
  // 轨迹向内汇聚正是主视觉。
  const pool = sim.brightStart;
  const indices = new Int32Array(T);
  const persistMul = new Float32Array(T);
  let maxR = 1e-6;
  {
    const pos = sim.position;
    // 第一遍：估计球半径（pool 内 Flow 粒子最大半径 ≈ 1.0R）
    for (let i = 0; i < pool; i++) {
      const io = i * 3;
      const r = Math.hypot(pos[io], pos[io + 1], pos[io + 2]);
      if (r > maxR) maxR = r;
    }
    // 第二遍：按半径带分桶
    const buckets: number[][] = TRAIL_GROUPS.map(() => []);
    for (let i = 0; i < pool; i++) {
      const io = i * 3;
      const r = Math.hypot(pos[io], pos[io + 1], pos[io + 2]);
      const rn = r / maxR;
      for (let b = 0; b < TRAIL_GROUPS.length; b++) {
        if (rn >= TRAIL_GROUPS[b].rMin && rn < TRAIL_GROUPS[b].rMax) {
          buckets[b].push(i);
          break;
        }
      }
    }
    let cursor = 0;
    for (let b = 0; b < TRAIL_GROUPS.length; b++) {
      const list = buckets[b];
      const want =
        b === TRAIL_GROUPS.length - 1 ? T - cursor : Math.round(T * TRAIL_GROUPS[b].share);
      if (list.length === 0) continue;
      // 等距步长确定性抽样（步长与桶长互质概率高，简单打散）
      const stride = Math.max(1, Math.floor(list.length / Math.max(want, 1)) | 1);
      let picked = 0;
      let idx = 0;
      while (picked < want && cursor < T && idx < list.length * 2) {
        indices[cursor] = list[idx % list.length];
        persistMul[cursor] = TRAIL_GROUPS[b].persist;
        cursor++;
        picked++;
        idx += stride;
      }
    }
    // 桶不足时兜底填满
    while (cursor < T) {
      indices[cursor] = cursor % pool;
      persistMul[cursor] = 1.0;
      cursor++;
    }
  }
  // 位置跳变阈值：Flow 粒子回收重生到外缘时历史出现跳变，需重置该条轨迹
  const jumpThresh2 = (0.7 * maxR) * (0.7 * maxR);

  // 每条轨迹的稳定基础色：取自代表粒子所属轨道族的族色（运动全程不变）
  const trailBase = new Float32Array(T * 3);
  {
    const fam = sim.particleFamily;
    const fc = sim.famColors;
    for (let t = 0; t < T; t++) {
      if (fam && fc) {
        const g = fam[indices[t]] * 3;
        trailBase[t * 3] = fc[g];
        trailBase[t * 3 + 1] = fc[g + 1];
        trailBase[t * 3 + 2] = fc[g + 2];
      } else {
        // 接口未提供族色时回退主体蓝 #3BB8FF
        trailBase[t * 3] = 0.231;
        trailBase[t * 3 + 1] = 0.722;
        trailBase[t * 3 + 2] = 1.0;
      }
    }
  }

  // 历史环形缓冲 [T][H][3]，cursor 指向最新一格；每条轨迹独立 filled
  // （回收重生跳变时单条清零，不影响其他轨迹）
  const history = new Float32Array(T * H * 3);
  const filledT = new Uint16Array(T);
  let cursor = -1;
  let lastSimTime = -1;
  let persistence = 1.5;
  let brightness = 1.0;
  let saturation = 1.4;
  let scrollSpeed = 0.8;
  let refreshTime = 0;

  const geometry = new LineSegmentsGeometry();
  // 每个历史间隔输出 2 段（Catmull-Rom 中点平滑，禁止折角）
  const SUB = 2;
  const segCount = T * (H - 1) * SUB;
  // 交错布局：每段 [start xyz, end xyz]，一次分配，之后就地更新
  const positions = new Float32Array(segCount * 6);
  const colors = new Float32Array(segCount * 6);
  geometry.setPositions(positions);
  geometry.setColors(colors);
  // 直接写底层 InterleavedBuffer，每帧零分配
  const posAttr = geometry.getAttribute('instanceStart') as unknown as THREE.InterleavedBufferAttribute;
  const colAttr = geometry.getAttribute('instanceColorStart') as unknown as THREE.InterleavedBufferAttribute;
  const posBuf = posAttr.data.array as Float32Array;
  const colBuf = colAttr.data.array as Float32Array;

  const material = new LineMaterial({
    linewidth: 0.9, // px：V6 辅助能量丝，细而克制
    vertexColors: true,
    transparent: true,
    opacity: 0.4, // 低于体积主体：线条只是辅助，不能勾勒球壳
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.resolution.set(window.innerWidth, window.innerHeight);

  const object = new LineSegments2(geometry, material);
  object.frustumCulled = false;

  function record(): void {
    cursor = (cursor + 1) % H;
    const pos = sim.position;
    for (let t = 0; t < T; t++) {
      const io = indices[t] * 3;
      const nx = pos[io];
      const ny = pos[io + 1];
      const nz = pos[io + 2];
      // 回收重生跳变检测：与上一格距离过远 → 该条轨迹历史清零重记，
      // 避免画出一条横跨球体的直线
      if (filledT[t] > 0) {
        const lo = (t * H + ((cursor - 1 + H) % H)) * 3;
        const dx = nx - history[lo];
        const dy = ny - history[lo + 1];
        const dz = nz - history[lo + 2];
        if (dx * dx + dy * dy + dz * dz > jumpThresh2) filledT[t] = 0;
      }
      const ho = (t * H + cursor) * 3;
      history[ho] = nx;
      history[ho + 1] = ny;
      history[ho + 2] = nz;
      if (filledT[t] < H) filledT[t]++;
    }
  }

  // 段颜色 = 族稳定基础色 × 饱和度 × 半径亮度 × 头部衰减 × 亮度倍率。
  // 色相全程固定（尾与头同一个蓝），半径只控制明暗——解除「半径 → 色相」绑定，
  // 头部可以更亮，但永远是蓝色，白色只属于独立的 Core Compression 核心层。
  /** 半径 → 亮度（核心 0.68 → 外缘 0.55），色相不变。
   *  内层弧线投影密度高，亮度随密度反压——宁可密处稳蓝，不可叠出青白；
   *  外缘保持 0.55 高保底——长弧全程可读，不会断成一截截亮斑 */
  function depthLum(hx: number, hy: number, hz: number): number {
    const rn = Math.min(Math.sqrt(hx * hx + hy * hy + hz * hz) / maxR, 1.2);
    return 0.68 - 0.13 * Math.min(rn / 0.9, 1);
  }

  function refresh(): void {
    // 基准可见段数：persistence 秒 × 60Hz，最少 4 段；每条轨迹再乘所在组倍率
    const baseVisible = Math.max(4, Math.min(H - 1, Math.round(persistence / TRAIL_DT)));
    // 流动亮纹相位推进：waves·(u + t·speed)，沿轨迹向头部（核心）奔跑
    const scroll = scrollSpeed * refreshTime;
    // 头部最亮 → 尾部渐隐（additive：黑即透明）；
    // 0.32 亮度地板 + 平缓指数：弧线全程连续可见，尾部只是略暗
    const fade = (x: number, visible: number): number =>
      Math.max(Math.pow(1 - x / visible, 0.55), 0.32);
    const wave = (x: number, visible: number, phase: number): number =>
      scrollSpeed > 0
        ? 0.82 + 0.4 * Math.pow(0.5 + 0.5 * Math.sin(6.2832 * ((x / visible) * 2 + scroll + phase)), 2)
        : 1;

    let seg = 0;
    for (let t = 0; t < T; t++) {
      // 族基础色 × 蓝色饱和度（围绕 luma 缩放；>1 更饱和）
      const br = trailBase[t * 3];
      const bg = trailBase[t * 3 + 1];
      const bb = trailBase[t * 3 + 2];
      let cr = br;
      let cg = bg;
      let cb = bb;
      if (saturation !== 1) {
        const luma = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
        cr = Math.max(0, luma + (br - luma) * saturation);
        cg = Math.max(0, luma + (bg - luma) * saturation);
        cb = Math.min(1, luma + (bb - luma) * saturation);
      }
      // 饱和度钳制：G ≤ 0.62B、R ≤ 0.42B——钳得比通道均值更狠，
      // additive 多层叠加 + ACES 高光去饱和后仍是电光蓝，不漂成青白
      if (cg > cb * 0.62) cg = cb * 0.62;
      if (cr > cb * 0.42) cr = cb * 0.42;

      const visible = Math.max(4, Math.round(baseVisible * persistMul[t]));
      // 每条轨迹的亮纹相位（确定性打散，不同步闪动）
      const phase = (t * 0.6180339887) % 1;
      const ft = filledT[t];
      for (let s = 0; s < H - 1; s++) {
        // s=0 为最新段（头），s 越大越旧（尾）
        const h0 = (t * H + ((cursor - s + 1 + H * 2) % H)) * 3; // 更新一格（s=0 时同 h1）
        const h1 = (t * H + ((cursor - s + H * 2) % H)) * 3;
        const h2 = (t * H + ((cursor - s - 1 + H * 2) % H)) * 3;
        const h3 = (t * H + ((cursor - s - 2 + H * 2) % H)) * 3;
        const p1x = history[h1];
        const p1y = history[h1 + 1];
        const p1z = history[h1 + 2];
        const p2x = history[h2];
        const p2y = history[h2 + 1];
        const p2z = history[h2 + 2];
        // Catmull-Rom 中点（t=0.5）：0.5625·(p1+p2) − 0.0625·(p0+p3)，
        // 每个历史间隔输出 p1→m、m→p2 两段，折角被磨圆
        const mx = 0.5625 * (p1x + p2x) - 0.0625 * (history[h0] + history[h3]);
        const my = 0.5625 * (p1y + p2y) - 0.0625 * (history[h0 + 1] + history[h3 + 1]);
        const mz = 0.5625 * (p1z + p2z) - 0.0625 * (history[h0 + 2] + history[h3 + 2]);

        let f1 = 0;
        let fm = 0;
        let f2 = 0;
        // 段 s 连接采样点 s 与 s+1：两个采样都已记录才可见（s+1 < ft）
        if (s + 1 < ft && s < visible) {
          f1 = fade(s, visible) * wave(s, visible, phase);
          fm = fade(s + 0.5, visible) * wave(s + 0.5, visible, phase);
          f2 = fade(s + 1, visible) * wave(s + 1, visible, phase);
        }
        const m1 = f1 * depthLum(p1x, p1y, p1z) * brightness;
        const mm = fm * depthLum(mx, my, mz) * brightness;
        const m2 = f2 * depthLum(p2x, p2y, p2z) * brightness;

        const p6 = seg * 6;
        // 段 1：p1 → m
        posBuf[p6] = p1x;
        posBuf[p6 + 1] = p1y;
        posBuf[p6 + 2] = p1z;
        posBuf[p6 + 3] = mx;
        posBuf[p6 + 4] = my;
        posBuf[p6 + 5] = mz;
        colBuf[p6] = cr * m1;
        colBuf[p6 + 1] = cg * m1;
        colBuf[p6 + 2] = cb * m1;
        colBuf[p6 + 3] = cr * mm;
        colBuf[p6 + 4] = cg * mm;
        colBuf[p6 + 5] = cb * mm;
        // 段 2：m → p2
        const q6 = p6 + 6;
        posBuf[q6] = mx;
        posBuf[q6 + 1] = my;
        posBuf[q6 + 2] = mz;
        posBuf[q6 + 3] = p2x;
        posBuf[q6 + 4] = p2y;
        posBuf[q6 + 5] = p2z;
        colBuf[q6] = cr * mm;
        colBuf[q6 + 1] = cg * mm;
        colBuf[q6 + 2] = cb * mm;
        colBuf[q6 + 3] = cr * m2;
        colBuf[q6 + 4] = cg * m2;
        colBuf[q6 + 5] = cb * m2;
        seg += 2;
      }
    }
    posAttr.data.needsUpdate = true;
    colAttr.data.needsUpdate = true;
  }

  return {
    object,
    sync(simTime: number) {
      // 跟随模拟时间 60Hz 采样：暂停（时间冻结）不记录，长弧冻结保留
      if (lastSimTime < 0) lastSimTime = simTime - TRAIL_DT;
      if (simTime < lastSimTime) lastSimTime = simTime - TRAIL_DT; // reset 后对齐
      while (lastSimTime + TRAIL_DT <= simTime) {
        record();
        lastSimTime += TRAIL_DT;
      }
      refreshTime = simTime;
      refresh();
    },
    setPersistence(seconds: number) {
      persistence = Math.max(0.05, seconds);
    },
    setBrightness(v: number) {
      brightness = v;
    },
    setSaturation(v: number) {
      saturation = v;
    },
    setWidth(px: number) {
      material.linewidth = px;
    },
    setScrollSpeed(v: number) {
      scrollSpeed = v;
    },
    setResolution(width: number, height: number) {
      material.resolution.set(width, height);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
