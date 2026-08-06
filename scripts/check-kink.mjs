import { VortexFieldSimulation } from '../src/vortex.js';
import { DEFAULT_VORTEX } from '../src/types.js';

const sim = new VortexFieldSimulation({ ...DEFAULT_VORTEX, particleCount: 30000, seed: 42 });
const pos = sim.position;

// 追踪粒子 7（trail0），输出 48 个位置和相邻段方向夹角
const io = 7 * 3;
const pts = [];
for (let s = 0; s < 48; s++) {
  pts.push([pos[io], pos[io + 1], pos[io + 2]]);
  sim.update(1 / 60);
}
let maxKink = 0;
for (let s = 1; s < 47; s++) {
  const a = [pts[s][0] - pts[s-1][0], pts[s][1] - pts[s-1][1], pts[s][2] - pts[s-1][2]];
  const b = [pts[s+1][0] - pts[s][0], pts[s+1][1] - pts[s][1], pts[s+1][2] - pts[s][2]];
  const dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  const ang = Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) * 180 / Math.PI;
  if (ang > maxKink) maxKink = ang;
}
console.log('max kink angle over 48 steps:', maxKink.toFixed(2), 'deg');
const r = pts.map(p => Math.hypot(...p).toFixed(2));
console.log('radius series:', r.slice(0, 12).join(' '), '...');
