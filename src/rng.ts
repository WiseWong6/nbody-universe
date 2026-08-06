/**
 * 确定性随机数：mulberry32。
 * 相同的 uint32 seed 产生完全相同的序列，模拟全程禁止 Math.random。
 */

export function hashSeed(input: number | string): number {
  if (typeof input === 'number') {
    return (input >>> 0) || 1;
  }
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max) */
  range(min: number, max: number): number;
  /** 近似标准正态（Box-Muller） */
  gauss(): number;
}

export function createRng(seed: number | string): Rng {
  let state = hashSeed(seed);

  function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  let spare: number | null = null;

  function gauss(): number {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    // 避免 log(0)
    do {
      u = next();
    } while (u <= 1e-12);
    v = next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const angle = 2.0 * Math.PI * v;
    spare = mag * Math.sin(angle);
    return mag * Math.cos(angle);
  }

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    gauss,
  };
}

/**
 * 基于 seed 的 2D value-noise（多 octave），输出 [0, 1]。
 * 用于尘埃带暗化等低频空间变化；同样的 seed 得到同样的噪声场。
 */
export function createNoise2D(seed: number | string): (x: number, y: number) => number {
  const s = hashSeed(typeof seed === 'string' ? seed + ':noise' : seed ^ 0x9e3779b9);

  // 格点哈希 → [0, 1)
  function lattice(ix: number, iy: number): number {
    let h = s ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }

  function valueAt(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const v00 = lattice(ix, iy);
    const v10 = lattice(ix + 1, iy);
    const v01 = lattice(ix, iy + 1);
    const v11 = lattice(ix + 1, iy + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  }

  // 3 octave fBm，归一化到 [0, 1]
  return (x, y) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < 3; o++) {
      sum += valueAt(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  };
}

/**
 * 基于 seed 的 3D value-noise（2 octave），输出 [0, 1]。
 * 用于 Vortex 的 Curl Noise 向量势场。
 */
export function createNoise3D(
  seed: number | string
): (x: number, y: number, z: number) => number {
  const s = hashSeed(typeof seed === 'string' ? seed + ':noise3' : seed ^ 0x85ebca6b);

  function lattice(ix: number, iy: number, iz: number): number {
    let h =
      s ^
      Math.imul(ix, 0x27d4eb2d) ^
      Math.imul(iy, 0x165667b1) ^
      Math.imul(iz, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }

  function valueAt(x: number, y: number, z: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const fz = smooth(z - iz);
    const c000 = lattice(ix, iy, iz);
    const c100 = lattice(ix + 1, iy, iz);
    const c010 = lattice(ix, iy + 1, iz);
    const c110 = lattice(ix + 1, iy + 1, iz);
    const c001 = lattice(ix, iy, iz + 1);
    const c101 = lattice(ix + 1, iy, iz + 1);
    const c011 = lattice(ix, iy + 1, iz + 1);
    const c111 = lattice(ix + 1, iy + 1, iz + 1);
    const x00 = c000 + (c100 - c000) * fx;
    const x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx;
    const x11 = c011 + (c111 - c011) * fx;
    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }

  // 2 octave fBm
  return (x, y, z) => {
    return (
      valueAt(x, y, z) * 0.67 +
      valueAt(x * 2.13 + 5.2, y * 2.13 + 1.3, z * 2.13 + 8.7) * 0.33
    );
  };
}
