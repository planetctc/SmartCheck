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
let historyData = {};     // diskKey -> [{ t, h, c, p, w, e }] from history.json

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
  if (busy) foot = `<div class="tool-status"><span class="spin"></span>${esc(PHASE_TEXT()[b?.phase] || L('准备中', 'Starting'))}${b?.runs > 1 && b?.phase !== 'prepare' ? (b.run ? ` ${b.run}/${b.runs}` : L('（预热）', ' (warm-up)')) : ''}…</div><button class="cancel">${L('停止', 'Stop')}</button>`;
  else if (!letter) foot = `<div class="muted small">${L('这块硬盘没有分区（盘符），无法测速。', 'This drive has no partition (drive letter), so it cannot be benchmarked.')}</div>`;
  else foot = `<div class="muted small">${b?.status === 'done' ? L(`${esc(b.letter)} 盘 · ${new Date(b.finishedAt).toLocaleTimeString()} 测完`, `Drive ${esc(b.letter)} · finished ${new Date(b.finishedAt).toLocaleTimeString()}`) : b?.error ? `<span class="st-bad">${L('测速失败：', 'Benchmark failed: ')}${esc(b.error === 'not enough free space' ? L(`${letter} 盘空间不足 1.3 GB`, `${letter} has less than 1.3 GB free`) : b.error)}</span>` : L(`在 ${esc(letter)} 盘写入 1 GB 临时文件，约 3 分半钟，测完自动删除。`, `Writes a 1 GB temporary file on ${esc(letter)}, about 3.5 minutes, deleted afterwards.`)}</div>
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

function gb(b) { return b == null ? '-' : b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : (b / 1e9).toFixed(1) + ' GB'; }

// ---- fake-capacity check ----
function capacityCard(d, t) {
  const c = t.capacity;
  const busy = running && running.kind === 'capacity' && running.key === diskKey(d);
  const letter = d.letters?.[0];
  let body;
  if (busy && c) body = `<div class="progress"><i style="width:${c.pct || 0}%"></i></div><div class="small">${c.phase === 'verify' ? L('第 2 步：读回检查', 'Step 2: reading back') : L('第 1 步：写满剩余空间', 'Step 1: filling free space')} ${(c.pct || 0).toFixed(0)}% · ${mbps(c.mbps)} MB/s${c.bad ? ` · <b class="st-bad">${L('发现错误', 'errors found')}</b>` : ''}</div>`;
  else if (c?.status === 'done') {
    const used = (c.total || 0) - (c.free || 0);
    if (c.badBytes > 0 || c.writeFailed) {
      const real = used + (c.firstBad >= 0 ? c.firstBad : c.okBytes || 0);
      body = `<div class="cap-res bad">✖ ${L('假容量 / 有问题', 'Fake capacity / faulty')}</div><div class="small">${L(`标示 ${gb(c.total)}，实际只有约 <b>${gb(real)}</b> 能正确存资料。超过的部分写进去会读不回来，不要拿来存东西。`, `Labelled ${gb(c.total)}, but only about <b>${gb(real)}</b> stores data correctly. Anything beyond that is lost. Do not use it for data.`)}</div>`;
    } else body = `<div class="cap-res ok">✔ ${L('容量是真的', 'Capacity is genuine')}</div><div class="small">${L(`测了 ${gb(c.tested)} 剩余空间，全部读回正确。写入 ${mbps(c.writeMbps)} MB/s，读取 ${mbps(c.readMbps)} MB/s。`, `Tested ${gb(c.tested)} of free space; everything read back correctly. Write ${mbps(c.writeMbps)} MB/s, read ${mbps(c.readMbps)} MB/s.`)}</div>`;
  } else if (c?.status === 'error' || c?.error) body = `<div class="small st-bad">${L('检测失败：', 'Check failed: ')}${esc(c.code === 'nospace' ? L('没有剩余空间', 'no free space') : c.error || '')}</div>`;
  else body = `<div class="muted small">${L('把剩余空间写满测试资料再读回来检查，找出「假容量」的 U 盘和便宜 SSD。原有文件不会动到，测完自动删除。', 'Fills the free space with test data and reads it back, to catch fake-capacity USB sticks and cheap SSDs. Existing files are not touched; test files are deleted afterwards.')}</div>`;
  const foot = busy ? `<div class="tool-status"><span class="spin"></span>${L('检测中…', 'Checking…')}</div><button class="cancel">${L('停止', 'Stop')}</button>`
    : !letter ? `<div class="muted small">${L('没有盘符，无法检测。', 'No drive letter; cannot check.')}</div>`
    : `<div class="muted small">${L(`${esc(letter)} 盘，时间看剩余空间大小`, `Drive ${esc(letter)}; time depends on free space`)}</div><button class="go" data-kind="capacity" ${running ? 'disabled' : ''}>${c ? L('重新检测', 'Check again') : L('开始检测', 'Start')}</button>`;
  return `<div class="tool"><h3>${L('容量真假检测', 'Fake-capacity check')}</h3>${body}<div class="tool-foot">${foot}</div></div>`;
}

// ---- secure erase ----
function eraseCard(d, t) {
  const e = t.erase;
  const busy = running && running.kind === 'erase' && running.key === diskKey(d);
  let body;
  if (busy) body = `<div class="progress danger"><i style="width:${e?.phase === 'nvme' ? 50 : e?.pct || 0}%"></i></div><div class="small">${e?.phase === 'nvme' ? L('NVMe 格式化清除中，通常几秒到几分钟…', 'NVMe format in progress, usually seconds to minutes…') : L(`覆盖写零 ${(e?.pct || 0).toFixed(1)}% · ${mbps(e?.mbps)} MB/s`, `Overwriting with zeros ${(e?.pct || 0).toFixed(1)}% · ${mbps(e?.mbps)} MB/s`)}</div>`;
  else if (e?.status === 'done') body = `<div class="cap-res ok">✔ ${L('擦除完成', 'Erase finished')}</div><div class="small">${e.method === 'nvme' ? L('用 NVMe 格式化清除。', 'Cleared with NVMe format.') : L(`整块硬盘已覆盖写零${e.errors ? `，有 ${e.errors} 处写入失败` : ''}。`, `Whole drive overwritten with zeros${e.errors ? `, ${e.errors} write errors` : ''}.`)}${L('硬盘现在是空的，需要重新分区才能用。', ' The drive is now blank and needs new partitions.')}</div>`;
  else if (e?.status === 'error' || e?.error) body = `<div class="small st-bad">${L('擦除失败：', 'Erase failed: ')}${esc(e.code === 'inuse' ? L('硬盘上的文件正在使用，请关闭相关窗口和程序再试。', 'files on the drive are in use; close them and try again.') : e.code === 'system' || e.error === 'system' ? L('这是 Windows 系统盘，不能擦除。', 'this is the Windows disk; it cannot be erased.') : e.error || '')}</div>`;
  else body = `<div class="muted small">${L('卖出或送出旧硬盘前，彻底清除全部资料。NVMe 用硬盘自带的格式化清除，其他硬盘整块覆盖写零。', 'Wipes all data before selling or giving away a drive. NVMe uses the drive\'s own format; other drives are overwritten with zeros.')}</div>`;
  const foot = busy ? `<div class="tool-status danger-txt"><span class="spin"></span>${L('擦除中，请勿拔出硬盘…', 'Erasing, do not unplug…')}</div>`
    : d.isSystem ? `<div class="muted small">${L('Windows 系统盘不能擦除。', 'The Windows disk cannot be erased.')}</div>`
    : `<div class="muted small">${L('会要求输入序列号确认', 'Asks for the serial number to confirm')}</div><button class="erase-go danger" ${running ? 'disabled' : ''}>${L('安全擦除…', 'Secure erase…')}</button>`;
  return `<div class="tool danger-tool"><h3>${L('安全擦除', 'Secure erase')}</h3>${body}<div class="tool-foot">${foot}</div></div>`;
}

function openErase(d) {
  const f = $('#eraseForm');
  const code = d.serial || `DISK${d.index}`;
  $('#eraseWhat').innerHTML = `<b>${esc(d.model)}</b><br>${esc(busText(d.bus))} · ${size(d.sizeBytes)} · ${L('序列号', 'S/N')} ${esc(d.serial || '-')}${letters(d) ? ` · ${L('盘符', 'Drive')} ${esc(letters(d))}` : ''}`;
  $('#eraseTypeLbl').textContent = L(`请输入序列号确认：${code}`, `Type the serial number to confirm: ${code}`);
  f.reset();
  let wait = 5;
  const check = () => {
    const ok = f.elements.backed.checked && f.elements.serial.value.trim().toUpperCase() === code.toUpperCase();
    $('#eraseGo').disabled = !ok || wait > 0;
    $('#eraseGo').textContent = wait > 0 ? L(`擦除（${wait}）`, `Erase (${wait})`) : L('擦除', 'Erase');
  };
  const timer = setInterval(() => { wait--; check(); if (wait <= 0) clearInterval(timer); }, 1000);
  f.oninput = check; check();
  f.onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') { clearInterval(timer); return; }
    ev.preventDefault();
    if (!window.confirm(L(`最后确认：清除 ${d.model}（${size(d.sizeBytes)}）上的全部资料？`, `Last check: destroy all data on ${d.model} (${size(d.sizeBytes)})?`))) return;
    clearInterval(timer);
    $('#eraseDlg').close();
    startTool(d, 'erase');
  };
  $('#eraseDlg').showModal();
}

async function startTool(d, kind) {
  const key = diskKey(d);
  tests[key] = { ...tests[key], [kind]: { status: 'running', results: {}, pct: 0 } };
  running = { kind, key };
  renderTools();
  const r = await window.smartdisk.startTask(kind, d.index, d.letters?.[0]);
  if (!r.ok) { running = null; tests[key][kind] = { status: 'error', error: r.error, code: r.error }; renderTools(); }
}

function renderTools() {
  const el = $('#tools');
  if (!el || current < 0) return;
  const d = data.disks[current];
  const t = tests[diskKey(d)] || {};
  el.innerHTML = benchCard(d, t) + scanCard(d, t);
  const el4 = $('#tools4');
  if (el4) {
    el4.innerHTML = capacityCard(d, t) + eraseCard(d, t);
    el4.querySelectorAll('button.go').forEach(b => b.onclick = () => startTool(d, b.dataset.kind));
    el4.querySelectorAll('button.cancel').forEach(b => b.onclick = () => window.smartdisk.cancelTask());
    el4.querySelectorAll('button.erase-go').forEach(b => b.onclick = () => openErase(d));
  }
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
  if (ev.type === 'end') { t[ev.kind] = { ...ev.result }; running = null; if (ev.kind === 'erase' && ev.status === 'done') setTimeout(scan, 1500); if (ev.kind === 'scan' && ev.result?.bad && current >= 0) return renderDetail(); }
  if (current >= 0 && data.disks[current] && diskKey(data.disks[current]) === ev.key) renderTools();
  else if (ev.type === 'end') renderTools();
});

// ---- SMART self-test ----
const selfTests = {};   // disk key -> last status from the helper
let selfTestTimer = null;
const ST_RESULT = () => ({ passed: [L('通过', 'Passed'), 'good'], aborted: [L('被中断', 'Aborted'), 'unknown'], interrupted: [L('被中断', 'Interrupted'), 'unknown'],
  fatal: [L('失败（严重错误）', 'Failed (fatal error)'), 'bad'], failed: [L('失败', 'Failed'), 'bad'], failed_electrical: [L('失败（电路）', 'Failed (electrical)'), 'bad'],
  failed_servo: [L('失败（伺服/寻道）', 'Failed (servo/seek)'), 'bad'], failed_read: [L('失败（读取）', 'Failed (read)'), 'bad'], failed_handling: [L('失败（可能摔过）', 'Failed (handling damage)'), 'bad'], unknown: [L('未知', 'Unknown'), 'unknown'] });

function selfTestCard(d) {
  const st = selfTests[diskKey(d)];
  let body;
  if (!st) body = `<div class="muted small">${L('读取中…', 'Reading…')}</div>`;
  else if (!st.ok) body = `<div class="muted small">${L('这块硬盘或 Windows 不支持从这里启动自检。', 'This drive (or Windows) does not let smartDisk start a self-test.')}</div>`;
  else if (st.running) body = `<div class="progress"><i style="width:${st.progress || 0}%"></i></div><div class="small">${L(`自检进行中 ${st.progress || 0}%，可以继续用电脑。`, `Self-test running ${st.progress || 0}%. You can keep using the PC.`)}</div>`;
  else if (st.last) {
    const [t, c] = ST_RESULT()[st.last.result] || ST_RESULT().unknown;
    body = `<div class="st-last"><b style="color:${color(c)}">${t}</b> <span class="muted small">${st.last.type === 'long' ? L('长测', 'Long test') : st.last.type === 'short' ? L('短测', 'Short test') : ''}${st.last.hours != null ? L(` · 通电第 ${num(st.last.hours)} 小时做的`, ` · at ${num(st.last.hours)} power-on hours`) : ''}${st.last.lba != null ? ` · LBA ${num(st.last.lba)}` : ''}</span></div>`;
  } else body = `<div class="muted small">${L('还没有做过自检。', 'No self-test recorded yet.')}</div>`;
  const mins = (m) => m ? L(`约 ${m >= 120 ? Math.round(m / 60) + ' 小时' : m + ' 分钟'}`, `about ${m >= 120 ? Math.round(m / 60) + ' h' : m + ' min'}`) : '';
  const foot = st?.running
    ? `<div class="tool-status"><span class="spin"></span>${L('自检中…', 'Testing…')}</div><button class="st-go" data-what="abort">${L('停止', 'Stop')}</button>`
    : `<div class="muted small">${L('硬盘自己检查自己，不会改动资料。', 'The drive tests itself; data is not changed.')}</div>
       <span class="btns"><button class="st-go" data-what="short" ${st?.ok === false ? 'disabled' : ''}>${L('短测', 'Short')} <small>${mins(st?.shortMin || 2)}</small></button>
       <button class="st-go" data-what="long" ${st?.ok === false ? 'disabled' : ''}>${L('长测', 'Long')} <small>${mins(st?.longMin)}</small></button></span>`;
  return `<div class="tool" id="selftest"><h3>SMART ${L('自检', 'self-test')}</h3>${body}<div class="tool-foot">${foot}</div></div>`;
}

async function refreshSelfTest(d) {
  const key = diskKey(d);
  try { selfTests[key] = await window.smartdisk.selfTest(d.index, 'status'); } catch (e) { selfTests[key] = { ok: false, error: String(e) }; }
  const cur = data.disks[current];
  if (cur && diskKey(cur) === key) {
    const el = document.getElementById('selftest');
    if (el) { el.outerHTML = selfTestCard(cur); bindSelfTest(cur); }
    const gc = document.querySelector('.grade-card');
    if (gc) gc.outerHTML = gradeCard(cur, cur.summary);
  }
  clearTimeout(selfTestTimer);
  if (selfTests[key]?.running) selfTestTimer = setTimeout(() => refreshSelfTest(d), 5000);
}

function bindSelfTest(d) {
  document.querySelectorAll('#selftest .st-go').forEach(b => b.onclick = async () => {
    const what = b.dataset.what;
    if (what === 'long' && !d.nvme && !window.confirm(L('长测可能要几个小时，期间可以正常用电脑，但不要关机。要开始吗？', 'A long test can take hours. You can use the PC, but do not shut it down. Start now?'))) return;
    b.disabled = true;
    const r = await window.smartdisk.selfTest(d.index, what);
    if (!r.ok) { selfTests[diskKey(d)] = { ok: false, error: r.error }; }
    setTimeout(() => refreshSelfTest(d), 1500);
  });
}

// ---- buyback grade + health history ----
const GRADE_CLS = { A: 'good', B: 'good', C: 'warn', D: 'bad' };
function gradeCard(d, s) {
  let g = s.grade || { grade: null, text: '', reasons: [] };
  const scanBad = tests[diskKey(d)]?.scan?.bad || 0;
  const stl = selfTests[diskKey(d)]?.last;
  if (stl && /^(fatal|failed)/.test(stl.result) && g.grade) g = { grade: 'D', text: L('不建议收购：有坏道或故障迹象。', 'Do not buy: bad sectors or signs of failure.'), reasons: [L('SMART 自检失败', 'SMART self-test failed')] };
  if (scanBad && g.grade) g = { grade: 'D', text: L('不建议收购：有坏道或故障迹象。', 'Do not buy: bad sectors or signs of failure.'), reasons: [L(`坏道扫描发现 ${num(scanBad)} 个坏道`, `${num(scanBad)} bad sectors found by the surface scan`)] };
  return `<div class="tool grade-card"><h3>${L('收购评级', 'Buyback grade')}</h3>
    <div class="grade-row"><div class="grade-letter" style="color:${color(GRADE_CLS[g.grade] || 'unknown')}">${g.grade || '–'}</div>
      <div><div class="grade-text">${esc(g.text)}</div>${g.reasons.length ? `<ul class="reasons small">${g.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div></div>
    <div class="muted small">${L('根据通电时间、写入量、健康度和坏道自动评估，仅供参考。', 'Based on power-on hours, data written, health and bad sectors. For reference only.')}</div></div>`;
}

function historyChart(list) {
  const pts = (list || []).filter(p => p.h != null);
  if (pts.length < 2) return `<div class="muted small hist-empty">${L('每次检测和托盘监控都会记一笔，记录多了就会显示健康度和温度的变化。', 'Every check and the tray monitor add a point; the health and temperature trend appears once there are a few.')}</div>`;
  const W = 600, H = 170, padL = 30, padR = 10, padT = 10, padB = 22;
  const t0 = Date.parse(pts[0].t), t1 = Date.parse(pts[pts.length - 1].t) || t0 + 1;
  const x = t => padL + (W - padL - padR) * ((Date.parse(t) - t0) / Math.max(1, t1 - t0));
  const y = v => padT + (H - padT - padB) * (1 - Math.max(0, Math.min(100, v)) / 100);
  const line = (key) => pts.filter(p => p[key] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const grid = [0, 50, 100].map(v => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${padL - 4}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const day = t => new Date(t).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  const dmg = pts.filter((p, i) => i && p.e > pts[i - 1].e).map(p => `<circle cx="${x(p.t)}" cy="${y(p.h)}" r="4" class="dmg"><title>${L('坏道增加', 'New damage')}: ${p.e}</title></circle>`).join('');
  return `<svg class="hist" viewBox="0 0 ${W} ${H}">${grid}
      <path d="${line('c')}" class="temp"/><path d="${line('h')}" class="health"/>${dmg}
      <text x="${padL}" y="${H - 4}">${day(pts[0].t)}</text><text x="${W - padR}" y="${H - 4}" text-anchor="end">${day(pts[pts.length - 1].t)}</text></svg>
    <div class="legend-row small muted"><i class="lg-h"></i>${L('健康度 %', 'Health %')} <i class="lg-t"></i>${L('温度 °C', 'Temperature °C')} · ${L(`${pts.length} 笔记录`, `${pts.length} points`)}</div>`;
}

function historyCard(d) {
  const list = historyData[diskKey(d)] || [];
  const first = list.find(p => p.h != null), last = list[list.length - 1];
  const delta = first && last && first !== last ? L(`从 ${first.h}% 到 ${last.h}%（${String(first.t).slice(0, 10)} 起）`, `${first.h}% → ${last.h}% since ${String(first.t).slice(0, 10)}`) : '';
  return `<div class="tool"><h3>${L('健康记录', 'Health history')} ${delta ? `<small class="muted">${esc(delta)}</small>` : ''}</h3>${historyChart(list)}</div>`;
}

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
    rows.push(row(L('电池损耗', 'Battery wear'), `${w}% <small class="muted">${L(`（设计 ${num(s.batteryInfo.design)} mWh / 目前满电 ${num(s.batteryInfo.full)} mWh）`, `(design ${num(s.batteryInfo.design)} mWh / full now ${num(s.batteryInfo.full)} mWh)`)}${s.batteryInfo.cycles ? L(` · 充电 ${num(s.batteryInfo.cycles)} 次`, ` · ${num(s.batteryInfo.cycles)} cycles`) : ''}</small>`, w >= 40 ? 'st-bad' : w >= 20 ? 'st-warn' : 'st-ok'));
  }
  const LV = { ok: 'st-ok', warn: 'st-warn', bad: 'st-bad' };
  const sensRows = (s.sensors || []).map(x => row(esc(x.name) + (x.part ? ` <small class="muted">${esc(x.part)}</small>` : ''),
    `${esc(Number(x.value).toLocaleString(undefined, { maximumFractionDigits: 1 }))} ${esc(x.unit)}`, x.kind === 'temp' ? LV[x.level] || '' : ''));
  const notes = [];
  if (s.activated === false) notes.push(L('Windows 尚未激活，出机前请激活。', 'Windows is not activated. Activate it before delivery.'));
  const hot = (s.sensors || []).filter(x => x.level !== 'ok');
  if (hot.length) notes.push(L('温度偏高：', 'Running hot: ') + hot.map(x => `${x.name} ${x.value}${x.unit}`).join(L('、', ', ')) + L('。请检查散热（风扇、散热膏、灰尘）。', '. Check cooling (fans, thermal paste, dust).'));
  if (s.batteryInfo && s.batteryInfo.wear >= 40) notes.push(L('电池损耗偏高，建议告知客户或更换电池。', 'Battery wear is high. Tell the customer or replace the battery.'));
  $('#detail').innerHTML = `<div class="head"><h1>${L('本机信息', 'This PC')}</h1><div class="meta">${L('出机检测时一起写进 PDF 报告', 'Included in the PDF inspection report')}</div></div>
    ${notes.map(n => `<div class="banner warn">⚠ ${esc(n)}</div>`).join('')}
    <div class="raw sys-card"><div class="attr-list">${rows.join('')}</div></div>
    <div class="raw sys-card"><h3 class="sens-h">${L('传感器', 'Sensors')} <small class="muted">${L('读取当下的数值', 'Values at the time of the scan')}</small></h3>
      ${sensRows.length ? `<div class="attr-list">${sensRows.join('')}</div>` : `<p class="muted small">${L('这台电脑没有可以直接读取的传感器。', 'No sensors could be read on this PC.')}</p>`}
      ${s.canInstallPawnio && !s.pawnio ? `<div class="sens-drv"><span class="muted small">${L('CPU 温度、主板风扇和电压要装 PawnIO 驱动（有数字签名，只装一次）。', 'CPU temperatures, board fans and voltages need the PawnIO driver (signed, installed once).')}</span>
        <button id="pawnioBtn">${L('安装传感器驱动', 'Install sensor driver')}</button><span id="pawnioMsg" class="small"></span></div>` : ''}</div>`;
  $('#pawnioBtn')?.addEventListener('click', async () => {
    $('#pawnioBtn').disabled = true; $('#pawnioMsg').textContent = L('正在下载和安装…', 'Downloading and installing…');
    const r = await window.smartdisk.installSensors().catch(e => ({ ok: false, error: e.message }));
    if (r.ok) { $('#pawnioMsg').textContent = r.reboot ? L('装好了，重启电脑后生效。', 'Installed. Restart the PC to use it.') : L('装好了，正在重新检测…', 'Installed. Scanning again…'); if (!r.reboot) scan(); }
    else { $('#pawnioMsg').textContent = r.canceled ? '' : L('安装失败：', 'Install failed: ') + (r.error || ''); $('#pawnioBtn').disabled = false; }
  });
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
      <div class="empty">${d.bus === 'usb' ? L(`这块硬盘通过 USB 硬盘盒连接，桥接芯片${d.usbId ? `（${esc(d.usbId)}）` : ''}不支持读取 SMART。请把硬盘直接接到主板 SATA / M.2 接口再检测。`, `This drive is in a USB enclosure whose bridge chip${d.usbId ? ` (${esc(d.usbId)})` : ''} does not pass SMART through. Connect it directly to a SATA / M.2 port to check it.`) : esc(s.reasons[0])}</div></div>`;
    return;
  }
  const banners = [];
  const scanBad = tests[diskKey(d)]?.scan?.bad;
  if (scanBad) banners.push(`<div class="banner bad">⚠ ${L(`坏道扫描发现 ${num(scanBad)} 个读不到的扇区。请先备份资料，建议更换这块硬盘。`, `The surface scan found ${num(scanBad)} unreadable sectors. Back up the data first; this drive should be replaced.`)}</div>`);
  if (s.firmwareWarning) banners.push(`<div class="banner bad">⚠ ${esc(s.firmwareWarning.text)}</div>`);
  if (s.refurb?.suspect) banners.push(`<div class="banner warn">⚠ ${L('疑似翻新盘（SMART 可能被清零过）：', 'Possibly refurbished (SMART may have been reset): ')}${esc(s.refurb.reasons.join(L('；', '; ')))}</div>`);
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
    <section class="tools tools2">${selfTestCard(d)}${gradeCard(d, s)}</section>
    <section class="tools tools3">${historyCard(d)}</section>
    <section id="tools4" class="tools tools2"></section>
    ${rawTable(d, s)}`;
  renderTools();
  bindSelfTest(d);
  if (!selfTests[diskKey(d)] || !selfTests[diskKey(d)].running) refreshSelfTest(d);
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
  try { data = await window.smartdisk.scan(); try { monitorState = await window.smartdisk.monitorState?.(); } catch {} try { historyData = (await window.smartdisk.history?.()) || {}; } catch {} if (current >= data.disks.length || (current === -1 && !data.system)) current = 0; render(); }
  finally { $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', scan);
$('#updBtn').addEventListener('click', () => window.smartdisk.checkUpdate());

// ---- PDF report ----
function smartaccText(r) {
  if (r.ok) return r.linked.length
    ? L('PDF 已保存，也存进了 smartAcc：', 'PDF saved and filed in smartAcc: ') + r.linked.map(x => `${x.no}${x.client ? ' (' + x.client + ')' : ''}`).join(L('、', ', '))
    : L('PDF 已保存。smartAcc 里没有找到这个序列号的维修单、收购单或发票。', 'PDF saved. smartAcc has no repair, buyback or invoice with this serial number.');
  const E = { offline: L('连不上 smartAcc', 'smartAcc is not reachable'), login: L('smartAcc 用户名或密码不对（在设置里填）', 'smartAcc username or password is wrong (see Settings)'),
    '2fa': L('这个 smartAcc 账号开了两步验证，请在设置里换一个没开两步验证的账号', 'This smartAcc account uses 2-step sign-in; use another account in Settings'),
    old: L('smartAcc 版本太旧，请先更新 smartAcc', 'smartAcc is too old; update it first'), locked: L('另一台电脑上的 smartAcc 需要授权码', 'A smartAcc on another computer needs a licence key') };
  return L('PDF 已保存，但没有存进 smartAcc：', 'PDF saved, but not filed in smartAcc: ') + (E[r.error] || r.msg || r.error || '');
}
$('#reportBtn').addEventListener('click', async () => {
  const f = $('#reportForm');
  try {
    const s = await window.smartdisk.settings();
    f.elements.technician.value = s.technician || '';
  } catch {}
  $('#saChk').hidden = true;
  window.smartdisk.smartaccState?.().then(st => { $('#saChk').hidden = !st?.unlocked; }).catch(() => {});
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
    toSmartAcc: !$('#saChk').hidden && f.elements.toSmartAcc.checked,
  };
  $('#reportGo').disabled = true;
  $('#reportMsg').textContent = L('正在生成…', 'Creating…');
  try {
    const r = await window.smartdisk.makeReport(form);
    if (r.ok) {
      f.elements.customer.value = ''; f.elements.orderNo.value = ''; f.elements.note.value = '';
      if (r.smartacc) $('#reportMsg').textContent = smartaccText(r.smartacc);   // keep the dialog open so the result can be read
      else $('#report').close();
    }
    else $('#reportMsg').textContent = r.canceled ? '' : L('生成失败', 'Failed');
  } catch (err) {
    $('#reportMsg').textContent = L('生成失败：', 'Failed: ') + (err?.message || err);
  } finally { $('#reportGo').disabled = false; }
});

// ---- settings (shop info + WhatsApp button for customer alerts) ----
const SET_FIELDS = ['lang', 'shopName', 'shopAddress', 'shopContact', 'whatsapp', 'remoteCustomer', 'remoteUrl', 'smartaccUrl', 'smartaccUser'];
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
  $('#licMsg').textContent = '';
  f.elements.licKey.value = '';
  f.elements.smartaccPwIn.value = '';
  waHint();
  await showLicense();
  showSmartAcc();
  $('#settings').showModal();
});

// ---- smartAcc link state ----
async function showSmartAcc() {
  const f = $('#setForm');
  try { f.elements.smartaccPwIn.placeholder = (await window.smartdisk.settings()).smartaccPw ? L('已保存（要改才填）', 'Saved (type to change)') : ''; } catch {}
  $('#saState').textContent = L('正在找 smartAcc…', 'Looking for smartAcc…');
  let st = null;
  try { st = await window.smartdisk.smartaccState(); } catch {}
  if (!st) { $('#saState').textContent = ''; return; }
  $('#saState').innerHTML = !st.found ? `<span class="muted">${esc(L('没有找到 smartAcc：', 'smartAcc not found at ') + st.url)}</span>`
    : st.unlocked ? `<span class="ok-txt">✓ ${esc(L('已连上 smartAcc ', 'Connected to smartAcc ') + (st.version || ''))}</span>${st.users ? ' · ' + esc(L('需要填用户名和密码', 'needs a username and password')) : ''}`
    : `<span class="warn-txt">${esc(L('找到 smartAcc，但它在另一台电脑上，需要授权码才能连接。', 'smartAcc found on another computer; this needs a licence key.'))}</span>`;
  if (st.found) $('#saBox').open = true;
}

// ---- licence for the shop's remote service ----
const LIC_WHY = () => ({ format: L('授权码格式不正确', 'That is not a valid licence key'), signature: L('授权码无效', 'That licence key is not genuine'),
  product: L('这是 smartAcc 的授权码，不能用在 smartDisk', 'This is a smartAcc key; it does not work for smartDisk'),
  machine: L('这个授权码是发给另一台电脑的', 'This key was issued for another computer'), expired: L('这个授权码已过期', 'This licence key has expired') });
async function showLicense() {
  let st = null;
  try { st = await window.smartdisk.license(); } catch {}
  if (!st) { $('#licBox').hidden = true; return; }
  $('#licMid').textContent = st.machineId || '';
  $('#licState').innerHTML = st.licensed
    ? `<span class="ok-txt">✓ ${esc(L('已授权', 'Licensed'))}${st.name ? ' · ' + esc(st.name) : ''}${st.expires ? ' · ' + esc(L('到期 ', 'until ')) + esc(st.expires) : ''}</span>`
    : `<span class="muted">${esc(L('未授权：不会上传任何资料，客户只会在自己电脑上看到提醒。', 'Not licensed: nothing is sent; the customer only sees alerts on this PC.'))}</span>`;
  $('#remoteBox').hidden = !st.licensed;
  $('#remoteUrlLbl').hidden = !!st.builtInUrl;
  if (st.licensed) $('#licBox').open = true;
  if (st.last) $('#licMsg').textContent = (st.last.ok ? L('上次上传成功：', 'Last upload OK: ') : L('上次上传失败：', 'Last upload failed: ') + (st.last.error || '') + ' · ') + new Date(st.last.at).toLocaleString();
}
$('#licGo').addEventListener('click', async () => {
  const key = $('#setForm').elements.licKey.value.trim();
  if (!key) return;
  const r = await window.smartdisk.setLicense(key);
  $('#licMsg').textContent = r.ok ? L('授权码已启用。', 'Licence key activated.') : (LIC_WHY()[r.why] || LIC_WHY().format);
  if (r.ok) { $('#setForm').elements.licKey.value = ''; await showLicense(); }
});
$('#remoteTest').addEventListener('click', async () => {
  const f = $('#setForm');
  $('#remoteTest').disabled = true;
  $('#licMsg').textContent = L('正在上传…', 'Sending…');
  try {
    await window.smartdisk.saveSettings(Object.fromEntries(SET_FIELDS.map(k => [k, f.elements[k].value.trim()]).concat([['whatsappOn', f.elements.whatsappOn.checked ? '1' : '']])));
    const r = await window.smartdisk.remoteTest();
    $('#licMsg').textContent = r.ok ? L('上传成功，店家后台已经看得到这台电脑。', 'Sent. The shop can now see this PC.')
      : r.skipped ? L('请先填后台地址。', 'Enter the service address first.') : L('上传失败：', 'Upload failed: ') + (r.error || '');
  } catch (err) { $('#licMsg').textContent = L('上传失败：', 'Upload failed: ') + (err?.message || err); }
  finally { $('#remoteTest').disabled = false; }
});
$('#setForm').addEventListener('input', waHint);
$('#setForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  const v = Object.fromEntries(SET_FIELDS.map(k => [k, f.elements[k].value.trim()]));
  v.whatsappOn = f.elements.whatsappOn.checked ? '1' : '';
  if (f.elements.smartaccPwIn.value) v.smartaccPw = f.elements.smartaccPwIn.value;
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
