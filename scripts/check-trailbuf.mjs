import { VortexFieldSimulation } from '../src/vortex.js';
import { DEFAULT_VORTEX } from '../src/types.js';

// 复刻 TrailRenderer：选代表粒子 → 48 步历史 → refresh 段写入 → 连续性检查
const T = 224, H = 96, TRAIL_DT = 1 / 60;
const sim = new VortexFieldSimulation({ ...DEFAULT_VORTEX, particleCount: 30000, seed: 42 });

const pool = sim.brightStart;
const indices = new Int32Array(T);
{
  const pos = sim.position, vel = sim.velocity;
  let found = 0, idx = 0;
  while (found < T && idx < pool * 3) {
    const i = idx % pool, io = i * 3;
    const r = Math.hypot(pos[io], pos[io+1], pos[io+2]);
    const v = Math.hypot(vel[io], vel[io+1], vel[io+2]);
    if (r > 1e-3 && v > 1e-3) {
      const rn = Math.abs(pos[io]*vel[io] + pos[io+1]*vel[io+1] + pos[io+2]*vel[io+2]) / (r*v);
      if (rn < 0.35) indices[found++] = i;
    }
    idx += 7;
  }
}

const history = new Float32Array(T * H * 3);
let cursor = -1, filled = 0, lastSimTime = -1;

function record() {
  cursor = (cursor + 1) % H;
  if (filled < H) filled++;
  for (let t = 0; t < T; t++) {
    const io = indices[t] * 3, ho = (t * H + cursor) * 3;
    history[ho] = sim.position[io];
    history[ho+1] = sim.position[io+1];
    history[ho+2] = sim.position[io+2];
  }
}
function sync(simTime) {
  if (lastSimTime < 0) lastSimTime = simTime - TRAIL_DT;
  if (simTime < lastSimTime) lastSimTime = simTime - TRAIL_DT;
  while (lastSimTime + TRAIL_DT <= simTime) { record(); lastSimTime += TRAIL_DT; }
}

for (let i = 0; i < 48; i++) { sim.update(1/60); sync(sim.time); }
console.log('filled=', filled, 'cursor=', cursor);

// 检查 trail 0 的段连续性：seg s 的 end 应等于 seg s+1 的 start
let bad = 0;
for (let s = 0; s < Math.min(46, H - 2); s++) {
  const t = 0;
  const h1 = (t * H + ((cursor - s + H*2) % H)) * 3;
  const h2 = (t * H + ((cursor - s - 1 + H*2) % H)) * 3;
  const h1n = (t * H + ((cursor - s - 1 + H*2) % H)) * 3;
  // end of seg s = history[h2]; start of seg s+1 = history[h1n] — 同一槽
  const dx = history[h2] - history[h1n];
  const dy = history[h2+1] - history[h1n+1];
  const dz = history[h2+2] - history[h1n+2];
  const d = Math.hypot(dx, dy, dz);
  if (d > 1e-6) { bad++; if (bad < 4) console.log('discontinuity at s=', s, 'd=', d); }
  void h1;
}
console.log('discontinuous segments (trail0):', bad);

// 检查相邻采样空间步长是否平滑（trail0）
const steps = [];
for (let s = 0; s < 46; s++) {
  const t = 0;
  const h1 = (t * H + ((cursor - s + H*2) % H)) * 3;
  const h2 = (t * H + ((cursor - s - 1 + H*2) % H)) * 3;
  steps.push(Math.hypot(history[h1]-history[h2], history[h1+1]-history[h2+1], history[h1+2]-history[h2+2]).toFixed(3));
}
console.log('segment lengths:', steps.join(' '));
