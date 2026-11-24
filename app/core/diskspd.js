// Benchmark with Microsoft DiskSpd (MIT, built from source in CI), the same engine CrystalDiskMark uses,
// with CrystalDiskMark-style settings: 1 GiB test file of random data, 5 s per test, 5 s rest between tests,
// write-through + no OS cache (-Sh). Emits the same events as `smartdisk-helper bench`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FILE_SIZE = 1024 * 1024 * 1024;
const TESTS = [
  { name: 'seqRead', args: ['-b1M', '-o8', '-t1', '-w0'] },
  { name: 'seqWrite', args: ['-b1M', '-o8', '-t1', '-w100'] },
  { name: 'seqQ1Read', args: ['-b1M', '-o1', '-t1', '-w0'] },
  { name: 'seqQ1Write', args: ['-b1M', '-o1', '-t1', '-w100'] },
  { name: 'rnd4kQ32Read', args: ['-b4K', '-o32', '-t1', '-r', '-w0'] },
  { name: 'rnd4kQ32Write', args: ['-b4K', '-o32', '-t1', '-r', '-w100'] },
  { name: 'rnd4kQ1Read', args: ['-b4K', '-o1', '-t1', '-r', '-w0'] },
  { name: 'rnd4kQ1Write', args: ['-b4K', '-o1', '-t1', '-r', '-w100'] },
];
const COMMON = ['-d5', '-W0', '-Sh', '-Z64M', '-Rxml'];
const REST_MS = 5000;

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

function runBench({ exe, letter, onEvent, onEnd }) {
  const root = `${String(letter).slice(0, 1).toUpperCase()}:\\`;
  const file = path.join(root, 'smartDisk-bench.tmp');
  let child = null, canceled = false, timer = null, wake = null;
  const cleanup = () => { try { fs.unlinkSync(file); } catch {} };
  const sleep = (ms) => new Promise(r => { wake = r; timer = setTimeout(r, ms); });

  (async () => {
    try {
      try {
        const st = fs.statfsSync(root);
        if (st.bavail * st.bsize < FILE_SIZE + 256 * 1024 * 1024) {
          onEvent({ type: 'error', code: 'nospace', message: 'not enough free space' });
          return onEnd('error');
        }
      } catch {}
      onEvent({ type: 'start', sizeMiB: 1024, tests: TESTS.length, engine: 'diskspd' });
      onEvent({ type: 'phase', name: 'prepare' });
      let last = 0;
      const ok = await prepareFile(file, (pct) => {
        if (Date.now() - last > 500) { last = Date.now(); onEvent({ type: 'progress', phase: 'prepare', pct }); }
      }, () => canceled);
      if (!ok || canceled) { cleanup(); return onEnd('canceled'); }

      for (const t of TESTS) {
        onEvent({ type: 'phase', name: t.name });
        await sleep(REST_MS);
        if (canceled) break;
        const xml = await new Promise((resolve) => {
          child = execFile(exe, [...t.args, ...COMMON, file], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
            (err, stdout) => { child = null; resolve(err ? '' : String(stdout)); });
        });
        if (canceled) break;
        const r = parseResult(xml);
        onEvent({ type: 'result', test: t.name, mbps: r ? r.mbps : 0, iops: r ? r.iops : 0, ok: !!r });
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

module.exports = { runBench, parseResult };
