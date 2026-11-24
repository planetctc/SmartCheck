const $ = (s) => document.querySelector(s);
const { L } = window.I18N;
const statusText = (s) => ({ good: L('状况良好', 'Good'), warn: L('需要注意', 'Caution'), bad: L('建议更换', 'Replace soon'), unknown: L('无法判断', 'Unknown') })[s];
const busText = (b) => ({ sata: 'SATA', nvme: 'NVMe', usb: 'USB', other: L('其他', 'Other') })[b] || b;

// Static page text: Chinese is in the HTML, English in data-en / data-en-ph.
function applyLang() {
  document.documentElement.lang = window.I18N.getLang() === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-en]').forEach(el => {
    const node = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
    if (!node) return;
    if (el.dataset.zh == null) el.dataset.zh = node.textContent;
    node.textContent = L(el.dataset.zh, el.dataset.en);
  });
  document.querySelectorAll('[data-en-ph]').forEach(el => {
    if (el.dataset.zhPh == null) el.dataset.zhPh = el.placeholder;
    el.placeholder = L(el.dataset.zhPh, el.dataset.enPh);
  });
}

let data = null;
let current = 0;   // disk index, or -1 for the "本机信息" page

function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function size(bytes) { if (!bytes) return '-'; return bytes >= 1e12 ? (bytes / 1e12).toFixed(2) + ' TB' : Math.round(bytes / 1e9) + ' GB'; }
function color(s) { return `var(--${s || 'unknown'})`; }
function letters(d) { return d.letters?.length ? d.letters.join(' ') : ''; }
function num(n) { return n == null ? '-' : Number(n).toLocaleString(); }

// ---- skins ----
const LIGHT_THEMES = ['planet', 'light'];
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.tone = LIGHT_THEMES.includes(t) ? 'light' : 'dark';
  try { localStorage.setItem('theme', t); } catch {}
}
let saved = null;
try { saved = localStorage.getItem('theme'); } catch {}
if (saved && document.querySelector(`#theme option[value="${saved}"]`)) $('#theme').value = saved;
applyTheme($('#theme').value);
$('#theme').addEventListener('change', e => applyTheme(e.target.value));

// ---- pieces ----
function gauge(pct, status) {
  const r = 78, c = 2 * Math.PI * r;
  const p = pct == null ? 0 : pct / 100;
  return `<svg class="gauge" viewBox="0 0 190 190">
    <circle class="track" cx="95" cy="95" r="${r}" fill="none" stroke-width="14"/>
    <circle cx="95" cy="95" r="${r}" fill="none" stroke="${color(status)}" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${c * p} ${c}" transform="rotate(-90 95 95)"/>
    <text class="v" x="95" y="100" text-anchor="middle">${pct == null ? '--' : pct + '%'}</text>
    <text class="l" x="95" y="124" text-anchor="middle">${L('健康度', 'Health')}</text>
  </svg>`;
}

function metric(k, v, unit = '', cls = '') {
  return `<div class="metric ${cls}"><div class="k">${k}</div><div class="v">${esc(v)}${unit ? `<small>${unit}</small>` : ''}</div></div>`;
}

function rawOf(d, id) { return d.ata?.attributes.find(a => a.id === id)?.raw; }

function metricsFor(d, s) {
  const t = s.temperatureC;
  const tCls = t == null ? '' : t >= 60 ? 'danger' : t >= 50 ? 'alert' : '';
  const list = [
    metric(L('温度', 'Temperature'), t ?? '--', t == null ? '' : '°C', tCls),
    metric(L('通电时间', 'Power-on time'), num(s.powerOnHours), L('小时', 'h')),
    metric(L('通电次数', 'Power cycles'), num(s.powerCycles), L('次', '')),
  ];
  if (d.nvme) {
    const n = d.nvme;
    list.push(
      metric(L('寿命已用', 'Life used'), n.percentageUsed, '%', n.percentageUsed >= 90 ? 'alert' : ''),
      metric(L('累计写入', 'Data written'), (n.dataUnitsWritten * 512000 / 1e12).toFixed(1), 'TB'),
      metric(L('介质错误', 'Media errors'), num(n.mediaErrors), '', n.mediaErrors ? 'alert' : ''),
      metric(L('可用备用空间', 'Available spare'), n.availableSpare, '%', n.availableSpare < n.spareThreshold ? 'danger' : ''),
    );
  } else if (d.ata) {
    const re = rawOf(d, 5) ?? 0, pend = rawOf(d, 197) ?? 0, unc = rawOf(d, 198) ?? 0, crc = rawOf(d, 199) ?? 0;
    list.push(
      metric(L('重映射扇区', 'Reallocated'), num(re), '', re ? 'alert' : ''),
      metric(L('待映射扇区', 'Pending'), num(pend), '', pend ? 'alert' : ''),
      metric(L('无法修正扇区', 'Uncorrectable'), num(unc), '', unc ? 'danger' : ''),
      metric(L('线材 CRC 错误', 'Cable CRC errors'), num(crc), '', crc ? 'alert' : ''),
    );
  }
  const l = s.link;
  list.push(metric(L('接口速度', 'Interface'), l ? l.text : '--', '', (l && l.state === 'warn' ? 'alert ' : '') + 'txt'));
  const [kt, ...kr] = (s.kind || '--').split(' ');
  list.push(metric(L('类型', 'Type'), kt, kr.join(' '), 'txt'));
  return list.join('');
}

function rawTable(d, s) {
  if (!s.rows.length) return '';
  const STATE = { ok: L('正常', 'OK'), warn: L('注意', 'Caution'), bad: L('异常', 'Bad') };
  if (d.nvme) {
    return `<details class="raw"><summary>${L('详细数据（NVMe 健康日志）', 'Details (NVMe health log)')}</summary><div class="attr-list">
      ${s.rows.map(r => `<div class="attr nv"><span class="n">${esc(r.name)}</span><span class="r st-${r.state}">${esc(r.value)}</span></div>`).join('')}
    </div></details>`;
  }
  return `<details class="raw"><summary>${L(`详细数据（SMART 属性 ${s.rows.length} 项）`, `Details (${s.rows.length} SMART attributes)`)}</summary><div class="attr-list">
    <div class="attr hdr"><span>${L('属性', 'Attribute')}</span><span class="r">${L('原始值', 'Raw')}</span><span class="r">${L('当前', 'Current')}</span><span class="r">${L('阈值', 'Threshold')}</span><span class="r">${L('状态', 'Status')}</span></div>
    ${s.rows.map(r => `<div class="attr"><span class="n">${esc(r.name)}<small>#${r.id}</small></span>
      <span class="r">${esc(r.rawText)}</span><span class="r">${r.current}</span><span class="r">${r.threshold}</span>
      <span class="r st-${r.state}">${STATE[r.state]}</span></div>`).join('')}
  </div></details>`;
}

// ---- benchmark / surface scan ----
const BENCH_ROWS = () => [[L('顺序 1M Q8', 'Seq 1M Q8'), 'seqRead', 'seqWrite'], [L('顺序 1M Q1', 'Seq 1M Q1'), 'seqQ1Read', 'seqQ1Write'], [L('随机 4K Q32', 'Random 4K Q32'), 'rnd4kQ32Read', 'rnd4kQ32Write'], [L('随机 4K Q1', 'Random 4K Q1'), 'rnd4kQ1Read', 'rnd4kQ1Write']];
const PHASE_TEXT = () => ({ prepare: L('准备测试文件', 'Preparing test file'), seqRead: L('顺序读取', 'Sequential read'), seqWrite: L('顺序写入', 'Sequential write'), seqQ1Read: L('顺序读取 (Q1)', 'Sequential read (Q1)'), seqQ1Write: L('顺序写入 (Q1)', 'Sequential write (Q1)'), rnd4kQ32Read: L('4K 随机读取 (Q32)', '4K random read (Q32)'), rnd4kQ32Write: L('4K 随机写入 (Q32)', '4K random write (Q32)'), rnd4kQ1Read: L('4K 随机读取 (Q1)', '4K random read (Q1)'), rnd4kQ1Write: L('4K 随机写入 (Q1)', '4K random write (Q1)') });
const tests = {};   // disk key -> { bench, scan }, mirrors main's results plus live progress
let running = null; // { kind, key }
let monitorState = null;  // baseline per disk from the background monitor

function diskKey(d) { return d.serial || `${d.model}#${d.index}`; }
function isSsd(d) { return d.bus === 'nvme' || d.rpm === 1; }
function dur(sec) {
  if (sec == null || !isFinite(sec)) return '-';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? L(`${h} 小时 ${m} 分`, `${h} h ${m} min`) : m ? L(`${m} 分 ${sec % 60} 秒`, `${m} min ${sec % 60} s`) : L(`${sec} 秒`, `${sec} s`);
}
function cell(res) { return res && res.ok === false ? `<span class="st-bad" title="${esc(res.error || '')}">${L('失败', 'Failed')}</span>` : mbps(res?.mbps); }
function mbps(v) { return v == null ? '-' : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v >= 10 ? 1 : 2); }

function benchCard(d, t) {
  const b = t.bench;
  const busy = running && running.kind === 'bench' && running.key === diskKey(d);
  const letter = d.letters?.[0];
  const rows = BENCH_ROWS().map(([label, r, w]) => `<tr><td>${label}</td><td class="r">${cell(b?.results?.[r])}</td><td class="r">${cell(b?.results?.[w])}</td></tr>`).join('');
  let foot;
  if (busy) foot = `<div class="tool-status"><span class="spin"></span>${esc(PHASE_TEXT()[b?.phase] || L('准备中', 'Starting'))}${b?.runs > 1 && b?.run ? ` ${b.run}/${b.runs}` : ''}…</div><button class="cancel">${L('停止', 'Stop')}</button>`;
  else if (!letter) foot = `<div class="muted small">${L('这块硬盘没有分区（盘符），无法测速。', 'This drive has no partition (drive letter), so it cannot be benchmarked.')}</div>`;
  else foot = `<div class="muted small">${b?.status === 'done' ? L(`${esc(b.letter)} 盘 · ${new Date(b.finishedAt).toLocaleTimeString()} 测完`, `Drive ${esc(b.letter)} · finished ${new Date(b.finishedAt).toLocaleTimeString()}`) : b?.error ? `<span class="st-bad">${L('测速失败：', 'Benchmark failed: ')}${esc(b.error === 'not enough free space' ? L(`${letter} 盘空间不足 1.3 GB`, `${letter} has less than 1.3 GB free`) : b.error)}</span>` : L(`在 ${esc(letter)} 盘写入 1 GB 临时文件，约 4 分钟，测完自动删除。`, `Writes a 1 GB temporary file on ${esc(letter)}, about 4 minutes, deleted afterwards.`)}</div>
      <button class="go" data-kind="bench" ${running ? 'disabled' : ''}>${b?.status === 'done' ? L('重新测速', 'Run again') : L('开始测速', 'Start benchmark')}</button>`;
  return `<div class="tool"><h3>${L('硬盘测速', 'Benchmark')} <small class="muted">MB/s</small></h3>
    <table class="bench"><thead><tr><th></th><th class="r">${L('读取', 'Read')}</th><th class="r">${L('写入', 'Write')}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tool-foot">${foot}</div></div>`;
}

function scanCard(d, t) {
  const sc = t.scan;
  const busy = running && running.kind === 'scan' && running.key === diskKey(d);
  const est = d.sizeBytes / ((isSsd(d) ? (d.bus === 'nvme' ? 1500 : 450) : 150) * 1e6);
  let body = '';
  if (sc && sc.cells) {
    body = `<div class="cells">${sc.cells.map(v => `<i class="c${v}"></i>`).join('')}</div>
      <div class="scan-stats">
        <span>${L('进度', 'Progress')} <b>${(sc.pct || 0).toFixed(1)}%</b></span>
        <span>${L('坏道', 'Bad')} <b class="${sc.bad ? 'st-bad' : ''}">${num(sc.bad || 0)}</b></span>
        <span>${L('慢区', 'Slow')} <b class="${sc.slow || sc.verySlow ? 'st-warn' : ''}">${num((sc.slow || 0) + (sc.verySlow || 0))}</b></span>
        <span>${L('速度', 'Speed')} <b>${mbps(sc.mbps)}</b> MB/s</span>
        ${busy && sc.pct > 0.2 ? `<span>${L('剩余约', 'About')} <b>${dur(sc.elapsed * (100 - sc.pct) / sc.pct)}</b>${L('', ' left')}</span>` : ''}
      </div>`;
  } else {
    body = `<div class="muted small scan-intro">${L('逐个扇区读取整块硬盘，只读不写，不会改动资料。找出读不到的坏道和读取很慢的区域。', 'Reads every sector of the drive. Read-only: nothing is changed. Finds unreadable (bad) sectors and very slow areas.')}</div>`;
  }
  let foot;
  if (busy) foot = `<div class="tool-status"><span class="spin"></span>${L('正在扫描…', 'Scanning…')}</div><button class="cancel">${L('停止', 'Stop')}</button>`;
  else {
    const last = sc?.status === 'done' ? L(`扫描完成，用时 ${dur(sc.seconds)}`, `Finished in ${dur(sc.seconds)}`) : sc?.status === 'canceled' ? L(`已停止（扫描了 ${(sc.pct || 0).toFixed(1)}%）`, `Stopped (${(sc.pct || 0).toFixed(1)}% scanned)`) : sc?.status === 'error' ? `<span class="st-bad">${L('扫描失败：', 'Scan failed: ')}${esc(sc.error || '')}</span>` : L(`预计 ${dur(est)}`, `About ${dur(est)}`);
    foot = `<div class="muted small">${last}</div><button class="go" data-kind="scan" ${running ? 'disabled' : ''}>${sc ? L('重新扫描', 'Scan again') : L('开始扫描', 'Start scan')}</button>`;
  }
  return `<div class="tool"><h3>${L('坏道扫描', 'Surface scan')} <small class="muted">${L('只读', 'read-only')}</small></h3>${body}
    <div class="legend-row small muted"><i class="c0"></i>${L('正常', 'OK')} <i class="c1"></i>${L('慢', 'Slow')} <i class="c2"></i>${L('很慢', 'Very slow')} <i class="c3"></i>${L('坏道', 'Bad')}</div>
    <div class="tool-foot">${foot}</div></div>`;
}

function renderTools() {
  const el = $('#tools');
  if (!el || current < 0) return;
  const d = data.disks[current];
  const t = tests[diskKey(d)] || {};
  el.innerHTML = benchCard(d, t) + scanCard(d, t);
  el.querySelectorAll('button.go').forEach(b => b.onclick = async () => {
    const kind = b.dataset.kind;
    if (kind === 'scan' && !confirmScan(d)) return;
    const key = diskKey(d);
    tests[key] = { ...tests[key], [kind]: { status: 'running', results: {}, pct: 0 } };
    running = { kind, key };
    renderTools();
    const r = await window.smartdisk.startTask(kind, d.index, d.letters?.[0]);
    if (!r.ok) { running = null; tests[key][kind] = { status: 'error', error: r.error }; renderTools(); }
  });
  el.querySelectorAll('button.cancel').forEach(b => b.onclick = () => window.smartdisk.cancelTask());
}

function confirmScan(d) {
  if (isSsd(d)) return true;
  const est = d.sizeBytes / 150e6;
  return est < 3600 || window.confirm(L(`机械硬盘全盘扫描预计要 ${dur(est)}，期间可以随时停止。要开始吗？`, `A full scan of this hard drive takes about ${dur(est)}. You can stop it any time. Start now?`));
}

window.smartdisk.onTask?.((ev) => {
  const t = (tests[ev.key] ||= {});
  const cur = t[ev.kind] ||= { results: {} };
  if (ev.type === 'phase') { cur.phase = ev.name; cur.run = ev.run; cur.runs = ev.runs; }
  if (ev.type === 'result') cur.results = { ...cur.results, [ev.test]: { mbps: ev.mbps, iops: ev.iops, ok: ev.ok !== false, error: ev.error } };
  if (ev.type === 'start' && ev.kind === 'scan') cur.cells = new Array(ev.cells).fill(-1);
  if (ev.type === 'progress' && ev.kind === 'scan') {
    Object.assign(cur, { pct: ev.pct, bad: ev.bad, slow: ev.slow, verySlow: ev.verySlow, mbps: ev.mbps, elapsed: ev.elapsed });
    (ev.cells || []).forEach((v, i) => { cur.cells[ev.from + i] = v; });
  }
  if (ev.type === 'error') cur.error = ev.message;
  if (ev.type === 'end') { t[ev.kind] = { ...ev.result }; running = null; if (ev.kind === 'scan' && ev.result?.bad && current >= 0) return renderDetail(); }
  if (current >= 0 && data.disks[current] && diskKey(data.disks[current]) === ev.key) renderTools();
  else if (ev.type === 'end') renderTools();
});

// ---- rendering ----
function renderList() {
  $('#diskList').innerHTML = data.disks.map((d, i) => {
    const s = d.summary;
    return `<button class="disk ${i === current ? 'active' : ''}" data-i="${i}">
      <span class="bar" style="background:${color(s.status)}"></span>
      <span><div class="m">${esc(d.model) || L('未知型号', 'Unknown model')}</div><div class="s">${letters(d) ? esc(letters(d)) + ' · ' : ''}${esc(busText(d.bus))} · ${size(d.sizeBytes)}${s.temperatureC != null ? ' · ' + s.temperatureC + '°C' : ''}</div></span>
      <span class="pct" style="color:${color(s.status)}">${s.health != null ? s.health + '%' : '--'}</span>
    </button>`;
  }).join('');
  const sys = data.system;
  const sysBtn = sys && !sys.error ? `<button class="disk sys ${current === -1 ? 'active' : ''}" data-i="-1">
      <span class="bar" style="background:var(--accent)"></span>
      <span><div class="m">${L('本机信息', 'This PC')}</div><div class="s">${esc(sys.cpu?.[0]?.name?.replace(/\(R\)|\(TM\)|CPU|\s+@.*$/g, '').replace(/\s+/g, ' ') || '')}</div></span>
      <span class="pct" style="color:${sys.activated === false ? 'var(--warn)' : 'var(--muted)'}">${sys.memTotalGB ? sys.memTotalGB + 'G' : ''}</span>
    </button>` : '';
  $('#diskList').insertAdjacentHTML('afterbegin', sysBtn);
  document.querySelectorAll('.disk').forEach(b => b.onclick = () => { current = +b.dataset.i; render(); });
}

function renderSystem() {
  const s = data.system;
  const row = (k, v, cls = '') => `<div class="attr nv"><span class="n">${k}</span><span class="r ${cls}">${v}</span></div>`;
  const rows = [
    row(L('电脑', 'Computer'), esc([s.computer?.manufacturer, s.computer?.model].filter(Boolean).join(' ')) + (s.computer?.name ? ` · ${esc(s.computer.name)}` : '')),
    row(L('系统', 'Windows'), esc(`${s.os?.caption || ''} ${s.os?.arch || ''} (${s.os?.build || ''})`)),
    row(L('Windows 激活', 'Activation'), esc(s.activationText) + (s.activation?.channel ? ` · ${esc(s.activation.channel)}` : ''), s.activated ? 'st-ok' : 'st-warn'),
    ...(s.cpu || []).map(c => row('CPU', esc(L(`${c.name} · ${c.cores} 核 ${c.threads} 线程`, `${c.name} · ${c.cores} cores ${c.threads} threads`)))),
    row(L('内存', 'Memory'), `${s.memTotalGB ?? '-'} GB` + (s.memText?.length ? `<br><small class="muted">${s.memText.map(esc).join('<br>')}</small>` : '')),
    ...(s.gpu || []).map(g => row(L('显卡', 'Graphics'), esc(g.name) + (g.driver ? ` <small class="muted">${L('驱动', 'driver')} ${esc(g.driver)}</small>` : ''))),
    row(L('主板', 'Motherboard'), esc(`${s.board?.manufacturer || ''} ${s.board?.product || ''}`) + (s.board?.bios ? ` <small class="muted">BIOS ${esc(s.board.bios)} ${esc(s.board.biosDate || '')}</small>` : '')),
  ];
  if (s.batteryInfo) {
    const w = s.batteryInfo.wear;
    rows.push(row(L('电池损耗', 'Battery wear'), `${w}% <small class="muted">${L(`（设计 ${num(s.batteryInfo.design)} mWh / 目前满电 ${num(s.batteryInfo.full)} mWh）`, `(design ${num(s.batteryInfo.design)} mWh / full now ${num(s.batteryInfo.full)} mWh)`)}</small>`, w >= 40 ? 'st-bad' : w >= 20 ? 'st-warn' : 'st-ok'));
  }
  const notes = [];
  if (s.activated === false) notes.push(L('Windows 尚未激活，出机前请激活。', 'Windows is not activated. Activate it before delivery.'));
  if (s.batteryInfo && s.batteryInfo.wear >= 40) notes.push(L('电池损耗偏高，建议告知客户或更换电池。', 'Battery wear is high. Tell the customer or replace the battery.'));
  $('#detail').innerHTML = `<div class="head"><h1>${L('本机信息', 'This PC')}</h1><div class="meta">${L('出机检测时一起写进 PDF 报告', 'Included in the PDF inspection report')}</div></div>
    ${notes.map(n => `<div class="banner warn">⚠ ${esc(n)}</div>`).join('')}
    <div class="raw sys-card"><div class="attr-list">${rows.join('')}</div></div>`;
}

function renderDetail() {
  if (current === -1) return renderSystem();
  const d = data.disks[current];
  const s = d.summary;
  const base = monitorState?.disks?.[diskKey(d)]?.baseline;
  const baseText = base && base.health != null ? L(` · 监控基准 ${base.health}%（${String(base.at).slice(0, 10)}）`, ` · Baseline ${base.health}% (${String(base.at).slice(0, 10)})`) : '';
  const head = `<div class="head"><h1>${esc(d.model) || L('未知型号', 'Unknown model')}</h1>
    <div class="meta"><span class="chip" style="color:${color(s.status)}">${statusText(s.status)}</span>
    ${esc(busText(d.bus))} · ${size(d.sizeBytes)} · ${L('序列号', 'S/N')} ${esc(d.serial) || '-'} · ${L('固件', 'FW')} ${esc(d.firmware) || '-'} · ${L('磁盘', 'Disk')} ${d.index}${letters(d) ? ' · ' + L('盘符', 'Drive') + ' ' + esc(letters(d)) : ''}${esc(baseText)}</div></div>`;

  if (!d.smartOk) {
    $('#detail').innerHTML = head + `<div class="hero"><div class="gauge-card">${gauge(null, 'unknown')}<div class="verdict">${statusText("unknown")}</div></div>
      <div class="empty">${d.bus === 'usb' ? L('这块硬盘通过 USB 硬盘盒连接，桥接芯片不支持读取 SMART。请把硬盘直接接到主板 SATA / M.2 接口再检测。', 'This drive is in a USB enclosure whose bridge chip does not pass SMART through. Connect it directly to a SATA / M.2 port to check it.') : esc(s.reasons[0])}</div></div>`;
    return;
  }
  const banners = [];
  const scanBad = tests[diskKey(d)]?.scan?.bad;
  if (scanBad) banners.push(`<div class="banner bad">⚠ ${L(`坏道扫描发现 ${num(scanBad)} 个读不到的扇区。请先备份资料，建议更换这块硬盘。`, `The surface scan found ${num(scanBad)} unreadable sectors. Back up the data first; this drive should be replaced.`)}</div>`);
  if (s.firmwareWarning) banners.push(`<div class="banner bad">⚠ ${esc(s.firmwareWarning.text)}</div>`);
  if (s.link?.note) banners.push(`<div class="banner ${s.link.state === 'warn' ? 'warn' : 'info'}">${s.link.state === 'warn' ? '⚠' : 'ℹ'} ${L('接口：', 'Interface: ')}${esc(s.link.note)}</div>`);
  $('#detail').innerHTML = head + banners.join('') + `
    <section class="hero">
      <div class="gauge-card">${gauge(s.health, s.status)}
        <div class="verdict" style="color:${color(s.status)}">${statusText(s.status)}</div>
        ${s.reasons.length ? `<ul class="reasons">${s.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="metrics">${metricsFor(d, s)}</div>
    </section>
    <section id="tools" class="tools"></section>
    ${rawTable(d, s)}`;
  renderTools();
}

function render() {
  if (!data.disks.length) {
    $('#diskList').innerHTML = '';
    $('#detail').innerHTML = `<div class="empty">${L('未找到硬盘。', 'No drives found. ')}${data.error ? esc(data.error) : L('请确认以管理员身份运行。', 'Make sure smartDisk runs as administrator.')}</div>`;
    return;
  }
  renderList();
  renderDetail();
  $('#scanTime').textContent = L('检测时间 ', 'Checked ') + new Date(data.scannedAt).toLocaleString();
  $('#notice').textContent = data.mock ? L('演示数据（未连接检测程序）', 'Demo data (helper not connected)') : (data.elevated ? '' : L('未取得管理员权限，部分硬盘可能无法读取', 'Not running as administrator; some drives may not be readable'));
}

async function scan() {
  $('#refresh').disabled = true;
  try { data = await window.smartdisk.scan(); try { monitorState = await window.smartdisk.monitorState?.(); } catch {} if (current >= data.disks.length || (current === -1 && !data.system)) current = 0; render(); }
  finally { $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', scan);
$('#updBtn').addEventListener('click', () => window.smartdisk.checkUpdate());

// ---- PDF report ----
$('#reportBtn').addEventListener('click', async () => {
  const f = $('#reportForm');
  try {
    const s = await window.smartdisk.settings();
    f.elements.technician.value = s.technician || '';
  } catch {}
  $('#reportMsg').textContent = '';
  $('#report').showModal();
  f.elements.customer.focus();
});
$('#reportForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  const form = {
    customer: f.elements.customer.value.trim(),
    orderNo: f.elements.orderNo.value.trim(),
    technician: f.elements.technician.value.trim(),
    note: f.elements.note.value.trim(),
  };
  $('#reportGo').disabled = true;
  $('#reportMsg').textContent = L('正在生成…', 'Creating…');
  try {
    const r = await window.smartdisk.makeReport(form);
    if (r.ok) { $('#report').close(); f.elements.customer.value = ''; f.elements.orderNo.value = ''; f.elements.note.value = ''; }
    else $('#reportMsg').textContent = r.canceled ? '' : L('生成失败', 'Failed');
  } catch (err) {
    $('#reportMsg').textContent = L('生成失败：', 'Failed: ') + (err?.message || err);
  } finally { $('#reportGo').disabled = false; }
});

// ---- settings (shop info + WhatsApp button for customer alerts) ----
const SET_FIELDS = ['lang', 'shopName', 'shopAddress', 'shopContact', 'whatsapp'];
function waHint() {
  const f = $('#setForm');
  const on = f.elements.whatsappOn.checked;
  const digits = f.elements.whatsapp.value.replace(/\D/g, '');
  f.elements.whatsapp.disabled = !on;
  $('#waHint').textContent = !on ? L('客户提醒窗口不会显示 WhatsApp 按钮。', 'The customer alert will not show a WhatsApp button.')
    : digits.length >= 8 ? L(`客户按下后会打开 wa.me/${digits}，问题内容会自动填好。`, `The button opens wa.me/${digits} with the problem filled in.`) : L('请填号码，否则不会显示按钮。', 'Enter a number, otherwise the button is hidden.');
}
$('#setBtn').addEventListener('click', async () => {
  const f = $('#setForm');
  try {
    const s = await window.smartdisk.settings();
    for (const k of SET_FIELDS) f.elements[k].value = s[k] || (k === 'lang' ? 'zh' : '');
    f.elements.whatsappOn.checked = s.whatsappOn === '1';
  } catch {}
  $('#setMsg').textContent = '';
  waHint();
  $('#settings').showModal();
});
$('#setForm').addEventListener('input', waHint);
$('#setForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  const v = Object.fromEntries(SET_FIELDS.map(k => [k, f.elements[k].value.trim()]));
  v.whatsappOn = f.elements.whatsappOn.checked ? '1' : '';
  try {
    await window.smartdisk.saveSettings(v);
    $('#settings').close();
    if (v.lang !== window.I18N.getLang()) { window.I18N.setLang(v.lang); applyLang(); scan(); }
  }
  catch (err) { $('#setMsg').textContent = L('保存失败：', 'Save failed: ') + (err?.message || err); }
});

$('#aboutBtn').addEventListener('click', async () => {
  try { $('#ver').textContent = 'v' + (await window.smartdisk.version()); } catch {}
  $('#about').showModal();
});
// Language first, then the first scan (the main process builds health texts in the same language).
(async () => {
  try { window.I18N.setLang((await window.smartdisk.settings()).lang); } catch {}
  applyLang();
  scan();
})();
