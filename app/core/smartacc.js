// smartAcc link: after a PDF report is made, send it to smartAcc, which files it under every repair job,
// buyback and invoice with the same disk serial number (smartAcc's POST /api/smartdisk/report).
// Free when smartAcc runs on this same computer; a smartAcc on another computer needs the PLANET licence.
const DEFAULT_URL = 'http://localhost:3000';
const TIMEOUT_MS = 20000;

const isLocal = url => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };

async function call(url, pth, { method = 'GET', body, cookie } = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url.replace(/\/+$/, '') + pth, {
      method, signal: ctl.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch {}
    const sid = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).filter(c => /^(sid|co)=/.test(c)).join('; ');
    return { status: r.status, json: j, sid };
  } finally { clearTimeout(t); }
}

// { ok, version, users } when smartAcc answers at url
async function detect(url = DEFAULT_URL) {
  try {
    const r = await call(url, '/api/health');
    return r.status === 200 && r.json?.ok ? { ok: true, version: r.json.version, users: r.json.users || 0 } : { ok: false };
  } catch { return { ok: false }; }
}

// opts: { url, username, password, pdf (Buffer), name, serials }
async function sendReport(opts) {
  const url = opts.url || DEFAULT_URL;
  const h = await detect(url);
  if (!h.ok) return { ok: false, error: 'offline' };
  let cookie = '';
  if (h.users) {
    if (!opts.username || !opts.password) return { ok: false, error: 'login' };
    const l = await call(url, '/api/login', { method: 'POST', body: { username: opts.username, password: opts.password } });
    if (l.json?.need2fa) return { ok: false, error: '2fa' };
    if (l.status !== 200 || !l.sid) return { ok: false, error: 'login', msg: l.json?.msg };
    cookie = l.sid;
  }
  const r = await call(url, '/api/smartdisk/report', {
    method: 'POST', cookie, body: { name: opts.name, serials: opts.serials, pdf: opts.pdf.toString('base64') },
  });
  if (cookie) call(url, '/api/logout', { method: 'POST', cookie }).catch(() => {});
  if (r.status === 404) return { ok: false, error: 'old' };   // smartAcc too old to have the link
  if (r.status !== 200 || !r.json?.ok) return { ok: false, error: 'server', msg: r.json?.msg };
  return { ok: true, linked: r.json.linked || [] };
}

module.exports = { DEFAULT_URL, isLocal, detect, sendReport };
