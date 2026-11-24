// Fake benchmark / surface scan for demo mode (no helper, or not on Windows). Emits the same events as the helper.
function mockTask(kind, disk, onEvent, onEnd) {
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const ssd = disk.bus === 'nvme' || disk.rpm === 1;

  if (kind === 'bench') {
    const speeds = disk.bus === 'nvme'
      ? { seqRead: [6900, 0], seqWrite: [5000, 0], rnd4kQ32Read: [2600, 635000], rnd4kQ32Write: [2300, 561000], rnd4kQ1Read: [85, 20700], rnd4kQ1Write: [240, 58600] }
      : ssd ? { seqRead: [560, 0], seqWrite: [520, 0], rnd4kQ32Read: [390, 95000], rnd4kQ32Write: [350, 85000], rnd4kQ1Read: [45, 11000], rnd4kQ1Write: [120, 29000] }
        : { seqRead: [210, 0], seqWrite: [205, 0], rnd4kQ32Read: [1.9, 460], rnd4kQ32Write: [2.1, 510], rnd4kQ1Read: [0.7, 170], rnd4kQ1Write: [1.6, 390] };
    onEvent({ type: 'start', sizeMiB: 1024, tests: 6 });
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
