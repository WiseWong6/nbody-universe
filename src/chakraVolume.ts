// ---------------------------------------------------------------- Chakra Volume
// V6 主视觉：球体 Raymarch 体积 Shader——连续蓝白查克拉能量体，
// 不再是 LineSegments2 历史轨迹堆出的「铁丝团」。
//
// 密度构成：
//   3D fBm + domain warping 能量纹理 × 径向剖面（中心密、外缘破碎半透明）
//   × Formation 径向显现遮罩（中心先形成，再向外扩张）
//
// 旋转（不按半径锁定经纬线，采样坐标整体旋转）：
//   omega(r) = mix(coreSpeed, outerSpeed, pow(r/R, 0.7))   核心快、外围慢
//   两个不同轴向/速度的旋转域叠加 + 轻微径向向内滚动
//   → 不规则但统一围绕核心的旋涡，无经纬线、无原子轨道
//
// Formation（独立于粒子物理）：
//   progress = clamp(time / formationDuration, 0, 1)
//   reveal   = 1 - smoothstep(progress - feather, progress, r/R)
//   0~0.5s 核心出现并旋转；0.5~2.5s 能量体扩张到外缘；之后稳态。

import * as THREE from 'three';

export interface ChakraVolume {
  object: THREE.Object3D;
  /** 每渲染帧调用：驱动旋转/滚动/Formation 进度（跟随 sim.time，暂停即冻结） */
  sync(simTime: number): void;
  /** 内层/外层旋转速度（rad/s，coreSpeed 必须 > outerSpeed），实时生效 */
  setSpin(coreSpeed: number, outerSpeed: number): void;
  /** 体积密度倍率，实时生效 */
  setDensity(v: number): void;
  /** 湍流扰动强度（domain warp 幅度），实时生效 */
  setTurbulence(v: number): void;
  /** Formation 时长（模拟秒），实时生效 */
  setFormationDuration(seconds: number): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec3 vPos; // 球面进入点（物体空间，球心在原点）
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vPos;

uniform float uTime;
uniform float uRadius;
uniform float uCoreSpeed;   // 核心角速度 rad/s
uniform float uOuterSpeed;  // 外缘角速度 rad/s
uniform float uDensity;     // 密度倍率
uniform float uTurb;        // domain warp 幅度
uniform float uProgress;    // Formation 进度 0~1

// 配色（需求指定，白色只存在于小型核心与极少数高亮纹理）
const vec3 C_CORE  = vec3(0.969, 0.996, 1.0);   // #F7FEFF
const vec3 C_INNER = vec3(0.659, 0.953, 1.0);   // #A8F3FF
const vec3 C_MID   = vec3(0.231, 0.722, 1.0);   // #3BB8FF
const vec3 C_OUTER = vec3(0.039, 0.404, 1.0);   // #0A67FF
const vec3 C_DARK  = vec3(0.0,   0.106, 0.353); // #001B5A

const int STEPS = 26;

// ---- 3D value noise + fBm ----
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i);
  float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) { // 3 倍频：避免亚像素颗粒噪点（沙化）
    v += a * vnoise(p);
    p = p * 2.13 + vec3(7.7, 3.1, 9.2);
    a *= 0.5;
  }
  return v;
}

// Rodrigues 旋转
vec3 rotAxis(vec3 p, vec3 axis, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

// 半径相关角速度：核心快、外围慢
float omega(float rn, float k) {
  return mix(uCoreSpeed * k, uOuterSpeed * k, pow(rn, 0.7));
}

// 能量密度采样（q 物体空间，rn = |q|/R 已算好）
float chakraDensity(vec3 q, float rn) {
  float t = uTime;
  // 两个不同轴向/速度的缓慢旋转域 + 轻微径向向内滚动
  vec3 axisA = vec3(0.31, 0.90, 0.30);
  vec3 axisB = vec3(0.94, 0.20, -0.28);
  float scroll = 1.0 + 0.22 * t; // 采样半径随时间增大 → 纹理向核心滚动
  // 静态螺旋扭转：剪切角 ∝ 1/(r+0.25)，把各向同性噪声拉成围绕核心的旋涡条纹
  float twist = 1.35 / (rn + 0.25);
  vec3 qA = rotAxis(q, axisA, omega(rn, 1.0) * t + twist) * (scroll * 1.1 / uRadius * 24.0);
  vec3 qB = rotAxis(q, axisB, -omega(rn, 0.62) * t - twist * 0.7) * (scroll * 1.9 / uRadius * 24.0);
  // domain warping：让纹理出现不规则卷动而非均匀条纹
  float w = uTurb * 6.0;
  vec3 warp = vec3(
    fbm(qA * 0.9 + vec3(3.7, 1.3, 8.1)),
    fbm(qA * 0.9 + vec3(9.2, 5.5, 2.8)),
    fbm(qA * 0.9 + vec3(1.1, 7.9, 4.4))
  ) - 0.5;
  float n1 = fbm(qA + warp * w);
  float n2 = fbm(qB - warp * w * 0.6);
  float n = 0.62 * n1 + 0.48 * n2;
  n = pow(n, 1.5); // 拉开对比：亮纹更亮、暗缝更暗

  // 径向剖面：中心高密度核 + 主体 + 外缘破碎衰减。
  // 噪声对比拉高（broken²）：必须看到疏密、断裂与暗缝，不是均匀实心球
  float core = exp(-rn * rn * 26.0) * (0.25 + 0.4 * n);
  float body = smoothstep(1.02, 0.58, rn) * 0.85;
  float broken = smoothstep(0.3, 0.72, n);
  float d = core + body * (0.18 + 0.82 * broken * broken) * (0.3 + 0.7 * n);

  // Formation 径向显现遮罩：中心先形成，再向外扩张
  float feather = 0.22;
  float reveal = 1.0 - smoothstep(uProgress - feather, uProgress, rn);
  return max(d * reveal, 0.0);
}

// 半径 → 颜色：核心暖白 → 内层青 → 主体蓝 → 外层钴蓝 → 暗部深蓝黑
vec3 chakraColor(float rn, float d) {
  vec3 c = mix(C_DARK, C_OUTER, smoothstep(1.05, 0.8, rn));
  c = mix(c, C_MID, smoothstep(0.68, 0.45, rn));
  c = mix(c, C_INNER, smoothstep(0.15, 0.06, rn));
  c = mix(c, C_CORE, smoothstep(0.07, 0.02, rn)); // 白色只在很小的核心
  // 极少数高亮纹理：密度峰值处轻微提亮（仍是蓝，不漂全白）
  c += C_INNER * smoothstep(0.85, 1.3, d) * 0.3;
  return c;
}

void main() {
  vec3 ro = cameraPosition; // three 内置 uniform（世界空间；球心在原点，世界=物体空间）
  vec3 rd = normalize(vPos - ro);

  // 射线与球求交（物体空间球心在原点）
  float b = dot(ro, rd);
  float c = dot(ro, ro) - uRadius * uRadius;
  float h = b * b - c;
  if (h < 0.0) discard;
  h = sqrt(h);
  float tNear = max(-b - h, 0.0);
  float tFar = -b + h;
  // 从球面进入点开始（vPos 即进入点），略微抖动消除条带
  float jitter = hash3(vPos * 13.7);
  float stepLen = (tFar - tNear) / float(STEPS);
  float t = tNear + stepLen * jitter;

  vec3 col = vec3(0.0);
  float acc = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 q = ro + rd * t;
    float rn = length(q) / uRadius;
    float d = chakraDensity(q, rn) * uDensity;
    if (d > 0.003) {
      float a = 1.0 - exp(-d * stepLen * 0.24);
      vec3 sc = chakraColor(rn, d);
      col += (1.0 - acc) * a * sc;
      acc += (1.0 - acc) * a;
      if (acc > 0.985) break;
    }
    t += stepLen;
  }

  // 整体上限：保持通透层次与蓝色色相，不在中心洗成淡白
  col = min(col * 0.78, vec3(1.05));
  gl_FragColor = vec4(col, clamp(acc, 0.0, 0.92));
}
`;

/**
 * 创建 Chakra Volume（V6 主视觉层）。
 * 球体 Raymarch Shader：FrontSide 球面提供进入点，26 步前向累积。
 */
export function createChakraVolume(radius: number): ChakraVolume {
  const uniforms = {
    uTime: { value: 0 },
    uRadius: { value: radius },
    uCoreSpeed: { value: 1.1 },
    uOuterSpeed: { value: 0.35 },
    uDensity: { value: 1.1 },
    uTurb: { value: 0.1 },
    uProgress: { value: 0 },
  };

  const geometry = new THREE.SphereGeometry(radius, 48, 32);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  let formationDuration = 2.5;

  return {
    object: mesh,
    sync(simTime: number) {
      uniforms.uTime.value = simTime;
      uniforms.uProgress.value = Math.min(Math.max(simTime / formationDuration, 0), 1);
    },
    setSpin(coreSpeed: number, outerSpeed: number) {
      uniforms.uCoreSpeed.value = coreSpeed;
      uniforms.uOuterSpeed.value = outerSpeed;
    },
    setDensity(v: number) {
      uniforms.uDensity.value = v;
    },
    setTurbulence(v: number) {
      uniforms.uTurb.value = v;
    },
    setFormationDuration(seconds: number) {
      formationDuration = Math.max(seconds, 0.05);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
