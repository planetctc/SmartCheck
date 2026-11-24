const $ = (s) => document.querySelector(s);
const STATUS_TEXT = { good: '状况良好', warn: '需要注意', bad: '建议更换', unknown: '无法判断' };
const BUS_TEXT = { sata: 'SATA', nvme: 'NVMe', usb: 'USB', other: '其他' };

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
    <text class="l" x="95" y="124" text-anchor="middle">健康度</text>
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
    metric('温度', t ?? '--', t == null ? '' : '°C', tCls),
    metric('通电时间', num(s.powerOnHours), '小时'),
    metric('通电次数', num(s.powerCycles), '次'),
  ];
  if (d.nvme) {
    const n = d.nvme;
    list.push(
      metric('寿命已用', n.percentageUsed, '%', n.percentageUsed >= 90 ? 'alert' : ''),
      metric('累计写入', (n.dataUnitsWritten * 512000 / 1e12).toFixed(1), 'TB'),
      metric('介质错误', num(n.mediaErrors), '', n.mediaErrors ? 'alert' : ''),
      metric('可用备用空间', n.availableSpare, '%', n.availableSpare < n.spareThreshold ? 'danger' : ''),
    );
  } else if (d.ata) {
    const re = rawOf(d, 5) ?? 0, pend = rawOf(d, 197) ?? 0, unc = rawOf(d, 198) ?? 0, crc = rawOf(d, 199) ?? 0;
    list.push(
      metric('重映射扇区', num(re), '', re ? 'alert' : ''),
      metric('待映射扇区', num(pend), '', pend ? 'alert' : ''),
      metric('无法修正扇区', num(unc), '', unc ? 'danger' : ''),
      metric('线材 CRC 错误', num(crc), '', crc ? 'alert' : ''),
    );
  }
  const l = s.link;
  list.push(metric('接口速度', l ? l.text : '--', '', (l && l.state === 'warn' ? 'alert ' : '') + 'txt'));
  const [kt, ...kr] = (s.kind || '--').split(' ');
  list.push(metric('类型', kt, kr.join(' '), 'txt'));
  return list.join('');
}

function rawTable(d, s) {
  if (!s.rows.length) return '';
  const STATE = { ok: '正常', warn: '注意', bad: '异常' };
  if (d.nvme) {
    return `<details class="raw"><summary>详细数据（NVMe 健康日志）</summary><div class="attr-list">
      ${s.rows.map(r => `<div class="attr nv"><span class="n">${esc(r.name)}</span><span class="r st-${r.state}">${esc(r.value)}</span></div>`).join('')}
    </div></details>`;
  }
  return `<details class="raw"><summary>详细数据（SMART 属性 ${s.rows.length} 项）</summary><div class="attr-list">
    <div class="attr hdr"><span>属性</span><span class="r">原始值</span><span class="r">当前</span><span class="r">阈值</span><span class="r">状态</span></div>
    ${s.rows.map(r => `<div class="attr"><span class="n">${esc(r.name)}<small>#${r.id}</small></span>
      <span class="r">${esc(r.rawText)}</span><span class="r">${r.current}</span><span class="r">${r.threshold}</span>
      <span class="r st-${r.state}">${STATE[r.state]}</span></div>`).join('')}
  </div></details>`;
}

// ---- benchmark / surface scan ----
const BENCH_ROWS = [['顺序 1M Q8', 'seqRead', 'seqWrite'], ['随机 4K Q32', 'rnd4kQ32Read', 'rnd4kQ32Write'], ['随机 4K Q1', 'rnd4kQ1Read', 'rnd4kQ1Write']];
const PHASE_TEXT = { prepare: '准备测试文件', seqRead: '顺序读取', seqWrite: '顺序写入', rnd4kQ32Read: '4K 随机读取 (Q32)', rnd4kQ32Write: '4K 随机写入 (Q32)', rnd4kQ1Read: '4K 随机读取 (Q1)', rnd4kQ1Write: '4K 随机写入 (Q1)' };
const tests = {};   // disk key -> { bench, scan }, mirrors main's results plus live progress
let running = null; // { kind, key }

function diskKey(d) { return d.serial || `${d.model}#${d.index}`; }
function isSsd(d) { return d.bus === 'nvme' || d.rpm === 1; }
function dur(sec) {
  if (sec == null || !isFinite(sec)) return '-';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${sec % 60} 秒` : `${sec} 秒`;
}
function mbps(v) { return v == null ? '-' : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v >= 10 ? 1 : 2); }

function benchCard(d, t) {
  const b = t.bench;
  const busy = running && running.kind === 'bench' && running.key === diskKey(d);
  const letter = d.letters?.[0];
  const rows = BENCH_ROWS.map(([label, r, w]) => `<tr><td>${label}</td><td class="r">${mbps(b?.results?.[r]?.mbps)}</td><td class="r">${mbps(b?.results?.[w]?.mbps)}</td></tr>`).join('');
  let foot;
  if (busy) foot = `<div class="tool-status"><span class="spin"></span>${esc(PHASE_TEXT[b?.phase] || '准备中')}…</div><button class="cancel">停止</button>`;
  else if (!letter) foot = `<div class="muted small">这块硬盘没有分区（盘符），无法测速。</div>`;
  else foot = `<div class="muted small">${b?.status === 'done' ? `${esc(b.letter)} 盘 · ${new Date(b.finishedAt).toLocaleTimeString()} 测完` : b?.error ? `<span class="st-bad">测速失败：${esc(b.error === 'not enough free space' ? `${letter} 盘空间不足 1.3 GB` : b.error)}</span>` : `在 ${esc(letter)} 盘写入 1 GB 临时文件，约 40 秒，测完自动删除。`}</div>
      <button class="go" data-kind="bench" ${running ? 'disabled' : ''}>${b?.status === 'done' ? '重新测速' : '开始测速'}</button>`;
  return `<div class="tool"><h3>硬盘测速 <small class="muted">MB/s</small></h3>
    <table class="bench"><thead><tr><th></th><th class="r">读取</th><th class="r">写入</th></tr></thead><tbody>${rows}</tbody></table>
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
        <span>进度 <b>${(sc.pct || 0).toFixed(1)}%</b></span>
        <span>坏道 <b class="${sc.bad ? 'st-bad' : ''}">${num(sc.bad || 0)}</b></span>
        <span>慢区 <b class="${sc.slow || sc.verySlow ? 'st-warn' : ''}">${num((sc.slow || 0) + (sc.verySlow || 0))}</b></span>
        <span>速度 <b>${mbps(sc.mbps)}</b> MB/s</span>
        ${busy && sc.pct > 0.2 ? `<span>剩余约 <b>${dur(sc.elapsed * (100 - sc.pct) / sc.pct)}</b></span>` : ''}
      </div>`;
  } else {
    body = `<div class="muted small scan-intro">逐个扇区读取整块硬盘，只读不写，不会改动资料。找出读不到的坏道和读取很慢的区域。</div>`;
  }
  let foot;
  if (busy) foot = `<div class="tool-status"><span class="spin"></span>正在扫描…</div><button class="cancel">停止</button>`;
  else {
    const last = sc?.status === 'done' ? `扫描完成，用时 ${dur(sc.seconds)}` : sc?.status === 'canceled' ? `已停止（扫描了 ${(sc.pct || 0).toFixed(1)}%）` : sc?.status === 'error' ? `<span class="st-bad">扫描失败：${esc(sc.error || '')}</span>` : `预计 ${dur(est)}`;
    foot = `<div class="muted small">${last}</div><button class="go" data-kind="scan" ${running ? 'disabled' : ''}>${sc ? '重新扫描' : '开始扫描'}</button>`;
  }
  return `<div class="tool"><h3>坏道扫描 <small class="muted">只读</small></h3>${body}
    <div class="legend-row small muted"><i class="c0"></i>正常 <i class="c1"></i>慢 <i class="c2"></i>很慢 <i class="c3"></i>坏道</div>
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
  return est < 3600 || window.confirm(`机械硬盘全盘扫描预计要 ${dur(est)}，期间可以随时停止。要开始吗？`);
}

window.smartdisk.onTask?.((ev) => {
  const t = (tests[ev.key] ||= {});
  const cur = t[ev.kind] ||= { results: {} };
  if (ev.type === 'phase') cur.phase = ev.name;
  if (ev.type === 'result') cur.results = { ...cur.results, [ev.test]: { mbps: ev.mbps, iops: ev.iops } };
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
      <span><div class="m">${esc(d.model) || '未知型号'}</div><div class="s">${letters(d) ? esc(letters(d)) + ' · ' : ''}${esc(BUS_TEXT[d.bus] || d.bus)} · ${size(d.sizeBytes)}${s.temperatureC != null ? ' · ' + s.temperatureC + '°C' : ''}</div></span>
      <span class="pct" style="color:${color(s.status)}">${s.health != null ? s.health + '%' : '--'}</span>
    </button>`;
  }).join('');
  const sys = data.system;
  const sysBtn = sys && !sys.error ? `<button class="disk sys ${current === -1 ? 'active' : ''}" data-i="-1">
      <span class="bar" style="background:var(--accent)"></span>
      <span><div class="m">本机信息</div><div class="s">${esc(sys.cpu?.[0]?.name?.replace(/\(R\)|\(TM\)|CPU|\s+@.*$/g, '').replace(/\s+/g, ' ') || '')}</div></span>
      <span class="pct" style="color:${sys.activated === false ? 'var(--warn)' : 'var(--muted)'}">${sys.memTotalGB ? sys.memTotalGB + 'G' : ''}</span>
    </button>` : '';
  $('#diskList').insertAdjacentHTML('afterbegin', sysBtn);
  document.querySelectorAll('.disk').forEach(b => b.onclick = () => { current = +b.dataset.i; render(); });
}

function renderSystem() {
  const s = data.system;
  const row = (k, v, cls = '') => `<div class="attr nv"><span class="n">${k}</span><span class="r ${cls}">${v}</span></div>`;
  const rows = [
    row('电脑', esc([s.computer?.manufacturer, s.computer?.model].filter(Boolean).join(' ')) + (s.computer?.name ? ` · ${esc(s.computer.name)}` : '')),
    row('系统', esc(`${s.os?.caption || ''} ${s.os?.arch || ''} (${s.os?.build || ''})`)),
    row('Windows 激活', esc(s.activationText) + (s.activation?.channel ? ` · ${esc(s.activation.channel)}` : ''), s.activated ? 'st-ok' : 'st-warn'),
    ...(s.cpu || []).map(c => row('CPU', esc(`${c.name} · ${c.cores} 核 ${c.threads} 线程`))),
    row('内存', `${s.memTotalGB ?? '-'} GB` + (s.memText?.length ? `<br><small class="muted">${s.memText.map(esc).join('<br>')}</small>` : '')),
    ...(s.gpu || []).map(g => row('显卡', esc(g.name) + (g.driver ? ` <small class="muted">驱动 ${esc(g.driver)}</small>` : ''))),
    row('主板', esc(`${s.board?.manufacturer || ''} ${s.board?.product || ''}`) + (s.board?.bios ? ` <small class="muted">BIOS ${esc(s.board.bios)} ${esc(s.board.biosDate || '')}</small>` : '')),
  ];
  if (s.batteryInfo) {
    const w = s.batteryInfo.wear;
    rows.push(row('电池损耗', `${w}% <small class="muted">（设计 ${num(s.batteryInfo.design)} mWh / 目前满电 ${num(s.batteryInfo.full)} mWh）</small>`, w >= 40 ? 'st-bad' : w >= 20 ? 'st-warn' : 'st-ok'));
  }
  const notes = [];
  if (s.activated === false) notes.push('Windows 尚未激活，出机前请激活。');
  if (s.batteryInfo && s.batteryInfo.wear >= 40) notes.push('电池损耗偏高，建议告知客户或更换电池。');
  $('#detail').innerHTML = `<div class="head"><h1>本机信息</h1><div class="meta">出机检测时一起写进 PDF 报告</div></div>
    ${notes.map(n => `<div class="banner warn">⚠ ${esc(n)}</div>`).join('')}
    <div class="raw sys-card"><div class="attr-list">${rows.join('')}</div></div>`;
}

function renderDetail() {
  if (current === -1) return renderSystem();
  const d = data.disks[current];
  const s = d.summary;
  const head = `<div class="head"><h1>${esc(d.model) || '未知型号'}</h1>
    <div class="meta"><span class="chip" style="color:${color(s.status)}">${STATUS_TEXT[s.status]}</span>
    ${esc(BUS_TEXT[d.bus] || d.bus)} · ${size(d.sizeBytes)} · 序列号 ${esc(d.serial) || '-'} · 固件 ${esc(d.firmware) || '-'} · 磁盘 ${d.index}${letters(d) ? ' · 盘符 ' + esc(letters(d)) : ''}</div></div>`;

  if (!d.smartOk) {
    $('#detail').innerHTML = head + `<div class="hero"><div class="gauge-card">${gauge(null, 'unknown')}<div class="verdict">${STATUS_TEXT.unknown}</div></div>
      <div class="empty">${d.bus === 'usb' ? '这块硬盘通过 USB 硬盘盒连接，桥接芯片不支持读取 SMART。请把硬盘直接接到主板 SATA / M.2 接口再检测。' : esc(s.reasons[0])}</div></div>`;
    return;
  }
  const banners = [];
  const scanBad = tests[diskKey(d)]?.scan?.bad;
  if (scanBad) banners.push(`<div class="banner bad">⚠ 坏道扫描发现 ${num(scanBad)} 个读不到的扇区。请先备份资料，建议更换这块硬盘。</div>`);
  if (s.firmwareWarning) banners.push(`<div class="banner bad">⚠ ${esc(s.firmwareWarning.text)}</div>`);
  if (s.link?.note) banners.push(`<div class="banner ${s.link.state === 'warn' ? 'warn' : 'info'}">${s.link.state === 'warn' ? '⚠' : 'ℹ'} 接口：${esc(s.link.note)}</div>`);
  $('#detail').innerHTML = head + banners.join('') + `
    <section class="hero">
      <div class="gauge-card">${gauge(s.health, s.status)}
        <div class="verdict" style="color:${color(s.status)}">${STATUS_TEXT[s.status]}</div>
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
    $('#detail').innerHTML = `<div class="empty">未找到硬盘。${data.error ? esc(data.error) : '请确认以管理员身份运行。'}</div>`;
    return;
  }
  renderList();
  renderDetail();
  $('#scanTime').textContent = '检测时间 ' + new Date(data.scannedAt).toLocaleString();
  $('#notice').textContent = data.mock ? '演示数据（未连接检测程序）' : (data.elevated ? '' : '未取得管理员权限，部分硬盘可能无法读取');
}

async function scan() {
  $('#refresh').disabled = true;
  try { data = await window.smartdisk.scan(); if (current >= data.disks.length || (current === -1 && !data.system)) current = 0; render(); }
  finally { $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', scan);
$('#updBtn').addEventListener('click', () => window.smartdisk.checkUpdate());

// ---- PDF report ----
const SHOP_FIELDS = ['shopName', 'shopAddress', 'shopContact'];
$('#reportBtn').addEventListener('click', async () => {
  const f = $('#reportForm');
  try {
    const s = await window.smartdisk.settings();
    for (const k of SHOP_FIELDS) f.elements[k].value = s[k] || '';
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
    shop: Object.fromEntries(SHOP_FIELDS.map(k => [k, f.elements[k].value.trim()])),
  };
  $('#reportGo').disabled = true;
  $('#reportMsg').textContent = '正在生成…';
  try {
    const r = await window.smartdisk.makeReport(form);
    if (r.ok) { $('#report').close(); f.elements.customer.value = ''; f.elements.orderNo.value = ''; f.elements.note.value = ''; }
    else $('#reportMsg').textContent = r.canceled ? '' : '生成失败';
  } catch (err) {
    $('#reportMsg').textContent = '生成失败：' + (err?.message || err);
  } finally { $('#reportGo').disabled = false; }
});

$('#aboutBtn').addEventListener('click', async () => {
  try { $('#ver').textContent = 'v' + (await window.smartdisk.version()); } catch {}
  $('#about').showModal();
});
scan();
