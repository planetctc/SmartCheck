// PLANET-only features (remote alerts to the shop, remote view, smartAcc link) need a licence key.
// Keys are made with the same Ed25519 key pair and make-license.js tool as smartAcc, with "--product smartdisk";
// only the public key is here, so nobody else can make keys. A smartAcc key (no product tag) does not unlock smartDisk.
const crypto = require('crypto'), fs = require('fs'), os = require('os');

const PUB = 'MCowBQYDK2VwAyEAv47aHbwc/+JdfJ3RxL26W0lFlbVQH0odWVzYoe/C7W4=';
const PRODUCT = 'smartdisk';

// Same computer ID as smartAcc's license.js, so one ID works for both programs.
function machineId() {
  const c = os.cpus()[0] || {};
  const h = crypto.createHash('sha256').update([os.hostname(), os.platform(), os.arch(), c.model || ''].join('|')).digest('hex').slice(0, 16).toUpperCase();
  return h.match(/.{4}/g).join('-');
}

const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

function verify(key, mid = machineId(), now = today()) {
  try {
    const [a, s] = String(key || '').trim().split('.');
    if (!a || !s) return { ok: false, why: 'format' };
    const pl = Buffer.from(a, 'base64url');
    const pub = crypto.createPublicKey({ key: Buffer.from(PUB, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, pl, pub, Buffer.from(s, 'base64url'))) return { ok: false, why: 'signature' };
    const p = JSON.parse(pl.toString());
    if (p.p !== PRODUCT) return { ok: false, why: 'product', p };
    if (p.m && String(p.m).toUpperCase() !== mid) return { ok: false, why: 'machine', p };
    if (p.e && now > p.e) return { ok: false, why: 'expired', p };
    return { ok: true, p };
  } catch { return { ok: false, why: 'format' }; }
}

function status(file) {
  const out = { machineId: machineId(), licensed: false };
  let key = null;
  try { key = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const v = verify(key);
  if (v.ok) return { ...out, licensed: true, name: v.p.n || '', expires: v.p.e || null };
  return { ...out, problem: v.why };
}

function activate(file, key) {
  const v = verify(key);
  if (!v.ok) return v;
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, String(key).trim());
  return { ok: true, p: v.p };
}

module.exports = { machineId, verify, status, activate, PRODUCT };
