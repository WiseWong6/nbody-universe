import type { PresetName, PresetSpec } from './types';

const DEG = Math.PI / 180;

/**
 * 三个预设场景。
 * 世界单位约为「场景单位」：单星系半径 ~36，G 默认 1。
 * 核心质量与距离决定了 v = sqrt(GM/r) 的典型轨道速度（~10 单位/秒），
 * 一个可见的公转周期约 4~8 秒，兼顾电影感与可读性。
 */
export const PRESETS: Record<PresetName, PresetSpec> = {
  hero: {
    label: 'Hero Galaxy',
    cameraDistance: 105,
    cores: [
      {
        mass: 2000,
        position: [0, 0, 0],
        velocity: [0, 0, 0],
        diskFraction: 1.0,
        diskRadius: 9.5,
        diskMaxRadius: 42,
        tiltX: 10 * DEG,
        tiltZ: 0,
      },
    ],
  },

  spiral: {
    label: 'Spiral Galaxy',
    cameraDistance: 95,
    cores: [
      {
        mass: 2400,
        position: [0, 0, 0],
        velocity: [0, 0, 0],
        diskFraction: 1.0,
        diskRadius: 9.5,
        diskMaxRadius: 42,
        tiltX: 12 * DEG,
        tiltZ: 0,
      },
    ],
  },

  collision: {
    label: 'Galaxy Collision',
    cameraDistance: 130,
    cores: [
      {
        mass: 1700,
        position: [-30, -2, -8],
        // 相向而行并横向错开，形成近距离掠过而非正面对撞
        velocity: [3.0, 0.15, 0.8],
        diskFraction: 0.5,
        diskRadius: 5.6,
        diskMaxRadius: 23,
        tiltX: 24 * DEG,
        tiltZ: 10 * DEG,
      },
      {
        mass: 1700,
        position: [30, 2, 8],
        velocity: [-3.0, -0.15, -0.8],
        diskFraction: 0.5,
        diskRadius: 5.6,
        diskMaxRadius: 23,
        tiltX: -30 * DEG,
        tiltZ: -14 * DEG,
      },
    ],
  },

  chaos: {
    label: 'Three-body Chaos',
    cameraDistance: 120,
    // 三个核心获得近似切向速度（v ≈ sqrt(GM/r) 量级），整体近似束缚，
    // 但速度留有刻意的不平衡，演化成混沌的三体舞蹈。
    cores: [
      {
        mass: 950,
        position: [-14, 0, 4],
        velocity: [-1.1, 0.25, -3.9],
        diskFraction: 0.34,
        diskRadius: 4.2,
        diskMaxRadius: 15,
        tiltX: 18 * DEG,
        tiltZ: 0,
      },
      {
        mass: 1050,
        position: [13, 1, -9],
        velocity: [2.2, -0.2, 3.2],
        diskFraction: 0.33,
        diskRadius: 4.2,
        diskMaxRadius: 15,
        tiltX: -22 * DEG,
        tiltZ: 16 * DEG,
      },
      {
        mass: 850,
        position: [1, -2, 12],
        velocity: [-3.8, 0.15, 0.4],
        diskFraction: 0.33,
        diskRadius: 4.2,
        diskMaxRadius: 15,
        tiltX: 40 * DEG,
        tiltZ: -20 * DEG,
      },
    ],
  },
};
