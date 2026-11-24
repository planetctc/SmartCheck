const $ = (s) => document.querySelector(s);
const STATUS_TEXT = { good: '良好', warn: '注意', bad: '危险', unknown: '未知' };
const BUS_TEXT = { sata: 'SATA', nvme: 'NVMe', usb: 'USB', other: '其他' };

let data = null;
let current = 0;

function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function gb(bytes) { return bytes ? (bytes / 1e9).toFixed(1) + ' GB' : '-'; }
function hex(n) { return Number(n).toString(16).toUpperCase().padStart(12, '0'); }
function statusVar(s) { return `var(--${s === 'unknown' ? 'unknown' : s})`; }

// ---- skins ----
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch {}
}
try { const t = localStorage.getItem('theme'); if (t) { $('#theme').value = t; applyTheme(t); } } catch {}
$('#theme').addEventListener('change', e => applyTheme(e.target.value));

// ---- rendering ----
function renderTabs() {
  $('#tabs').innerHTML = data.disks.map((d, i) => {
    const s = d.summary;
    const temp = s.temperatureC != null ? `${s.temperatureC}°C` : '--';
    return `<button class="tab ${i === current ? 'active' : ''}" data-i="${i}">
      <div class="t1"><span class="dot" style="background:${statusVar(s.status)}"></span>${STATUS_TEXT[s.status]} · ${temp}</div>
      <div class="t2">磁盘 ${d.index} · ${esc(BUS_TEXT[d.bus] || d.bus)} · ${gb(d.sizeBytes)}</div>
    </button>`;
  }).join('');
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { current = +b.dataset.i; render(); });
}

function renderDetail() {
  const d = data.disks[current];
  const s = d.summary;
  const tempStatus = s.temperatureC == null ? 'unknown' : s.temperatureC >= 60 ? 'bad' : s.temperatureC >= 50 ? 'warn' : 'good';
  const isNvme = !!d.nvme;

  const rows = isNvme
    ? s.rows.map(r => `<tr><td><span class="state st-${r.state}"></span></td><td>${r.id}</td><td>${esc(r.name)}</td><td class="num">${esc(r.value)}</td></tr>`).join('')
    : s.rows.map(r => `<tr><td><span class="state st-${r.state}"></span></td><td>${r.id.toString(16).toUpperCase().padStart(2, '0')}</td><td>${esc(r.name)}</td>
        <td class="num">${r.current}</td><td class="num">${r.worst}</td><td class="num">${r.threshold}</td><td class="num">${hex(r.raw)}</td></tr>`).join('');
  const head = isNvme
    ? '<tr><th></th><th>ID</th><th>项目</th><th>数值</th></tr>'
    : '<tr><th></th><th>ID</th><th>属性</th><th>当前值</th><th>最差值</th><th>阈值</th><th>原始值</th></tr>';

  $('#detail').innerHTML = `
    <section class="overview">
      <div class="badge s-${s.status}"><div class="label">健康状态</div>
        <div class="value">${s.health != null ? s.health + '%' : '--'}</div><div>${STATUS_TEXT[s.status]}</div></div>
      <div class="badge s-${tempStatus}"><div class="label">温度</div>
        <div class="value">${s.temperatureC != null ? s.temperatureC + '°C' : '--'}</div><div>&nbsp;</div></div>
      <div class="card">
        <dl class="info">
          <dt>型号</dt><dd>${esc(d.model) || '-'}</dd><dt>接口</dt><dd>${esc(BUS_TEXT[d.bus] || d.bus)}</dd>
          <dt>序列号</dt><dd>${esc(d.serial) || '-'}</dd><dt>容量</dt><dd>${gb(d.sizeBytes)}</dd>
          <dt>固件</dt><dd>${esc(d.firmware) || '-'}</dd><dt>通电时间</dt><dd>${s.powerOnHours != null ? s.powerOnHours + ' 小时' : '-'}</dd>
          <dt></dt><dd></dd><dt>通电次数</dt><dd>${s.powerCycles ?? '-'}</dd>
        </dl>
        ${s.reasons?.length ? `<div class="reasons">⚠ ${s.reasons.map(esc).join('；')}</div>` : ''}
      </div>
    </section>
    ${s.rows.length ? `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`
                    : `<div class="card muted">${d.bus === 'usb' ? '该硬盘通过 USB 硬盘盒连接，桥接芯片不支持读取 SMART。请改用 SATA/M.2 直连检测。' : esc(s.reasons[0])}</div>`}
  `;
}

function render() {
  if (!data.disks.length) {
    $('#tabs').innerHTML = '';
    $('#detail').innerHTML = `<div class="card">未找到硬盘。${data.error ? esc(data.error) : '请确认以管理员身份运行。'}</div>`;
    return;
  }
  renderTabs();
  renderDetail();
  $('#scanTime').textContent = '检测时间：' + new Date(data.scannedAt).toLocaleString();
  $('#notice').textContent = data.mock ? '演示数据（未连接检测程序）' : (data.elevated ? '' : '未取得管理员权限，部分硬盘可能无法读取');
}

async function scan() {
  $('#refresh').disabled = true;
  try { data = await window.smartdisk.scan(); if (current >= data.disks.length) current = 0; render(); }
  finally { $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', scan);
scan();
