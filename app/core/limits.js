// Feature switches and warning limits the shop can change in Settings (stored as strings in settings.json).
// Pure Node so main.js, the monitor and the tests share the same defaults.

const FEATURES = ['bench', 'scan', 'selftest', 'grade', 'history', 'capacity', 'erase', 'sensors', 'burn', 'memtest', 'battery'];

// [settings key, default, min, max]
const LIMITS = {
  drop: ['lim_drop', 2, 1, 50],          // health points lost before the customer is alerted
  hdd: ['lim_hdd', 60, 40, 90],          // hard disk too hot (°C)
  ssd: ['lim_ssd', 70, 40, 100],         // SATA SSD too hot
  nvme: ['lim_nvme', 80, 40, 110],       // NVMe SSD too hot
  cpuWarn: ['lim_cpu_w', 85, 40, 110], cpuBad: ['lim_cpu_b', 95, 40, 115],
  gpuWarn: ['lim_gpu_w', 83, 40, 110], gpuBad: ['lim_gpu_b', 90, 40, 115],
  boardWarn: ['lim_board_w', 75, 30, 110], boardBad: ['lim_board_b', 90, 30, 115],
};

// Defaults for settings.json: every feature on ('1'), every limit at its default.
function defaults() {
  const d = {};
  for (const f of FEATURES) d['f_' + f] = '1';
  for (const [k, def] of Object.values(LIMITS)) d[k] = String(def);
  return d;
}

function limitsOf(st = {}) {
  const out = {};
  for (const [name, [k, def, min, max]] of Object.entries(LIMITS)) {
    const n = Math.round(Number(st[k]));
    out[name] = Number.isFinite(n) && String(st[k] ?? '').trim() !== '' ? Math.min(max, Math.max(min, n)) : def;
  }
  // A "bad" limit below its "warn" limit makes no sense: lift it.
  for (const g of ['cpu', 'gpu', 'board']) if (out[g + 'Bad'] < out[g + 'Warn']) out[g + 'Bad'] = out[g + 'Warn'];
  return out;
}

const featureOn = (st, f) => String(st?.['f_' + f] ?? '1') !== '0';

module.exports = { FEATURES, LIMITS, defaults, limitsOf, featureOn };
