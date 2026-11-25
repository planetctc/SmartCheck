// Fake benchmark / surface scan for demo mode (no helper, or not on Windows). Emits the same events as the helper.
function mockTask(kind, disk, onEvent, onEnd) {
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const ssd = disk.bus === 'nvme' || disk.rpm === 1;

  if (kind === 'capacity') {
    const total = 64e9, fake = disk.bus === 'usb';
    onEvent({ type: 'start', total, free: total * 0.9, target: total * 0.9 });
    let pct = 0, phase = 'write';
    const step = () => {
      pct += 5;
      onEvent({ type: 'progress', phase, pct, done: total * 0.9 * pct / 100, mbps: phase === 'write' ? 35 : 90, bad: fake && phase === 'verify' && pct > 25 ? (pct - 25) / 100 * total * 0.9 : 0 });
      if (pct < 100) return later(150, step);
      if (phase === 'write') { phase = 'verify'; pct = 0; return later(150, step); }
      const tested = total * 0.9, firstBad = fake ? Math.round(tested * 0.25) : -1;
      onEvent({ type: 'done', total, free: tested, tested, okBytes: fake ? firstBad : tested, badBytes: fake ? tested - firstBad : 0, firstBad, writeFailed: false, writeMbps: 35, readMbps: 90 });
      onEnd('done');
    };
    later(150, step);
  } else if (kind === 'erase') {
    onEvent({ type: 'start', size: disk.sizeBytes, nvme: disk.bus === 'nvme' });
    if (disk.bus === 'nvme') { onEvent({ type: 'phase', name: 'nvme' }); later(1500, () => { onEvent({ type: 'done', method: 'nvme', seconds: 2 }); onEnd('done'); }); }
    else {
      onEvent({ type: 'phase', name: 'zero' });
      let pct = 0;
      const step = () => { pct += 4; onEvent({ type: 'progress', pct, done: disk.sizeBytes * pct / 100, mbps: 180, elapsed: pct * 3, errors: 0 }); if (pct < 100) later(120, step); else { onEvent({ type: 'done', method: 'zero', seconds: 300, errors: 0 }); onEnd('done'); } };
      later(120, step);
    }
  } else if (kind === 'bench') {
    const speeds = disk.bus === 'nvme'
      ? { seqRead: [6900, 0], seqWrite: [5000, 0], seqQ1Read: [2900, 0], seqQ1Write: [2600, 0], rnd4kQ32Read: [2600, 635000], rnd4kQ32Write: [2300, 561000], rnd4kQ1Read: [85, 20700], rnd4kQ1Write: [240, 58600] }
      : ssd ? { seqRead: [560, 0], seqWrite: [520, 0], seqQ1Read: [520, 0], seqQ1Write: [480, 0], rnd4kQ32Read: [390, 95000], rnd4kQ32Write: [350, 85000], rnd4kQ1Read: [45, 11000], rnd4kQ1Write: [120, 29000] }
        : { seqRead: [210, 0], seqWrite: [205, 0], seqQ1Read: [200, 0], seqQ1Write: [198, 0], rnd4kQ32Read: [1.9, 460], rnd4kQ32Write: [2.1, 510], rnd4kQ1Read: [0.7, 170], rnd4kQ1Write: [1.6, 390] };
    onEvent({ type: 'start', sizeMiB: 1024, tests: 8 });
    onEvent({ type: 'phase', name: 'prepare' });
    let t = 400;
    for (const [name, [mbps, iops]] of Object.entries(speeds)) {
      later(t, () => onEvent({ type: 'phase', name }));
      t += 500;
      later(t, () => onEvent({ type: 'result', test: name, mbps, iops: iops || Math.round(mbps * 1e6 / 1048576), ok: true }));
    }
    later(t + 100, () => { onEvent({ type: 'done' }); onEnd('done'); });
  } else {
    const CELLS = 1000;
    onEvent({ type: 'start', size: disk.sizeBytes, sector: 512, cells: CELLS });
    let done = 0, bad = 0, slow = 0;
    const step = () => {
      const from = done, n = 40, cells = [];
      for (let i = 0; i < n && done < CELLS; i++, done++) {
        let v = 0;
        if (!ssd && done === 612) { v = 3; bad += 2; } else if (!ssd && (done === 377 || done === 378)) { v = 1; slow++; }
        cells.push(v);
      }
      onEvent({ type: 'progress', pct: done / CELLS * 100, done: Math.round(disk.sizeBytes * done / CELLS), mbps: ssd ? 2100 : 180, elapsed: done / 10, bad, slow, verySlow: 0, from, cells });
      if (done < CELLS) later(80, step);
      else { onEvent({ type: 'done', bad, slow, verySlow: 0, seconds: ssd ? 480 : 11200, badLbas: bad ? [2390061440, 2390061441] : [] }); onEnd('done'); }
    };
    later(100, step);
  }
  return () => timers.forEach(clearTimeout);
}

module.exports = { mockTask };
