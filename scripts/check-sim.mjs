// 无头验证：30s+ 稳定性、确定性、三个预设粒子留存
import { Simulation, SIM_DT } from '../src/simulation.ts';

const PRESETS = ['hero', 'spiral', 'collision', 'chaos'];
const SECONDS = 40;
const STEPS = Math.round(SECONDS / SIM_DT);

// 方位角 m=2 傅里叶幅度（旋臂对比度指标）：|Σ e^(i·2φ)| / N，取 6<r<32 环带
function m2Amplitude(sim) {
  let re = 0, im = 0, cnt = 0;
  for (let i = 0; i < sim.count; i++) {
    const x = sim.position[i * 3], z = sim.position[i * 3 + 2];
    const r = Math.hypot(x, z);
    if (r < 6 || r > 32) continue;
    const phi = Math.atan2(z, x);
    re += Math.cos(2 * phi);
    im += Math.sin(2 * phi);
    cnt++;
  }
  return cnt > 0 ? Math.hypot(re, im) / cnt : 0;
}

for (const preset of PRESETS) {
  const t0 = Date.now();
  const sim = new Simulation({
    preset, gravity: 0.85, rotation: 0.98, chaos: 0.12, timeScale: 1.0,
    particleCount: 30000, seed: 42,
    bloom: false, showHud: false, paused: false,
  });
  const m2Before = m2Amplitude(sim);
  for (let s = 0; s < STEPS; s++) sim.step();
  const m2After = m2Amplitude(sim);

  // 统计：NaN 数量、逃逸(>250)数量、距原点中位距离
  let nan = 0, escaped = 0;
  const dists = [];
  for (let i = 0; i < sim.count; i++) {
    const x = sim.position[i * 3], y = sim.position[i * 3 + 1], z = sim.position[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nan++; continue; }
    const d = Math.sqrt(x * x + y * y + z * z);
    dists.push(d);
    if (d > 250) escaped++;
  }
  dists.sort((a, b) => a - b);
  const median = dists[dists.length >> 1] ?? -1;
  const p90 = dists[Math.floor(dists.length * 0.9)] ?? -1;
  const ms = Date.now() - t0;
  console.log(`${preset}: ${SECONDS}s 模拟, ${sim.stepCount} 步, 耗时 ${ms}ms | NaN=${nan} escaped=${escaped} median=${median.toFixed(1)} p90=${p90.toFixed(1)} | m2=${m2Before.toFixed(3)}→${m2After.toFixed(3)}`);
  // 核心距原点距离
  const cd = [];
  for (let j = 0; j < sim.coreCount; j++) {
    const x = sim.cores[j * 7 + 1], y = sim.cores[j * 7 + 2], z = sim.cores[j * 7 + 3];
    cd.push(Math.sqrt(x * x + y * y + z * z).toFixed(1));
  }
  console.log(`  核心距离: [${cd.join(', ')}]`);
}

// 确定性：同 seed 两次运行，逐步比对
function fingerprint(preset) {
  const sim = new Simulation({
    preset, gravity: 0.85, rotation: 0.98, chaos: 0.12, timeScale: 1.0,
    particleCount: 3000, seed: 123,
    bloom: false, showHud: false, paused: false,
  });
  for (let s = 0; s < 2000; s++) sim.step();
  let h = 0;
  for (let i = 0; i < sim.position.length; i += 97) h = (h * 31 + sim.position[i]) | 0;
  return h;
}
for (const p of ['hero', 'spiral']) {
  const a = fingerprint(p);
  const b = fingerprint(p);
  console.log(`确定性(${p}): run1=${a} run2=${b} ${a === b ? 'PASS' : 'FAIL'}`);
}
