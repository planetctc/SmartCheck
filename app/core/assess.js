// Buyback grade (收购评级) and refurbished-drive check (翻新盘识别) from SMART / NVMe data.
// Pure logic: input is a helper disk object plus its health summary; the surface-scan result is applied later.
const { L } = require('../renderer/i18n');

function raw(d, id) { return d.ata?.attributes?.find(a => a.id === id)?.raw; }
const isHdd = d => d.rpm > 1;
const isSsd = d => d.bus === 'nvme' || d.rpm === 1;

// Rough endurance (TB written) for consumer SSDs: about 600 TB per TB of capacity.
function ratedTbw(d) { return Math.max(150, (d.sizeBytes || 0) / 1e12 * 600); }
function writtenTb(d) { return d.nvme ? d.nvme.dataUnitsWritten * 512000 / 1e12 : null; }

// Signs that the SMART counters were cleared or the drive is used but sold as new.
function refurbCheck(d, s) {
  const reasons = [];
  if (!d.smartOk) return { suspect: false, reasons };
  const poh = s.powerOnHours, cycles = s.powerCycles;
  if (poh == null) return { suspect: false, reasons };
  if (d.nvme) {
    const n = d.nvme, tb = writtenTb(d);
    if (poh < 100 && tb >= 2) reasons.push(L(`通电只有 ${poh} 小时，却已写入 ${tb.toFixed(1)} TB`, `Only ${poh} power-on hours but ${tb.toFixed(1)} TB written`));
    if (poh < 100 && n.powerCycles > 200) reasons.push(L(`通电只有 ${poh} 小时，却开关机 ${n.powerCycles} 次`, `Only ${poh} power-on hours but ${n.powerCycles} power cycles`));
    if (poh < 100 && n.percentageUsed >= 3) reasons.push(L(`通电只有 ${poh} 小时，寿命却已用 ${n.percentageUsed}%`, `Only ${poh} power-on hours but ${n.percentageUsed}% of life used`));
    if (poh < 100 && n.unsafeShutdowns > 30) reasons.push(L(`通电只有 ${poh} 小时，意外断电却有 ${n.unsafeShutdowns} 次`, `Only ${poh} power-on hours but ${n.unsafeShutdowns} unsafe shutdowns`));
  } else {
    const startStop = raw(d, 4) || 0, loads = raw(d, 193) || raw(d, 225) || 0, realloc = (raw(d, 5) || 0) + (raw(d, 196) || 0);
    if (poh < 200 && cycles > 150) reasons.push(L(`通电只有 ${poh} 小时，却开关机 ${cycles} 次`, `Only ${poh} power-on hours but ${cycles} power cycles`));
    if (isHdd(d) && poh < 200 && startStop > 500) reasons.push(L(`通电只有 ${poh} 小时，马达启停却有 ${startStop} 次`, `Only ${poh} power-on hours but ${startStop} spin-ups`));
    if (isHdd(d) && poh < 200 && loads > 2000) reasons.push(L(`通电只有 ${poh} 小时，磁头加载却有 ${loads} 次`, `Only ${poh} power-on hours but ${loads} head load cycles`));
    if (poh < 200 && realloc > 0) reasons.push(L(`几乎全新（${poh} 小时）却已有重映射扇区`, `Almost new (${poh} h) but already has reallocated sectors`));
    if (isSsd(d) && poh < 100 && s.health != null && s.health < 95) reasons.push(L(`通电只有 ${poh} 小时，寿命却剩 ${s.health}%`, `Only ${poh} power-on hours but ${s.health}% life left`));
  }
  return { suspect: reasons.length > 0, reasons };
}

const GRADE_TEXT = () => ({
  A: L('成色很好，可以正常价收购，也适合当二手好盘卖。', 'Like new. Buy at a normal price; fine to resell as a good used drive.'),
  B: L('有正常使用痕迹，可以收购，价格打折。', 'Normal wear. OK to buy at a discount.'),
  C: L('用得多或有疑点，只适合低价收购或做备用盘。', 'Heavily used or questionable. Only at a low price or as a spare.'),
  D: L('不建议收购：有坏道或故障迹象。', 'Do not buy: bad sectors or signs of failure.'),
});

// grade(disk, summary, scanBad) -> { grade: 'A'|'B'|'C'|'D'|null, text, reasons }
function grade(d, s, scanBad = 0) {
  if (!d.smartOk || s.health == null) return { grade: null, text: L('无法读取 SMART，不能评级。', 'SMART not readable; no grade.'), reasons: [] };
  const why = { D: [], C: [], B: [] };
  const poh = s.powerOnHours || 0;
  if (s.status === 'bad') why.D.push(L('SMART 判定危险', 'SMART status is bad'));
  if (scanBad > 0) why.D.push(L(`坏道扫描发现 ${scanBad} 个坏道`, `${scanBad} bad sectors found by the surface scan`));
  if (d.nvme) {
    const n = d.nvme, tb = writtenTb(d), share = tb / ratedTbw(d);
    if (n.mediaErrors > 0) why.D.push(L(`介质错误 ${n.mediaErrors}`, `${n.mediaErrors} media errors`));
    if (n.criticalWarning) why.D.push(L('NVMe 严重警告', 'NVMe critical warning'));
    if (s.health < 50) why.D.push(L(`寿命只剩 ${s.health}%`, `Only ${s.health}% life left`));
    else if (s.health < 80) why.C.push(L(`寿命剩 ${s.health}%`, `${s.health}% life left`));
    else if (s.health < 95) why.B.push(L(`寿命剩 ${s.health}%`, `${s.health}% life left`));
    if (share > 0.5) why.C.push(L(`写入量 ${tb.toFixed(0)} TB，偏多`, `${tb.toFixed(0)} TB written (a lot)`));
    else if (share > 0.2) why.B.push(L(`写入量 ${tb.toFixed(0)} TB`, `${tb.toFixed(0)} TB written`));
    if (poh >= 20000) why.C.push(L(`通电 ${poh} 小时`, `${poh} power-on hours`));
    else if (poh >= 8000) why.B.push(L(`通电 ${poh} 小时`, `${poh} power-on hours`));
  } else {
    const realloc = raw(d, 5) || 0, pending = raw(d, 197) || 0, unc = raw(d, 198) || 0;
    if (realloc) why.D.push(L(`重映射扇区 ${realloc}`, `${realloc} reallocated sectors`));
    if (pending) why.D.push(L(`待映射扇区 ${pending}`, `${pending} pending sectors`));
    if (unc) why.D.push(L(`无法修正扇区 ${unc}`, `${unc} uncorrectable sectors`));
    if (s.status === 'warn' && !why.D.length) why.C.push(L('SMART 需要注意', 'SMART needs attention'));
    if (isSsd(d)) {
      if (s.health < 50) why.D.push(L(`寿命只剩 ${s.health}%`, `Only ${s.health}% life left`));
      else if (s.health < 80) why.C.push(L(`寿命剩 ${s.health}%`, `${s.health}% life left`));
      else if (s.health < 95) why.B.push(L(`寿命剩 ${s.health}%`, `${s.health}% life left`));
      if (poh >= 20000) why.C.push(L(`通电 ${poh} 小时`, `${poh} power-on hours`));
      else if (poh >= 8000) why.B.push(L(`通电 ${poh} 小时`, `${poh} power-on hours`));
    } else {
      if (poh >= 30000) why.C.push(L(`通电 ${poh} 小时（约 ${Math.round(poh / 8760)} 年）`, `${poh} power-on hours (about ${Math.round(poh / 8760)} years)`));
      else if (poh >= 10000) why.B.push(L(`通电 ${poh} 小时`, `${poh} power-on hours`));
    }
  }
  const rf = refurbCheck(d, s);
  if (rf.suspect) why.C.push(L('疑似翻新盘', 'Possibly refurbished'));
  const g = why.D.length ? 'D' : why.C.length ? 'C' : why.B.length ? 'B' : 'A';
  return { grade: g, text: GRADE_TEXT()[g], reasons: g === 'A' ? [] : why[g] };
}

module.exports = { grade, refurbCheck };
