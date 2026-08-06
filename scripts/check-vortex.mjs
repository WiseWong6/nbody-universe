// Vortex 无头验证：30s 稳定性、球形约束、确定性
import { VortexFieldSimulation } from '../src/vortex.ts';

const base = {
  radius: 24, swirl: 0.85, compression: 0.7, axisMix: 0.62, turbulence: 0.1,
  confinement: 1.1, drag: 0.1, trailPersistence: 2.4, timeScale: 0.22,
  blueSaturation: 1.4, coreWhiteRadius: 0.1, trailBrightness: 1.0, bloomStrength: 0.38,
  formationDuration: 6, coreRadiusRatio: 0.15, trailWidth: 1.3, trailDensity: 140,
  outerFlowStrength: 0.6,
  particleCount: 15000, seed: 42,
};

const sim = new VortexFieldSimulation(base);
const R = base.radius;

// ---- V8 形成断言：progress 由外部（setFormationProgress）驱动，
// activeRn 只控制各层粒子的出现顺序，与模拟时间解耦 ----
function activeRatio() {
  let act = 0;
  for (let i = 0; i < sim.count; i++) if (sim.birthRadius[i] <= sim.activeRn) act++;
  return act / sim.count;
}
sim.setFormationProgress(0);
const ar0 = activeRatio();
sim.setFormationProgress(0.5);
for (let f = 0; f < 60; f++) sim.update(1 / 60);
const arMid = activeRatio();
const activeRnMid = sim.activeRn;
sim.setFormationProgress(1);
for (let f = 0; f < 60; f++) sim.update(1 / 60);
const arFull = activeRatio();
console.log(`formation: p=0 激活=${(100 * ar0).toFixed(1)}% | p=0.5 激活=${(100 * arMid).toFixed(1)}% activeRn=${activeRnMid.toFixed(2)} | p=1 激活=${(100 * arFull).toFixed(1)}%`);
console.log(`formation 断言: p0<25%=${ar0 < 0.25 ? 'PASS' : 'FAIL'} 中段增长=${arMid > ar0 + 0.1 ? 'PASS' : 'FAIL'} 完成≈100%=${arFull > 0.99 ? 'PASS' : 'FAIL'}`);

// 回到 t=0 重新计时跑稳定性（init 重置形成进度，直接置为完成态）
sim.init();
sim.setFormationProgress(1);

function stats(label) {
  let nan = 0, outside = 0, farOut = 0, center = 0, rSum = 0, vSum = 0;
  for (let i = 0; i < sim.count; i++) {
    const x = sim.position[i * 3], y = sim.position[i * 3 + 1], z = sim.position[i * 3 + 2];
    if (!Number.isFinite(x + y + z)) { nan++; continue; }
    const r = Math.hypot(x, y, z);
    rSum += r;
    if (r > R * 1.3) outside++;
    if (r > R * 2) farOut++;
    if (r < R * 0.05) center++;
    const vx = sim.velocity[i * 3], vy = sim.velocity[i * 3 + 1], vz = sim.velocity[i * 3 + 2];
    vSum += Math.hypot(vx, vy, vz);
  }
  console.log(`${label}: NaN=${nan} 超1.3R=${(100 * outside / sim.count).toFixed(2)}% 超2R=${(100 * farOut / sim.count).toFixed(2)}% 中心<0.05R=${(100 * center / sim.count).toFixed(2)}% 平均r=${(rSum / sim.count).toFixed(1)} 平均v=${(vSum / sim.count).toFixed(1)}`);
  return rSum / sim.count;
}

const t0 = Date.now();
const mean0 = stats('t=0  ');
// 30 秒（update 接口，模拟 60fps 播放 timeScale=0.6 → 30s 真实 = 18s 模拟）
for (let f = 0; f < 30 * 60; f++) sim.update((1 / 60) * 0.6);
const mean30 = stats('t=30s');
sim.syncSpeed();
console.log(`耗时 ${Date.now() - t0}ms, 步数 ${sim.stepCount}, 平均半径漂移 ${(100 * Math.abs(mean30 - mean0) / mean0).toFixed(1)}%`);

// 再跑 30 模拟秒（全速）确认长期稳定
for (let f = 0; f < 30 * 60; f++) sim.update(1 / 60);
stats('t=60s(全速30s)');

// 确定性：同 seed 两次
function fp() {
  const s = new VortexFieldSimulation({ ...base, particleCount: 3000, seed: 123 });
  for (let f = 0; f < 600; f++) s.update(1 / 60);
  let h = 0;
  for (let i = 0; i < s.position.length; i += 97) h = (h * 31 + s.position[i]) | 0;
  return h;
}
const a = fp(), b = fp();
console.log(`确定性: run1=${a} run2=${b} ${a === b ? 'PASS' : 'FAIL'}`);
