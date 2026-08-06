import * as THREE from 'three';

/**
 * 银河光雾层：一张躺在银河盘面上的连续发光面片（不是粒子）。
 *
 * Fragment shader 用对数螺旋臂距离场 + fBm / domain warping 生成：
 * - 疏密变化与局部断裂
 * - 不对称双臂
 * - 外侧逐渐变宽
 * - 旋臂内侧暗尘带
 * - 中央柔和核球光晕（带颗粒调制，亮度有上限）
 *
 * 输出亮度压到 Bloom 阈值以下，不参与强泛光。
 */

const VERT = /* glsl */ `
  varying vec2 vP;
  void main() {
    // 几何已烘到 XZ 平面，局部坐标即银河平面坐标
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  varying vec2 vP;

  uniform float uArmA;
  uniform float uArmB;
  uniform float uIntensity;
  uniform float uMaxLum;

  const float PI = 3.14159265359;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float s = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      s += amp * vnoise(p);
      p *= 2.13;
      amp *= 0.5;
    }
    return s;
  }

  void main() {
    vec2 p = vP;
    float r0 = length(p);
    if (r0 > 46.0) discard;

    // ---- domain warping：让臂形有机化（断裂、不对称、弯曲）----
    vec2 warp = vec2(
      fbm(p * 0.11 + vec2(3.1, 7.7)),
      fbm(p * 0.11 + vec2(9.2, 1.3))
    ) - 0.5;
    vec2 wp = p + warp * 4.2;
    float r = length(wp);
    float theta = atan(wp.y, wp.x);

    float armGlow = 0.0;
    float lane = 0.0;

    for (int k = 0; k < 2; k++) {
      float off = float(k) * PI;
      float asym = (k == 0) ? 1.0 : 0.74; // 不对称

      float dth = theta - log(max(r, uArmA) / uArmA) / uArmB - off;
      dth = mod(dth + PI, 2.0 * PI) - PI;
      // 到臂中心线的近似垂直距离
      float dist = r * dth * 0.94;
      // 臂宽：外侧逐渐变宽
      float w = 1.05 + r * 0.13;

      float g = exp(-dist * dist / (w * w));
      // 疏密变化与局部断裂（保持连续性，断裂克制）
      float dens = fbm(wp * 0.45 + vec2(off * 7.31, off * 2.97));
      g *= 0.35 + 1.15 * smoothstep(0.40, 0.75, dens);

      armGlow += g * asym;

      // 暗尘带：臂内侧（负 dist 侧）偏移的窄带，噪声调制断续
      float dl = (dist + w * 0.95) / (w * 0.55);
      lane += exp(-dl * dl) * asym;
    }

    // 径向包络：内侧从核球边缘淡入，外侧淡出
    float env = smoothstep(2.0, 5.5, r0) * (1.0 - smoothstep(28.0, 41.0, r0));
    float arms = armGlow * env;

    // 暗尘带只作用在旋臂区域
    float laneNoise = smoothstep(0.30, 0.68, fbm(p * 0.33 + vec2(5.0, 2.0)));
    arms *= 1.0 - 0.85 * lane * laneNoise * env;

    // ---- 中央核球：柔和高斯 + 颗粒调制 ----
    float bulge = exp(-r0 * r0 / (2.0 * 2.1 * 2.1));
    bulge *= 0.55 + 0.9 * fbm(p * 1.15 + vec2(1.0, 4.0));

    // ---- 配色：中心暖白淡金 → 旋臂冷白灰蓝 ----
    vec3 armCol = vec3(0.58, 0.67, 0.88) * arms;
    vec3 bulgeCol = vec3(1.0, 0.84, 0.56) * bulge;
    // 核球外围到旋臂的淡蓝过渡
    vec3 col = armCol + bulgeCol;
    col *= uIntensity;

    // 亮度上限：低于 Bloom 阈值，不参与强泛光
    float lum = max(col.r, max(col.g, col.b));
    if (lum > uMaxLum) col *= uMaxLum / lum;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface GlowPlane {
  mesh: THREE.Mesh;
  dispose(): void;
}

/** 创建银河光雾面片（Additive，低亮度，渲染在星体层之下） */
export function createGlowPlane(): GlowPlane {
  const geometry = new THREE.PlaneGeometry(94, 94);
  geometry.rotateX(-Math.PI / 2); // 烘到 XZ 平面

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uArmA: { value: 2.5 },
      uArmB: { value: 0.34 },
      uIntensity: { value: 0.42 },
      uMaxLum: { value: 0.5 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = -0.4; // 略低于星盘，避免深度冲突
  mesh.renderOrder = -1; // 先画光雾，星体叠在其上
  mesh.frustumCulled = false;

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
