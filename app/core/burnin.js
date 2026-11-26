// Burn-in test (烤机): load the CPU (and optionally the graphics card) for N minutes, sample the sensors every
// 2 s and decide whether the PC stays cool and stable. Pure Node except the CPU load (worker_threads); main.js
// starts the GPU load window and the sensor reader (smartdisk-sensors.exe --watch 2000).
const os = require('os');
const { Worker } = require('worker_threads');
const { L } = require('../renderer/i18n');

const GPU = /^Gpu/;

// One sample from a raw LibreHardwareMonitor reading ([{ hw, part, type, name, value }]).
function pick(raw, t = Date.now()) {
  const max = a => (a.length ? Math.max(...a) : null);
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
  const cpuT = raw.filter(x => x.hw === 'Cpu' && x.type === 'Temperature' && !/Distance|TjMax/i.test(x.name)
    && /package|core max|tctl|tdie|^core \(|^cpu$/i.test(x.name)).map(x => x.value);
  const boardCpuT = raw.filter(x => !/^Cpu$|^Gpu/.test(x.hw) && x.type === 'Temperature' && /^CPU/i.test(x.name)).map(x => x.value);
  const gpuT = raw.filter(x => GPU.test(x.hw) && x.type === 'Temperature' && /^GPU Core$|^GPU$/i.test(x.name)).map(x => x.value);
  const clocks = raw.filter(x => x.hw === 'Cpu' && x.type === 'Clock' && /^(CPU )?(P-)?Core #\d+$/i.test(x.name) && x.value > 100).map(x => x.value);
  const fans = raw.filter(x => x.type === 'Fan' && !GPU.test(x.hw));
  const cpuFan = fans.find(x => /cpu/i.test(x.name)) || null;
  return {
    t,
    cpuTemp: r1(max(cpuT) ?? max(boardCpuT)),
    gpuTemp: r1(max(gpuT)),
    cpuClock: clocks.length ? Math.round(avg(clocks)) : null,
    cpuLoad: r1(raw.find(x => x.hw === 'Cpu' && x.type === 'Load' && /^CPU Total$/i.test(x.name))?.value ?? null),
    gpuLoad: r1(raw.find(x => GPU.test(x.hw) && x.type === 'Load' && /^GPU Core$/i.test(x.name))?.value ?? null),
    cpuPower: r1(raw.find(x => x.hw === 'Cpu' && x.type === 'Power' && /package/i.test(x.name))?.value ?? null),
    cpuFan: cpuFan ? Math.round(cpuFan.value) : null,
  };
}

// Result from the samples. lim = limits.limitsOf(settings): { cpuWarn, cpuBad, gpuWarn, gpuBad }.
// status: done | canceled | interrupted (smartPC or Windows stopped during the test: crash, freeze or power cut).
function evaluate(run, lim = {}) {
  const s = run.samples || [];
  const vals = k => s.map(x => x[k]).filter(v => v != null);
  const max = a => (a.length ? Math.max(...a) : null);
  const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const t0 = s[0]?.t || 0, tN = s[s.length - 1]?.t || 0;
  const loaded = s.filter(x => x.cpuLoad == null || x.cpuLoad >= 80);
  // Clock while still cool (first minute under load) vs. the last minute: a big drop while hot = thermal throttling.
  const early = median(loaded.filter(x => x.t - t0 <= 60000).map(x => x.cpuClock).filter(Boolean));
  const late = median(loaded.filter(x => tN - x.t <= 60000).map(x => x.cpuClock).filter(Boolean));
  const cpuMax = max(vals('cpuTemp')), gpuMax = max(vals('gpuTemp'));
  const throttle = early && late && tN - t0 >= 120000 && late < early * 0.85 && (cpuMax ?? 0) >= (lim.cpuWarn ?? 85)
    ? Math.round((1 - late / early) * 100) : 0;
  const reasons = [];
  let verdict = 'pass';
  const worse = v => { if (v === 'fail' || (v === 'warn' && verdict === 'pass')) verdict = v; };
  if (run.status === 'interrupted') { worse('fail'); reasons.push(L('测试中途停止了（可能死机、自动重启或断电）', 'The test stopped part-way (the PC may have frozen, restarted or lost power)')); }
  if (cpuMax != null) {
    if (cpuMax >= (lim.cpuBad ?? 95)) { worse('fail'); reasons.push(L(`CPU 最高 ${cpuMax} °C，达到过热门槛 ${lim.cpuBad ?? 95} °C`, `CPU reached ${cpuMax} °C, at the too-hot limit of ${lim.cpuBad ?? 95} °C`)); }
    else if (cpuMax >= (lim.cpuWarn ?? 85)) { worse('warn'); reasons.push(L(`CPU 最高 ${cpuMax} °C，偏高`, `CPU reached ${cpuMax} °C, on the high side`)); }
  }
  if (gpuMax != null && run.gpu) {
    if (gpuMax >= (lim.gpuBad ?? 90)) { worse('fail'); reasons.push(L(`显卡最高 ${gpuMax} °C，达到过热门槛 ${lim.gpuBad ?? 90} °C`, `GPU reached ${gpuMax} °C, at the too-hot limit of ${lim.gpuBad ?? 90} °C`)); }
    else if (gpuMax >= (lim.gpuWarn ?? 83)) { worse('warn'); reasons.push(L(`显卡最高 ${gpuMax} °C，偏高`, `GPU reached ${gpuMax} °C, on the high side`)); }
  }
  if (throttle) { worse('warn'); reasons.push(L(`CPU 因为过热降频约 ${throttle}%（${early} → ${late} MHz）`, `CPU slowed down about ${throttle}% from heat (${early} → ${late} MHz)`)); }
  if (run.status === 'canceled') verdict = verdict === 'fail' ? 'fail' : 'canceled';
  return {
    verdict, reasons, cpuMax, gpuMax, throttle, clockStart: early, clockEnd: late,
    cpuPowerMax: max(vals('cpuPower')), cpuFanMax: max(vals('cpuFan')),
    seconds: Math.round((tN - t0) / 1000), noTemp: cpuMax == null,
  };
}

// Keep the chart and the saved file small: at most n points.
function thin(samples, n = 240) {
  if (samples.length <= n) return samples;
  const step = samples.length / n;
  return Array.from({ length: n }, (_, i) => samples[Math.floor(i * step)]).concat([samples[samples.length - 1]]);
}

// CPU load: one busy worker per logical processor (floating-point and integer work, like a simple stress tool).
const WORKER = `
const { workerData } = require('worker_threads');
const stop = new Int32Array(workerData.stop);
const a = new Float64Array(4096); for (let i = 0; i < a.length; i++) a[i] = Math.random() + 1;
let x = 1.0001, n = 0;
while (Atomics.load(stop, 0) === 0) {
  for (let i = 0; i < a.length; i++) { a[i] = Math.sqrt(a[i] * x + 1.5) * Math.sin(a[i]) + Math.cos(x); x = x * 1.0000001 + (i & 7) * 1e-9; }
  n = (n * 1103515245 + 12345) | 0;
}`;
function startCpuLoad(threads = os.cpus().length || 4) {
  const buf = new SharedArrayBuffer(4);
  const stop = new Int32Array(buf);
  const workers = Array.from({ length: threads }, () => { const w = new Worker(WORKER, { eval: true, workerData: { stop: buf } }); w.on('error', () => {}); return w; });
  return { threads, stop: () => { Atomics.store(stop, 0, 1); setTimeout(() => workers.forEach(w => w.terminate().catch(() => {})), 500); } };
}

module.exports = { pick, evaluate, thin, startCpuLoad };
