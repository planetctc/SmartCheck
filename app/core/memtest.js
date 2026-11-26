// Memory test. Quick test inside Windows: fill most of the free RAM with patterns and read them back (finds bad
// RAM sticks and unstable XMP in a few minutes, but cannot reach memory Windows itself is using).
// Full test: Windows Memory Diagnostic after a restart (tests all RAM); the result is read back from the event log.
const os = require('os');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');

const run = (file, args, timeout = 30000) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
  (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || ''), err: String(stderr || '') })));

const CHUNK = 256 * 1024 * 1024;
const WORKER = `
const { workerData, parentPort } = require('worker_threads');
const stop = new Int32Array(workerData.stop);
const { chunks, chunkBytes, passes } = workerData;
// Solid patterns, checkerboards, and each word's own address (catches address-line faults) plus its inverse.
const PATTERNS = [0x00000000, 0xFFFFFFFF, 0x55555555, 0xAAAAAAAA, 'addr', 'inv'];
const bufs = [];
let errors = 0; const bad = [];
try { for (let i = 0; i < chunks; i++) { if (Atomics.load(stop, 0)) break; const a = new Uint32Array(chunkBytes / 4); a.fill(1); bufs.push(a); parentPort.postMessage({ type: 'alloc', n: i + 1, of: chunks }); } }
catch (e) { parentPort.postMessage({ type: 'alloc-limit', n: bufs.length }); }
const total = bufs.length * PATTERNS.length * passes;
let step = 0;
const note = (b, i, want, got) => { errors++; if (bad.length < 20) bad.push({ chunk: b, offset: i * 4, want: (want >>> 0).toString(16), got: (got >>> 0).toString(16) }); };
outer: for (let pass = 0; pass < passes; pass++) {
  for (const p of PATTERNS) {
    for (let b = 0; b < bufs.length; b++) {
      if (Atomics.load(stop, 0)) break outer;
      const a = bufs[b], base = (b * a.length) >>> 0, n = a.length;
      if (p === 'addr') { for (let i = 0; i < n; i++) a[i] = (base + i) >>> 0; for (let i = 0; i < n; i++) if (a[i] !== ((base + i) >>> 0)) note(b, i, base + i, a[i]); }
      else if (p === 'inv') { for (let i = 0; i < n; i++) a[i] = ~(base + i) >>> 0; for (let i = 0; i < n; i++) if (a[i] !== (~(base + i) >>> 0)) note(b, i, ~(base + i), a[i]); }
      else { a.fill(p); for (let i = 0; i < n; i++) if (a[i] !== p) note(b, i, p, a[i]); }
      step++;
      parentPort.postMessage({ type: 'progress', pct: Math.round(step / total * 1000) / 10, errors, pass: pass + 1 });
    }
  }
}
parentPort.postMessage({ type: 'done', errors, bad, testedBytes: bufs.length * chunkBytes, stopped: !!Atomics.load(stop, 0) });
`;

// onEvent({ type: 'alloc'|'progress'|'done', ... }). Returns { stop }.
function quickTest({ passes = 1, onEvent, maxBytes }) {
  const free = os.freemem();
  const target = Math.max(CHUNK, Math.min(free - 1.5 * 1024 ** 3, free * 0.85));
  const chunks = Math.max(1, Math.floor(Math.min(target, maxBytes || Infinity) / CHUNK));
  const buf = new SharedArrayBuffer(4), stop = new Int32Array(buf);
  const w = new Worker(WORKER, { eval: true, workerData: { stop: buf, chunks, chunkBytes: CHUNK, passes }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  onEvent({ type: 'start', planBytes: chunks * CHUNK, totalBytes: os.totalmem(), freeBytes: free });
  w.on('message', m => onEvent(m));
  w.on('error', e => onEvent({ type: 'done', errors: 0, error: e.message, testedBytes: 0 }));
  w.on('exit', () => {});
  return { stop: () => { Atomics.store(stop, 0, 1); } };
}

// Full test: boot into Windows Memory Diagnostic once at the next restart.
async function scheduleFull() {
  const r = await run('bcdedit.exe', ['/bootsequence', '{memdiag}']);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.out + r.err).trim().slice(0, 300) || `bcdedit ${r.code}` };
}

// Last Windows Memory Diagnostic result from the System event log (1101 = no errors, 1102 = errors found).
async function lastFullResult() {
  if (process.platform !== 'win32') return null;
  const ps = "$e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-MemoryDiagnostics-Results'} -MaxEvents 1 -ErrorAction SilentlyContinue; " +
    "if ($e) { [pscustomobject]@{ id = $e.Id; time = $e.TimeCreated.ToString('o'); msg = $e.Message } | ConvertTo-Json -Compress }";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  try { const j = JSON.parse(r.out.trim()); return { ok: j.id === 1101 || j.id === 1201, id: j.id, time: j.time, msg: String(j.msg || '').slice(0, 400) }; } catch { return null; }
}

module.exports = { quickTest, scheduleFull, lastFullResult };
