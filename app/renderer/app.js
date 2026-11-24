const $ = (s) => document.querySelector(s);
const STATUS_TEXT = { good: '状况良好', warn: '需要注意', bad: '建议更换', unknown: '无法判断' };
const BUS_TEXT = { sata: 'SATA', nvme: 'NVMe', usb: 'USB', other: '其他' };

let data = null;
let current = 0;

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
    );
  } else if (d.ata) {
    const re = rawOf(d, 5) ?? 0, pend = rawOf(d, 197) ?? 0, unc = rawOf(d, 198) ?? 0;
    list.push(
      metric('重映射扇区', num(re), '', re ? 'alert' : ''),
      metric('待映射扇区', num(pend), '', pend ? 'alert' : ''),
      metric('无法修正扇区', num(unc), '', unc ? 'danger' : ''),
    );
  }
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
  document.querySelectorAll('.disk').forEach(b => b.onclick = () => { current = +b.dataset.i; render(); });
}

function renderDetail() {
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
  $('#detail').innerHTML = head + `
    <section class="hero">
      <div class="gauge-card">${gauge(s.health, s.status)}
        <div class="verdict" style="color:${color(s.status)}">${STATUS_TEXT[s.status]}</div>
        ${s.reasons.length ? `<ul class="reasons">${s.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="metrics">${metricsFor(d, s)}</div>
    </section>
    ${rawTable(d, s)}`;
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
  try { data = await window.smartdisk.scan(); if (current >= data.disks.length) current = 0; render(); }
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
