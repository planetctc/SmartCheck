// Full sensors (CPU temperature, fans, voltages, power) through smartdisk-sensors.exe (LibreHardwareMonitorLib).
// CPU and motherboard chips need the PawnIO driver; the shop installs it once from Settings / This PC
// (downloaded from PawnIO's official GitHub release and checked for a valid Authenticode signature).
const { execFile } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { L } = require('../renderer/i18n');

const PAWNIO_URL = 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe';

const run = (file, args, opts = {}) => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

async function pawnioInstalled() {
  if (process.platform !== 'win32') return false;
  const r = await run('sc.exe', ['query', 'PawnIO']);
  return r.code === 0;
}

// Download, check the signature, install silently. Returns { ok, reboot } or { ok: false, error }.
async function installPawnIO() {
  if (process.platform !== 'win32') return { ok: false, error: 'windows only' };
  const file = path.join(os.tmpdir(), `PawnIO_setup_${Date.now()}.exe`);
  try {
    const res = await fetch(PAWNIO_URL, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `download HTTP ${res.status}` };
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const sig = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`]);
    const [status, subject] = sig.stdout.trim().split('|');
    if (status !== 'Valid') return { ok: false, error: `signature ${status || 'unknown'}` };
    const r = await run(file, ['-install', '-silent'], { timeout: 120000 });
    if (r.code !== 0 && r.code !== 3010) return { ok: false, error: `installer exit ${r.code}` };
    return { ok: true, reboot: r.code === 3010, signer: subject };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { try { fs.unlinkSync(file); } catch {} }
}

// LibreHardwareMonitor hardware types -> our groups
const GROUP = { Cpu: 'cpu', GpuNvidia: 'gpu', GpuAmd: 'gpu', GpuIntel: 'gpu', Motherboard: 'board', SuperIO: 'board', Memory: 'memory', EmbeddedController: 'board' };
const KIND = { Temperature: ['temp', '°C'], Fan: ['fan', 'RPM'], Voltage: ['volt', 'V'], Power: ['power', 'W'], Load: ['load', '%'] };

// Keep what a technician checks at delivery: temperatures, spinning fans, named voltages, package/board power, total load.
function keep(x) {
  const n = x.name;
  if (x.type === 'Temperature') return x.value > 0 && x.value < 125 && !/^Core #\d+$|^CPU Core #\d+$|Distance to TjMax/i.test(n);
  if (x.type === 'Fan') return x.value > 0;
  if (x.type === 'Voltage') return GROUP[x.hw] === 'board' ? !/^Voltage #\d+$/i.test(n) && x.value > 0 : /^(CPU Core|Core \(SVI2 TFN\)|GPU Core)$/i.test(n);
  if (x.type === 'Power') return /package|^GPU (Package|Power|Board Power)$|^CPU Cores$/i.test(n);
  if (x.type === 'Load') return /^(CPU Total|GPU Core|Memory)$/i.test(n);
  return false;
}

function label(x) {
  const g = GROUP[x.hw] || 'board';
  const pre = { cpu: 'CPU', gpu: L('显卡', 'GPU'), board: L('主板', 'Board'), memory: L('内存', 'Memory') }[g];
  return /^(CPU|GPU)\b/i.test(x.name) ? x.name : `${pre} ${x.name}`;
}

function toSensors(list) {
  list = (list || []).filter(x => KIND[x.type] && keep(x));
  // A board chip's "CPU" temperature input is often unwired or mis-scaled (an idle i3-12100F showed 99.5 °C on an
  // MSI B660M). When the CPU itself reports a temperature, trust that and drop the board's guess.
  if (list.some(x => GROUP[x.hw] === 'cpu' && x.type === 'Temperature'))
    list = list.filter(x => !(GROUP[x.hw || ''] !== 'cpu' && GROUP[x.hw] !== 'gpu' && x.type === 'Temperature' && /^CPU/i.test(x.name)));
  return list.map(x => {
    const [kind, unit] = KIND[x.type];
    return { group: GROUP[x.hw] || 'board', part: x.part, name: label(x), kind, value: Math.round(x.value * (kind === 'volt' ? 1000 : 10)) / (kind === 'volt' ? 1000 : 10), unit, src: 'lhm' };
  });
}

async function read(exe) {
  if (process.platform !== 'win32' || !exe || !fs.existsSync(exe)) return null;
  const r = await run(exe, [], { timeout: 45000 });
  try {
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    return j.ok ? toSensors(j.sensors) : null;
  } catch { return null; }
}

module.exports = { pawnioInstalled, installPawnIO, read, toSensors, PAWNIO_URL };
