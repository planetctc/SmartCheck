// smartDisk remote service (Cloudflare Worker + D1), for PLANET COMPUTER TECHNOLOGY CENTRE only.
//   POST /api/report   customer PCs with a smartDisk licence key send their drive status here
//   GET  /             password-protected page: every PC, its drives, and open alerts
// Secrets (set by the deploy workflow from GitHub secrets, never in this file):
//   DASH_PASSWORD             password for the page
//   TG_TOKEN, TG_CHAT         optional Telegram bot token and chat id for instant alerts
// The licence public key is the same as smartAcc / smartDisk; only keys with product "smartdisk" are accepted.

const PUB = 'MCowBQYDK2VwAyEAv47aHbwc/+JdfJ3RxL26W0lFlbVQH0odWVzYoe/C7W4=';
const MAX_BODY = 64 * 1024;
const OFFLINE_MS = 3 * 86400e3;
const COOKIE = 'sdr';

const enc = new TextEncoder();
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64u = s => b64(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const str = (v, n) => String(v ?? '').slice(0, n);

let pubKey = null;
async function verifyLicence(key) {
  try {
    const [a, s] = String(key || '').trim().split('.');
    if (!a || !s) return null;
    pubKey = pubKey || await crypto.subtle.importKey('spki', b64(PUB), { name: 'Ed25519' }, false, ['verify']);
    const data = b64u(a);
    if (!await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, b64u(s), data)) return null;
    const p = JSON.parse(new TextDecoder().decode(data));
    if (p.p !== 'smartdisk') return null;
    if (p.e && new Date().toISOString().slice(0, 10) > p.e) return null;
    return p;
  } catch { return null; }
}

// ---- reports from customer PCs ----
async function report(req, env) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: 'too large' }, 413);
  let b;
  try { const t = await req.text(); if (t.length > MAX_BODY) return json({ ok: false, error: 'too large' }, 413); b = JSON.parse(t); }
  catch { return json({ ok: false, error: 'bad json' }, 400); }
  const lic = await verifyLicence(b.key);
  if (!lic) return json({ ok: false, error: 'licence' }, 403);
  const id = str(b.device?.id, 64), secret = str(b.device?.secret, 128);
  if (!/^[0-9a-f-]{36}$/.test(id) || secret.length < 20) return json({ ok: false, error: 'device' }, 400);
  const sh = await sha256(secret);
  const old = await env.DB.prepare('SELECT secret, customer FROM devices WHERE id=?').bind(id).first();
  if (old && old.secret !== sh) return json({ ok: false, error: 'device' }, 403);

  const disks = (Array.isArray(b.disks) ? b.disks : []).slice(0, 24).map(d => ({
    model: str(d.model, 80), serial: str(d.serial, 60), bus: str(d.bus, 12), sizeBytes: Number(d.sizeBytes) || 0,
    letters: (Array.isArray(d.letters) ? d.letters : []).slice(0, 26).map(x => str(x, 4)),
    health: d.health == null ? null : Number(d.health), status: str(d.status, 10), temp: d.temp == null ? null : Number(d.temp),
    hours: d.hours == null ? null : Number(d.hours), grade: str(d.grade, 2), damage: d.damage && typeof d.damage === 'object' ? d.damage : {},
  }));
  const rank = { bad: 3, warn: 2, unknown: 1, good: 0 };
  const worst = disks.reduce((w, d) => (rank[d.status] ?? 1) > (rank[w] ?? 0) ? d.status : w, 'good');
  const now = new Date().toISOString(), customer = str(b.customer, 120);
  await env.DB.prepare(`INSERT INTO devices (id, secret, customer, pc, os, version, first_seen, last_seen, disks, worst, licence)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)
      ON CONFLICT(id) DO UPDATE SET customer=?3, pc=?4, os=?5, version=?6, last_seen=?7, disks=?8, worst=?9, licence=?10, hidden=0`)
    .bind(id, sh, customer, str(b.pc?.name, 80), str(b.pc?.os, 120), str(b.version, 20), now, JSON.stringify(disks), worst, str(lic.n, 80)).run();

  const alerts = (Array.isArray(b.alerts) ? b.alerts : []).slice(0, 10);
  for (const a of alerts) {
    const text = (Array.isArray(a.text) ? a.text : [a.text]).slice(0, 8).map(x => str(x, 300));
    await env.DB.prepare('INSERT INTO events (device_id, at, model, serial, letters, text) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, now, str(a.model, 80), str(a.serial, 60), JSON.stringify((a.letters || []).slice(0, 26)), JSON.stringify(text)).run();
  }
  if (alerts.length) await notify(env, req, { customer: customer || old?.customer, pc: str(b.pc?.name, 80), alerts });
  else if (!old) await notify(env, req, { customer, pc: str(b.pc?.name, 80), alerts: [], first: true });
  return json({ ok: true });
}

async function notify(env, req, { customer, pc, alerts, first }) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  const lines = first
    ? [`🆕 smartDisk: ${customer || '-'} (${pc}) 已连上后台`]
    : [`⚠️ smartDisk 硬盘提醒`, `客户：${customer || '-'}`, `电脑：${pc}`,
      ...alerts.map(a => `• ${a.model}${(a.letters || []).length ? ' (' + a.letters.join(' ') + ')' : ''}: ${(a.text || []).join('；')}`)];
  lines.push(new URL(req.url).origin);
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: lines.join('\n'), disable_web_page_preview: true }),
    });
  } catch {}
}

// ---- password-protected page ----
async function sign(env, exp) { return sha256(`${exp}.${env.DASH_PASSWORD}`); }
async function loggedIn(req, env) {
  if (!env.DASH_PASSWORD) return false;
  const c = (req.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  if (!c) return false;
  const [exp, sig] = c.slice(COOKIE.length + 1).split('.');
  return Number(exp) > Date.now() && sig === await sign(env, exp);
}

const page = (title, body) => new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
:root{--bg:#f3f6fb;--panel:#fff;--text:#14213d;--muted:#6b7487;--border:#dde3ee;--good:#17a368;--warn:#c98a07;--bad:#d63a40;--accent:#0b72c6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1622;--panel:#172131;--text:#e6ecf5;--muted:#93a0b5;--border:#273348;--good:#3ccf8e;--warn:#f2b53c;--bad:#f2555a;--accent:#4ea3ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 14px}h2{font-size:15px;margin:18px 0 8px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;justify-content:space-between}.muted{color:var(--muted)}.small{font-size:12px}
.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.unknown{color:var(--muted)}
table{width:100%;border-collapse:collapse;margin-top:6px}td,th{text-align:left;padding:4px 6px;border-top:1px solid var(--border);font-size:13px}th{color:var(--muted);font-weight:500}
.tbl{overflow-x:auto}button,input{font:inherit}button{border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:8px;padding:4px 10px;cursor:pointer}
input{padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);width:100%}
.ev{border-left:4px solid var(--bad)}.tag{display:inline-block;padding:0 6px;border-radius:6px;border:1px solid currentColor;font-size:12px}
.top{display:flex;justify-content:space-between;align-items:center}form.inline{display:inline}
</style></head><body><main>${body}</main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

const loginPage = msg => page('smartDisk 后台', `<h1>smartDisk 后台</h1><form method="post" action="/login" class="card">
<p class="muted">PLANET COMPUTER TECHNOLOGY CENTRE</p><input type="password" name="pw" placeholder="密码" autofocus required>
<p><button>登录</button> <span class="bad">${esc(msg || '')}</span></p></form>`);

const ago = t => { const m = (Date.now() - Date.parse(t)) / 60000; return m < 60 ? `${Math.max(1, Math.round(m))} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const ST = { good: '良好', warn: '注意', bad: '危险', unknown: '未知' };
const gb = n => n ? (n >= 1e12 ? (n / 1e12).toFixed(2) + ' TB' : Math.round(n / 1e9) + ' GB') : '';
const dmg = d => Object.entries(d.damage || {}).filter(([, v]) => v).map(([k, v]) => ({ realloc: '重映射', pending: '待映射', uncorrectable: '无法修正', media: '介质错误', critical: '严重警告' }[k] || k) + ' ' + v).join('，');

async function dashboard(env) {
  const ev = (await env.DB.prepare(`SELECT e.*, d.customer, d.pc FROM events e LEFT JOIN devices d ON d.id=e.device_id WHERE e.ack=0 ORDER BY e.at DESC LIMIT 100`).all()).results;
  const devs = (await env.DB.prepare('SELECT * FROM devices WHERE hidden=0 ORDER BY last_seen DESC LIMIT 500').all()).results;
  const evHtml = ev.length ? ev.map(e => `<div class="card ev"><div class="row"><b>${esc(e.customer || '-')} · ${esc(e.pc)}</b><span class="muted small">${esc(ago(e.at))}</span></div>
<div>${esc(e.model)} ${esc(JSON.parse(e.letters || '[]').join(' '))}</div><div class="bad">${JSON.parse(e.text || '[]').map(esc).join('<br>')}</div>
<form method="post" action="/ack/${e.id}" class="inline"><button>已处理</button></form></div>`).join('') : '<p class="muted">没有未处理的提醒。</p>';
  const devHtml = devs.map(d => {
    const disks = JSON.parse(d.disks || '[]'), off = Date.now() - Date.parse(d.last_seen) > OFFLINE_MS;
    return `<div class="card"><div class="row"><b>${esc(d.customer || '(未填客户)')} · ${esc(d.pc)}</b>
<span class="small ${off ? 'warn' : 'muted'}">${off ? '离线 · ' : ''}最后上传 ${esc(ago(d.last_seen))} · v${esc(d.version)}</span></div>
<div class="tbl"><table><tr><th>硬盘</th><th>健康</th><th>温度</th><th>通电</th><th>坏道 / 错误</th></tr>${disks.map(x => `<tr>
<td>${esc(x.model)} <span class="muted small">${esc(gb(x.sizeBytes))} ${esc((x.letters || []).join(' '))}</span></td>
<td class="${esc(x.status)}">${x.health == null ? '--' : esc(x.health) + '%'} <span class="tag">${esc(ST[x.status] || x.status)}</span></td>
<td>${x.temp == null ? '' : esc(x.temp) + '°C'}</td><td>${x.hours == null ? '' : esc(x.hours) + ' h'}</td><td class="${dmg(x) ? 'bad' : 'muted'}">${esc(dmg(x) || '0')}</td></tr>`).join('')}</table></div>
<div class="small muted">${esc(d.os)} · 第一次上传 ${esc(String(d.first_seen).slice(0, 10))} <form method="post" action="/hide/${esc(d.id)}" class="inline"><button class="small">从列表移除</button></form></div></div>`;
  }).join('');
  const bad = devs.filter(d => d.worst === 'bad').length, warn = devs.filter(d => d.worst === 'warn').length;
  return page('smartDisk 后台', `<div class="top"><h1>smartDisk 后台</h1><form method="post" action="/logout"><button>退出</button></form></div>
<h2>未处理的提醒（${ev.length}）</h2>${evHtml}
<h2>客户电脑（${devs.length}）<span class="small muted"> · <span class="bad">危险 ${bad}</span> · <span class="warn">注意 ${warn}</span></span></h2>${devHtml || '<p class="muted">还没有电脑上传。</p>'}`);
}

const redirect = (to, cookie) => new Response(null, { status: 303, headers: { Location: to, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (p === '/api/report' && req.method === 'POST') return report(req, env);
    if (p === '/api/health') return json({ ok: true });
    if (p === '/login' && req.method === 'POST') {
      const pw = String((await req.formData()).get('pw') || '');
      if (!env.DASH_PASSWORD) return loginPage('后台还没有设密码（DASH_PASSWORD）');
      if (await sha256(pw) !== await sha256(env.DASH_PASSWORD)) { await new Promise(r => setTimeout(r, 1000)); return loginPage('密码不对'); }
      const exp = Date.now() + 30 * 86400e3;
      return redirect('/', `${COOKIE}=${exp}.${await sign(env, exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}`);
    }
    if (!await loggedIn(req, env)) return p === '/' ? loginPage() : redirect('/');
    if (p === '/logout' && req.method === 'POST') return redirect('/', `${COOKIE}=; Path=/; Max-Age=0; Secure`);
    if (p.startsWith('/ack/') && req.method === 'POST') { await env.DB.prepare('UPDATE events SET ack=1 WHERE id=?').bind(Number(p.slice(5)) || 0).run(); return redirect('/'); }
    if (p.startsWith('/hide/') && req.method === 'POST') { await env.DB.prepare('UPDATE devices SET hidden=1 WHERE id=?').bind(p.slice(6)).run(); return redirect('/'); }
    if (p === '/') return dashboard(env);
    return new Response('Not found', { status: 404 });
  },
};
