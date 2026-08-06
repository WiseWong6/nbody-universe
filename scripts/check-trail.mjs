import { VortexFieldSimulation } from '../src/vortex.js';
import { DEFAULT_VORTEX } from '../src/types.js';

const sim = new VortexFieldSimulation({ ...DEFAULT_VORTEX, particleCount: 30000, seed: 42 });

// 复刻 TrailRenderer 的切向筛选
const pool = sim.brightStart;
const pos = sim.position, vel = sim.velocity;
const indices = [];
let idx = 0;
while (indices.length < 224 && idx < pool * 3) {
  const i = idx % pool;
  const io = i * 3;
  const r = Math.hypot(pos[io], pos[io+1], pos[io+2]);
  const v = Math.hypot(vel[io], vel[io+1], vel[io+2]);
  if (r > 1e-3 && v > 1e-3) {
    const rn = Math.abs(pos[io]*vel[io] + pos[io+1]*vel[io+1] + pos[io+2]*vel[io+2]) / (r*v);
    if (rn < 0.35) indices.push(i);
  }
  idx += 7;
}

// 追踪前 3 个代表粒子 48 步的位置，输出相邻距离（应 ≈ v/60，平滑）
for (const t of [0, 50, 120]) {
  const i = indices[t];
  const io = i * 3;
  const ds = [];
  let px = pos[io], py = pos[io+1], pz = pos[io+2];
  const r0 = Math.hypot(px, py, pz);
  for (let s = 0; s < 48; s++) {
    sim.update(1/60);
    const nx = pos[io], ny = pos[io+1], nz = pos[io+2];
    ds.push(Math.hypot(nx-px, ny-py, nz-pz).toFixed(3));
    px = nx; py = ny; pz = nz;
  }
  console.log(`trail${t} idx=${i} r0=${r0.toFixed(1)} |step|:`, ds.join(' '));
}
