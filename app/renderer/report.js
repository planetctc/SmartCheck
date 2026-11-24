// Renders the A4 report. main.js loads this page in a hidden window, calls renderReport(payload), then printToPDF.
const STATUS = {
  good: ['良好 Good', 'bg-good'],
  warn: ['注意 Caution', 'bg-warn'],
  bad: ['危险 Bad', 'bg-bad'],
  unknown: ['未知 Unknown', 'bg-unknown'],
};
const BUS = { sata: 'SATA', nvme: 'NVMe', usb: 'USB', other: '其他' };

function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function size(b) { if (!b) return '-'; return b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : Math.round(b / 1e9) + ' GB'; }
function num(n) { return n == null ? '-' : Number(n).toLocaleString('en-US'); }
function dt(iso) { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function pill(s) { const [t, c] = STATUS[s] || STATUS.unknown; return `<span class="pill ${c}">${t}</span>`; }
function raw(d, id) { return d.ata?.attributes.find(a => a.id === id)?.raw; }

function overall(disks) {
  const order = ['bad', 'warn', 'unknown', 'good'];
  for (const s of order) if (disks.some(d => d.summary.status === s)) return s;
  return 'unknown';
}

function diskDetail(d, i) {
  const s = d.summary;
  const kv = [
    ['序列号 S/N', esc(d.serial) || '-'],
    ['固件 FW', esc(d.firmware) || '-'],
    ['通电时间 POH', s.powerOnHours != null ? num(s.powerOnHours) + ' h' : '-'],
    ['通电次数 Cycles', num(s.powerCycles)],
  ];
  if (d.nvme) {
    const n = d.nvme;
    kv.push(['寿命已用 Used', n.percentageUsed + ' %'], ['可用备用 Spare', n.availableSpare + ' %'],
      ['累计写入 Written', (n.dataUnitsWritten * 512000 / 1e12).toFixed(1) + ' TB'], ['介质错误 Media Err', num(n.mediaErrors)]);
  } else if (d.ata) {
    kv.push(['重映射 Reallocated', num(raw(d, 5) ?? 0)], ['待映射 Pending', num(raw(d, 197) ?? 0)],
      ['无法修正 Uncorrectable', num(raw(d, 198) ?? 0)], ['CRC 错误', num(raw(d, 199) ?? 0)]);
  }
  const why = !d.smartOk
    ? (d.bus === 'usb' ? 'USB 硬盘盒不支持读取 SMART，未检测。' : esc(s.reasons[0] || '无法读取 SMART'))
    : s.reasons.map(esc).join('；');
  return `<div class="disk">
    <div class="hd"><span>${i + 1}. ${esc(d.model) || '未知型号'} · ${BUS[d.bus] || esc(d.bus)} · ${size(d.sizeBytes)}</span>
      <span>${s.health != null ? s.health + '%' : '--'} ${pill(s.status)}</span></div>
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('')}</div>
    ${why ? `<div class="why">⚠ ${why}</div>` : ''}
  </div>`;
}

window.renderReport = (p) => {
  const disks = p.scan.disks || [];
  const ov = overall(disks);
  const ovText = {
    good: '所有硬盘状况良好 All drives are healthy',
    warn: '有硬盘需要注意，建议备份资料 Some drives need attention — back up your data',
    bad: '有硬盘状况危险，建议尽快更换 A drive is failing — replace it soon',
    unknown: '部分硬盘无法检测 Some drives could not be checked',
  }[ov];
  const st = p.settings;

  document.getElementById('page').innerHTML = `
    <div class="top">
      <img src="img/smartDisk_horizontal.svg" alt="smartDisk">
      <div class="shop"><b>${esc(st.shopName)}</b>${esc(st.shopAddress)}<br>${esc(st.shopContact)}</div>
    </div>

    <h1>硬盘健康检测报告<small>Disk Health Report</small></h1>
    <div class="meta">
      <div><span>客户 Customer</span>${esc(p.customer) || '-'}</div>
      <div><span>单号 Ref No.</span>${esc(p.orderNo) || '-'}</div>
      <div><span>检测时间 Date</span>${dt(p.scan.scannedAt)}</div>
      <div><span>电脑名称 PC</span>${esc(p.scan.computer?.name) || '-'}</div>
      <div><span>系统 OS</span>${esc(p.scan.computer?.os) || '-'}</div>
      <div><span>检测人员 Tech</span>${esc(p.technician) || '-'}</div>
    </div>

    <div class="verdict ${STATUS[ov][1]}"><span>${ovText}</span><small>共 ${disks.length} 块硬盘 · ${disks.length} drive(s)</small></div>

    <h2>检测结果 Summary</h2>
    <table>
      <thead><tr><th>#</th><th>型号 Model</th><th>接口</th><th class="r">容量</th><th class="r">温度</th><th class="r">健康度</th><th>状态 Status</th></tr></thead>
      <tbody>${disks.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.model) || '-'}</td><td>${BUS[d.bus] || esc(d.bus)}</td>
        <td class="r">${size(d.sizeBytes)}</td><td class="r">${d.summary.temperatureC != null ? d.summary.temperatureC + ' °C' : '-'}</td>
        <td class="r">${d.summary.health != null ? d.summary.health + '%' : '-'}</td><td>${pill(d.summary.status)}</td></tr>`).join('')}</tbody>
    </table>

    <h2>硬盘详情 Details</h2>
    ${disks.map(diskDetail).join('')}
    <div class="legend">健康度根据 SATA SMART 属性（重映射、待映射、无法修正扇区、SSD 寿命）或 NVMe 健康日志（严重警告、备用空间、寿命已用）计算，仅供参考。
      Health is estimated from SMART / NVMe health data and is for reference only.</div>

    ${p.note ? `<h2>备注 Remarks</h2><div class="note">${esc(p.note)}</div>` : ''}

    <div class="sign"><div>检测人员签名 Technician</div><div>客户签名 Customer</div></div>
    <div class="foot"><span>smartDisk v${esc(p.version)} · 报告生成 ${dt(p.printedAt)}${p.scan.mock ? ' · 演示数据 DEMO' : ''}</span>
      <span>© 2026 PLANET COMPUTER TECHNOLOGY CENTRE</span></div>`;
};
