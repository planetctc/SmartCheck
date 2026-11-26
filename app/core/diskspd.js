// Benchmark with Microsoft DiskSpd (MIT, built from source in CI), the same engine CrystalDiskMark uses,
// with CrystalDiskMark 8 default settings: 1 GiB test file of random data, no OS cache (-S), 5 s per run,
// one warm-up run plus 3 counted runs per test (best one kept), 5 s rest between tests. Emits the same events as `smartdisk-helper bench`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FILE_SIZE = 1024 * 1024 * 1024;
// Same order and switches as CrystalDiskMark 8 (DiskBench.cpp): all reads, then all writes;
// "-W0 -S -ag -L", plus a random write buffer of one block (-Z<block>) for writes.
const TESTS = [
  { name: 'seqRead', args: ['-b1024K', '-o8', '-t1', '-W0', '-S', '-w0'] },
  { name: 'seqQ1Read', args: ['-b1024K', '-o1', '-t1', '-W0', '-S', '-w0'] },
  { name: 'rnd4kQ32Read', args: ['-b4K', '-o32', '-t1', '-W0', '-S', '-w0', '-r'] },
  { name: 'rnd4kQ1Read', args: ['-b4K', '-o1', '-t1', '-W0', '-S', '-w0', '-r'] },
  { name: 'seqWrite', args: ['-b1024K', '-o8', '-t1', '-W0', '-S', '-w100', '-Z1024K'] },
  { name: 'seqQ1Write', args: ['-b1024K', '-o1', '-t1', '-W0', '-S', '-w100', '-Z1024K'] },
  { name: 'rnd4kQ32Write', args: ['-b4K', '-o32', '-t1', '-W0', '-S', '-w100', '-r', '-Z4K'] },
  { name: 'rnd4kQ1Write', args: ['-b4K', '-o1', '-t1', '-W0', '-S', '-w100', '-r', '-Z4K'] },
];
const COMMON = ['-ag', '-d5', '-L', '-Rxml'];
const REST_MS = 5000;
const RUNS = 3;

function sumTag(xml, tag) {
  let total = 0;
  for (const m of xml.matchAll(new RegExp(`<${tag}>(\\d+)</${tag}>`, 'g'))) total += Number(m[1]);
  return total;
}

// Throughput from DiskSpd's XML: (read + write bytes) / test time, in MB/s (1 MB = 1,000,000 bytes, as CrystalDiskMark).
function parseResult(xml) {
  const t = Number((/<TestTimeSeconds>([\d.]+)<\/TestTimeSeconds>/.exec(xml) || [])[1]);
  if (!t) return null;
  const bytes = sumTag(xml, 'ReadBytes') + sumTag(xml, 'WriteBytes');
  if (!bytes) return null;
  const ios = sumTag(xml, 'ReadCount') + sumTag(xml, 'WriteCount');
  return { mbps: Math.round(bytes / t / 1e4) / 100, iops: Math.round(ios / t) };
}

// Fill the test file with random data once (CrystalDiskMark also prepares the file before measuring).
async function prepareFile(file, onProgress, isCanceled) {
  const chunk = Buffer.allocUnsafe(16 * 1024 * 1024);
  const fd = fs.openSync(file, 'w');
  try {
    for (let off = 0; off < FILE_SIZE; off += chunk.length) {
      if (isCanceled()) return false;
      crypto.randomFillSync(chunk);
      await new Promise((res, rej) => fs.write(fd, chunk, 0, chunk.length, off, (e) => (e ? rej(e) : res())));
      onProgress(100 * (off + chunk.length) / FILE_SIZE);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return true;
}

// Short reason for a failed run, for the UI and the log.
function failText(out) {
  const msg = (out.stderr.match(/ERROR[^\r\n]*/) || out.stdout.match(/ERROR[^\r\n]*/) || [])[0];
  if (msg) return msg.trim();
  if (out.err && out.err.killed) return 'DiskSpd timed out';
  if (out.err) return `DiskSpd exit code ${out.err.code ?? '?'}`;
  return 'no result from DiskSpd';
}

function runBench({ exe, letter, logFile, onEvent, onEnd }) {
  const root = `${String(letter).slice(0, 1).toUpperCase()}:\\`;
  const file = path.join(root, 'smartCheck-bench.tmp');
  let child = null, canceled = false, timer = null, wake = null;
  const cleanup = () => { try { fs.unlinkSync(file); } catch {} };
  const sleep = (ms) => new Promise(r => { wake = r; timer = setTimeout(r, ms); });
  const log = (text) => { if (logFile) try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`); } catch {} };
  const runOnce = (t) => new Promise((resolve) => {
    const args = [...t.args, ...COMMON, file];
    child = execFile(exe, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
      (err, stdout, stderr) => { child = null; resolve({ err, args, stdout: String(stdout || ''), stderr: String(stderr || '') }); });
  });

  (async () => {
    try {
      try {
        const st = fs.statfsSync(root);
        if (st.bavail * st.bsize < FILE_SIZE + 256 * 1024 * 1024) {
          onEvent({ type: 'error', code: 'nospace', message: 'not enough free space' });
          return onEnd('error');
        }
      } catch {}
      if (logFile) try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `smartCheck benchmark log, drive ${root}\n`); } catch {}
      onEvent({ type: 'start', sizeMiB: 1024, tests: TESTS.length, engine: 'diskspd' });
      onEvent({ type: 'phase', name: 'prepare' });
      let last = 0;
      const ok = await prepareFile(file, (pct) => {
        if (Date.now() - last > 500) { last = Date.now(); onEvent({ type: 'progress', phase: 'prepare', pct }); }
      }, () => canceled);
      if (!ok || canceled) { cleanup(); return onEnd('canceled'); }

      for (const t of TESTS) {
        onEvent({ type: 'phase', name: t.name, run: 0, runs: RUNS });
        await sleep(REST_MS);   // CrystalDiskMark's 5 s interval between tests
        if (canceled) break;
        let best = null, why = '';
        // Like CrystalDiskMark: one warm-up run that is not counted, then RUNS runs back to back; keep the best.
        for (let run = 0; run <= RUNS && !canceled; run++) {
          onEvent({ type: 'phase', name: t.name, run, runs: RUNS });
          // One retry: a test can fail if something (e.g. antivirus) briefly holds the test file.
          let r = null;
          for (let attempt = 1; attempt <= 2 && !r && !canceled; attempt++) {
            if (attempt > 1) await sleep(3000);
            if (canceled) break;
            const out = await runOnce(t);
            r = parseResult(out.stdout);
            if (r) log(`${t.name} ${run ? `run ${run}` : 'warm-up'}: ${r.mbps} MB/s, ${r.iops} IOPS (diskspd ${out.args.join(' ')})`);
            else {
              why = failText(out);
              log(`${t.name} run ${run} attempt ${attempt} failed: ${why}\n--- stdout ---\n${out.stdout.slice(0, 4000)}\n--- stderr ---\n${out.stderr.slice(0, 4000)}`);
            }
          }
          if (run > 0 && r && (!best || r.mbps > best.mbps)) {
            best = r;
            onEvent({ type: 'result', test: t.name, mbps: r.mbps, iops: r.iops, ok: true });
          }
        }
        if (canceled) break;
        if (!best) onEvent({ type: 'result', test: t.name, mbps: null, iops: null, ok: false, error: why });
      }
      cleanup();
      if (canceled) return onEnd('canceled');
      onEvent({ type: 'done' });
      onEnd('done');
    } catch (e) {
      cleanup();
      onEvent({ type: 'error', message: String(e && e.message || e) });
      onEnd('error');
    }
  })();

  return { cancel: () => { canceled = true; clearTimeout(timer); if (wake) wake(); if (child) child.kill(); } };
}

module.exports = { runBench, parseResult, failText };
