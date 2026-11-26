// Renders the A4 report. main.js loads this page in a hidden window, calls renderReport(payload), then printToPDF.
// Chinese mode keeps the report bilingual ("中文 English"); English mode prints English only.
const { L } = window.I18N;
const B = (zh, en) => L(`${zh} ${en}`, en);
const STATUS = {
  good: [() => B('良好', 'Good'), 'bg-good'],
  warn: [() => B('注意', 'Caution'), 'bg-warn'],
  bad: [() => B('危险', 'Bad'), 'bg-bad'],
  unknown: [() => B('未知', 'Unknown'), 'bg-unknown'],
};
const BUS = { sata: 'SATA', nvme: 'NVMe', usb: 'USB', other: 'Other' };

function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function size(b) { if (!b) return '-'; return b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : Math.round(b / 1e9) + ' GB'; }
function num(n) { return n == null ? '-' : Number(n).toLocaleString('en-US'); }
function dt(iso) { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function pill(s) { const [t, c] = STATUS[s] || STATUS.unknown; return `<span class="pill ${c}">${t()}</span>`; }
function raw(d, id) { return d.ata?.attributes.find(a => a.id === id)?.raw; }

function overall(disks) {
  // A surface scan that found unreadable sectors makes the drive "bad" whatever SMART says.
  if (disks.some(d => (TESTS[d.serial || `${d.model}#${d.index}`]?.scan?.bad || 0) > 0)) return 'bad';
  const order = ['bad', 'warn', 'unknown', 'good'];
  for (const s of order) if (disks.some(d => d.summary.status === s)) return s;
  return 'unknown';
}

let TESTS = {};
let GRADE_ON = true;
let SETTINGS = {};   // the shop can turn the buyback grade off in Settings
const GRADE_TEXT = () => ({ A: B('成色很好', 'Like new'), B: B('正常使用痕迹', 'Normal wear'), C: B('用得多或有疑点', 'Heavily used / questionable'), D: B('不建议收购', 'Not recommended') });

// QR code with the key facts as plain text, so any phone camera can read it for warranty checks (no internet needed).
function qrText(p) {
  const st = p.settings || {};
  const lines = [`smartCheck ${L('检测记录', 'inspection')}`, st.shopName || '', `${L('日期', 'Date')}: ${dt(p.scan.scannedAt)}`];
  if (p.orderNo) lines.push(`${L('单号', 'Ref')}: ${p.orderNo}`);
  (p.scan.disks || []).forEach((d, i) => lines.push(`${i + 1}. ${d.model || '-'} S/N ${d.serial || '-'} ${d.summary.health != null ? d.summary.health + '%' : '-'}${GRADE_ON && d.summary.grade?.grade ? ' ' + L('评级', 'Grade') + ' ' + d.summary.grade.grade : ''}`));
  return lines.filter(Boolean).join('\n').slice(0, 900);
}
function qrSvg(text) {
  try {
    const q = window.qrcode(0, 'M');
    q.addData(text, 'Byte');
    q.make();
    return q.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
  } catch { return ''; }
}
const fmtMb = v => v == null ? '-' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 1 : 2);
function dur(sec) { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : `${sec} s`; }

// Benchmark and surface-scan lines for one disk (only when they were run this session).
function testLines(d) {
  const t = TESTS[d.serial || `${d.model}#${d.index}`];
  if (!t) return '';
  const out = [];
  const b = t.bench;
  if (b && b.status === 'done') {
    const r = b.results || {};
    out.push(`<div class="test"><span>${B('测速', 'Speed')} (${esc(b.letter)})</span>
      ${B('顺序读', 'Seq R')} <b>${fmtMb(r.seqRead?.mbps)}</b> · ${B('顺序写', 'Seq W')} <b>${fmtMb(r.seqWrite?.mbps)}</b> ·
      ${r.seqQ1Read ? `1M Q1 ${L('读/写', 'R/W')} <b>${fmtMb(r.seqQ1Read?.mbps)}</b> / <b>${fmtMb(r.seqQ1Write?.mbps)}</b> ·` : ''}
      4K Q32 ${L('读/写', 'R/W')} <b>${fmtMb(r.rnd4kQ32Read?.mbps)}</b> / <b>${fmtMb(r.rnd4kQ32Write?.mbps)}</b> ·
      4K Q1 ${L('读/写', 'R/W')} <b>${fmtMb(r.rnd4kQ1Read?.mbps)}</b> / <b>${fmtMb(r.rnd4kQ1Write?.mbps)}</b> MB/s</div>`);
  }
  const stt = t.selftest;
  if (stt) {
    const ok = stt.result === 'passed', aborted = stt.result === 'aborted' || stt.result === 'interrupted';
    out.push(`<div class="test"><span>${B('SMART 自检', 'Self-test')}</span>${stt.type === 'long' ? B('长测', 'Long') : B('短测', 'Short')} · <b class="${ok ? 'ok' : aborted ? 'warn' : 'bad'}">${ok ? B('通过', 'Passed') : aborted ? B('被中断', 'Aborted') : B('失败', 'Failed')}</b>${stt.lba != null ? ` · LBA ${num(stt.lba)}` : ''}</div>`);
  }
  const sc = t.scan;
  if (sc && sc.pct > 0) {
    const full = sc.status === 'done';
    const slow = (sc.slow || 0) + (sc.verySlow || 0);
    const verdict = sc.bad ? `<b class="bad">${L(`发现 ${num(sc.bad)} 个坏道 Bad sectors found`, `${num(sc.bad)} bad sectors found`)}</b>` : slow ? `<b class="warn">${L(`无坏道，${num(slow)} 处读取较慢`, `No bad sectors, ${num(slow)} slow areas`)}</b>` : `<b class="ok">${B('无坏道', 'No bad sectors')}</b>`;
    out.push(`<div class="test"><span>${B('坏道扫描', 'Surface scan')}</span>${full ? L(`全盘 100%，用时 ${dur(sc.seconds)}`, `Full disk, ${dur(sc.seconds)}`) : L(`只扫描了 ${sc.pct.toFixed(1)}%（中途停止）`, `Only ${sc.pct.toFixed(1)}% scanned (stopped)`)} · ${verdict}</div>`);
  }
  return out.join('');
}

function diskDetail(d, i) {
  const s = d.summary;
  const kv = [
    [B('序列号', 'S/N'), esc(d.serial) || '-'],
    [B('固件', 'FW'), esc(d.firmware) || '-'],
    [B('通电时间', 'POH'), s.powerOnHours != null ? num(s.powerOnHours) + ' h' : '-'],
    [B('通电次数', 'Cycles'), num(s.powerCycles)],
  ];
  if (s.kind) kv.push([B('类型', 'Type'), esc(s.kind)]);
  if (s.link) kv.push([B('接口速度', 'Link'), esc(s.link.text)]);
  if (d.nvme) {
    const n = d.nvme;
    kv.push([B('寿命已用', 'Used'), n.percentageUsed + ' %'], [B('可用备用', 'Spare'), n.availableSpare + ' %'],
      [B('累计写入', 'Written'), (n.dataUnitsWritten * 512000 / 1e12).toFixed(1) + ' TB'], [B('介质错误', 'Media Err'), num(n.mediaErrors)]);
  } else if (d.ata) {
    kv.push([B('重映射', 'Reallocated'), num(raw(d, 5) ?? 0)], [B('待映射', 'Pending'), num(raw(d, 197) ?? 0)],
      [B('无法修正', 'Uncorrectable'), num(raw(d, 198) ?? 0)], [L('CRC 错误', 'CRC errors'), num(raw(d, 199) ?? 0)]);
  }
  const why = !d.smartOk
    ? (d.bus === 'usb' ? L('USB 硬盘盒不支持读取 SMART，未检测。', 'USB enclosure does not pass SMART through; not checked.') : esc(s.reasons[0] || L('无法读取 SMART', 'SMART could not be read')))
    : s.reasons.map(esc).join(L('；', '; '));
  const alerts = [];
  const scanBad = TESTS[d.serial || `${d.model}#${d.index}`]?.scan?.bad || 0;
  const stFail = /^(fatal|failed)/.test(TESTS[d.serial || `${d.model}#${d.index}`]?.selftest?.result || '');
  const g = scanBad && s.grade?.grade ? { grade: 'D', reasons: [L(`坏道扫描发现 ${num(scanBad)} 个坏道`, `${num(scanBad)} bad sectors found`)] }
    : stFail && s.grade?.grade ? { grade: 'D', reasons: [L('SMART 自检失败', 'SMART self-test failed')] } : s.grade;
  if (GRADE_ON && g?.grade) alerts.push(`<div class="test"><span>${B('收购评级', 'Grade')}</span><b class="grade g${g.grade}">${g.grade}</b> ${esc(GRADE_TEXT()[g.grade])}${g.reasons?.length ? ` <small>(${g.reasons.map(esc).join(L('；', '; '))})</small>` : ''}</div>`);
  if (s.refurb?.suspect) alerts.push(`<div class="why">⚠ ${B('疑似翻新盘', 'Possibly refurbished')}: ${s.refurb.reasons.map(esc).join(L('；', '; '))}</div>`);
  if (s.firmwareWarning) alerts.push(`<div class="why bad">⚠ ${esc(s.firmwareWarning.text)}</div>`);
  if (s.link?.note) alerts.push(`<div class="why">⚠ ${esc(s.link.note)}</div>`);
  return `<div class="disk">
    <div class="hd"><span>${i + 1}. ${esc(d.model) || L('未知型号', 'Unknown model')} · ${BUS[d.bus] || esc(d.bus)} · ${size(d.sizeBytes)}</span>
      <span>${s.health != null ? s.health + '%' : '--'} ${pill(s.status)}</span></div>
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('')}</div>
    ${testLines(d)}
    ${why ? `<div class="why">⚠ ${why}</div>` : ''}
    ${alerts.join('')}
  </div>`;
}

// Whole-PC section (CPU, RAM, GPU, board, Windows activation, battery).
function systemSection(sys) {
  if (!sys || sys.error) return '';
  const rows = [];
  const c = sys.computer || {};
  if (c.manufacturer || c.model) rows.push([B('电脑型号', 'Model'), esc([c.manufacturer, c.model].filter(Boolean).join(' '))]);
  if (sys.os?.caption) rows.push([B('系统', 'Windows'), esc(`${sys.os.caption} ${sys.os.arch || ''} (Build ${sys.os.build || '-'})`)]);
  rows.push([B('激活', 'Activation'), sys.activated === true ? `<b class="ok">${esc(sys.activationText)}</b>${sys.activation?.channel ? ' · ' + esc(sys.activation.channel) : ''}`
    : sys.activated === false ? `<b class="bad">${esc(sys.activationText)}</b>` : esc(sys.activationText)]);
  (sys.cpu || []).forEach(p => rows.push([B('处理器', 'CPU'), esc(L(`${p.name} · ${p.cores} 核 ${p.threads} 线程`, `${p.name} · ${p.cores} cores ${p.threads} threads`))]));
  if (sys.memTotalGB) rows.push([B('内存', 'RAM'), `${sys.memTotalGB} GB<span class="sub">${(sys.memText || []).map(esc).join('<br>')}</span>`]);
  (sys.gpu || []).forEach(g => rows.push([B('显卡', 'GPU'), esc(g.name) + (g.driver ? `<span class="sub">${L('驱动', 'Driver')} ${esc(g.driver)}</span>` : '')]));
  const b = sys.board || {};
  if (b.product) rows.push([B('主板', 'Board'), esc(`${b.manufacturer || ''} ${b.product}`) + (b.bios ? `<span class="sub">BIOS ${esc(b.bios)}${b.biosDate ? ' (' + esc(b.biosDate) + ')' : ''}</span>` : '')]);
  const bat = sys.batteryInfo;
  // The full battery report below replaces this short row when it was read.
  if (bat && !(TESTS.pc?.battery && String(SETTINGS?.f_battery ?? '1') !== '0')) rows.push([B('电池', 'Battery'), `${L('损耗', 'Wear')} ${bat.wear}%<span class="sub">${L(`设计 ${num(bat.design)} mWh · 当前满电 ${num(bat.full)} mWh`, `Design ${num(bat.design)} mWh · full now ${num(bat.full)} mWh`)}${bat.cycles ? L(` · 充电 ${num(bat.cycles)} 次`, ` · ${num(bat.cycles)} cycles`) : ''}</span>`]);
  const temps = (sys.sensors || []).filter(x => x.kind === 'temp' || x.kind === 'fan');
  if (temps.length) rows.push([B('温度 / 风扇', 'Temps / fans'), temps.map(x => `<span class="${x.level === 'ok' ? '' : x.level === 'warn' ? 'warn' : 'bad'}">${esc(x.name)} ${esc(x.value)}${esc(x.unit)}</span>`).join(' · ')]);
  // Burn-in, memory test and full battery report, when they were run before printing.
  const pc = TESTS.pc || {};
  const on = f => String(SETTINGS?.['f_' + f] ?? '1') !== '0';
  const bn = pc.burn, br = bn?.result;
  if (br && on('burn')) {
    const V = { pass: ['ok', B('通过', 'Pass')], warn: ['warn', B('需要注意', 'Caution')], fail: ['bad', B('不通过', 'Fail')], canceled: ['', B('未完成', 'Not finished')] }[br.verdict] || ['', ''];
    rows.push([B('烤机测试', 'Burn-in'), `<b class="${V[0]}">${V[1]}</b> · ${Math.round((br.seconds || 0) / 60)} ${L('分钟', 'min')}${bn.gpu ? ' · CPU + GPU' : ' · CPU'}${bn.level === 'high' ? L(' · 高强度', ' · high intensity') : bn.level === 'std' ? L(' · 标准', ' · standard') : ''}`
      + `<span class="sub">${[br.cpuMax != null ? `CPU ${L('最高', 'max')} ${br.cpuMax} °C` : '', bn.gpu && br.gpuMax != null ? `GPU ${L('最高', 'max')} ${br.gpuMax} °C` : '',
        br.clockStart ? `${br.clockStart} → ${br.clockEnd || '-'} MHz` : '', ...(br.reasons || [])].filter(Boolean).map(esc).join(' · ')}</span>`]);
  }
  const mm = pc.mem;
  if (mm && on('memtest')) rows.push([B('内存测试', 'Memory test'), mm.errors ? `<b class="bad">${L(`发现 ${mm.errors} 个错误`, `${mm.errors} errors`)}</b>` : `<b class="ok">${B('没有错误', 'No errors')}</b>`
    + `<span class="sub">${L(`测了 ${Math.round(mm.testedBytes / 1024 ** 3 * 10) / 10} GB · ${mm.passes} 遍`, `${Math.round(mm.testedBytes / 1024 ** 3 * 10) / 10} GB tested · ${mm.passes} pass(es)`)}</span>`]);
  const bt = pc.battery;
  if (bt && on('battery')) {
    const hm = m => (m == null ? '-' : `${Math.floor(m / 60)}h ${m % 60}m`);
    rows.push([B('电池报告', 'Battery report'), `${L('损耗', 'Wear')} <b class="${bt.wear >= 40 ? 'bad' : bt.wear >= 20 ? 'warn' : 'ok'}">${bt.wear ?? '-'}%</b> · ${L('充电', 'Cycles')} ${num(bt.cycles)}`
      + `<span class="sub">${L(`满电 ${num(bt.full)} / 设计 ${num(bt.design)} mWh · 现在可用约 ${hm(bt.runtimeNow)}（新电池 ${hm(bt.runtimeNew)}）`, `Full ${num(bt.full)} / design ${num(bt.design)} mWh · runtime now about ${hm(bt.runtimeNow)} (new ${hm(bt.runtimeNew)})`)}</span>`]);
  }
  return `<h2>${B('整机信息', 'System')}</h2><table class="sys">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
}

window.renderReport = (p) => {
  window.I18N.setLang(p.lang);
  TESTS = p.tests || {};
  GRADE_ON = String(p.settings?.f_grade ?? '1') !== '0';
  SETTINGS = p.settings || {};
  const disks = p.scan.disks || [];
  // A surface scan that found bad sectors, or a failed SMART self-test, makes the drive "replace soon" whatever SMART says.
  for (const d of disks) {
    const t = TESTS[d.serial || `${d.model}#${d.index}`], s = d.summary;
    if (s && s.status !== 'bad' && t && (t.scan?.bad > 0 || /^(fatal|failed)/.test(t.selftest?.result || ''))) s.status = 'bad';
  }
  const ov = overall(disks);
  const ovText = {
    good: B('所有硬盘状况良好', 'All drives are healthy'),
    warn: B('有硬盘需要注意，建议备份资料', 'Some drives need attention — back up your data'),
    bad: B('有硬盘状况危险，建议尽快更换', 'A drive is failing — replace it soon'),
    unknown: B('部分硬盘无法检测', 'Some drives could not be checked'),
  }[ov];
  const st = p.settings;

  document.getElementById('page').innerHTML = `
    <div class="top">
      <img src="img/smartCheck_horizontal.svg" alt="smartCheck">
      <div class="shop"><b>${esc(st.shopName)}</b>${esc(st.shopAddress)}<br>${esc(st.shopContact)}</div>
    </div>

    <h1>${L('电脑检测报告<small>PC Inspection Report</small>', 'PC Inspection Report')}</h1>
    <div class="meta">
      <div><span>${B('客户', 'Customer')}</span>${esc(p.customer) || '-'}</div>
      <div><span>${B('单号', 'Ref No.')}</span>${esc(p.orderNo) || '-'}</div>
      <div><span>${B('检测时间', 'Date')}</span>${dt(p.scan.scannedAt)}</div>
      <div><span>${B('电脑名称', 'PC')}</span>${esc(p.scan.computer?.name) || '-'}</div>
      <div><span>${B('系统', 'OS')}</span>${esc(p.scan.computer?.os) || '-'}</div>
      <div><span>${B('检测人员', 'Tech')}</span>${esc(p.technician) || '-'}</div>
    </div>

    <div class="verdict ${STATUS[ov][1]}"><span>${ovText}</span><small>${L(`共 ${disks.length} 块硬盘 · `, '')}${disks.length} drive(s)</small></div>

    ${systemSection(p.scan.system)}

    <h2>${B('硬盘检测结果', 'Disk Summary')}</h2>
    <table>
      <thead><tr><th>#</th><th>${B('型号', 'Model')}</th><th>${L('接口', 'Bus')}</th><th class="r">${L('容量', 'Size')}</th><th class="r">${L('温度', 'Temp')}</th><th class="r">${L('健康度', 'Health')}</th><th>${B('状态', 'Status')}</th></tr></thead>
      <tbody>${disks.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.model) || '-'}${d.letters?.length ? ' (' + esc(d.letters.join(' ')) + ')' : ''}</td><td>${BUS[d.bus] || esc(d.bus)}</td>
        <td class="r">${size(d.sizeBytes)}</td><td class="r">${d.summary.temperatureC != null ? d.summary.temperatureC + ' °C' : '-'}</td>
        <td class="r">${d.summary.health != null ? d.summary.health + '%' : '-'}</td><td>${pill(d.summary.status)}</td></tr>`).join('')}</tbody>
    </table>

    <h2>${B('硬盘详情', 'Details')}</h2>
    ${disks.map(diskDetail).join('')}
    <div class="legend">${L('健康度根据 SATA SMART 属性（重映射、待映射、无法修正扇区、SSD 寿命）或 NVMe 健康日志（严重警告、备用空间、寿命已用）计算，仅供参考。<br>', '')}
      Health is estimated from SMART / NVMe health data and is for reference only.</div>

    ${p.note ? `<h2>${B('备注', 'Remarks')}</h2><div class="note">${esc(p.note)}</div>` : ''}

    <div class="sign"><div>${B('检测人员签名', 'Technician')}</div><div>${B('客户签名', 'Customer')}</div>
      <div class="qr">${qrSvg(qrText(p))}<small>${B('扫码核对', 'Scan to verify')}</small></div></div>
    <div class="foot"><span>smartCheck v${esc(p.version)} · ${L('报告生成', 'Printed')} ${dt(p.printedAt)}${p.scan.mock ? ' · ' + B('演示数据', 'DEMO') : ''}</span>
      <span>© 2026 PLANET COMPUTER TECHNOLOGY CENTRE</span></div>`;
};
