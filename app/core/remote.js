// PLANET-only remote alerts: a customer PC with a smartDisk licence key sends its drive status to the shop's
// Cloudflare service, which notifies the shop and shows every PC on a password-protected page.
// Without a key nothing is sent; the customer still gets the alert window on their own PC.
// Pure Node (no Electron) so it can be tested; main.js passes in the file paths.
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const HEARTBEAT_MS = 6 * 3600 * 1000;   // send at least every 6 hours so the shop sees the PC is alive
const TIMEOUT_MS = 20000;

function loadDevice(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d.id && d.secret) return d;
  } catch {}
  const d = { id: crypto.randomUUID(), secret: crypto.randomBytes(24).toString('base64url'), lastSent: 0, lastHash: '' };
  saveDevice(file, d);
  return d;
}
function saveDevice(file, d) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 2)); } catch {}
}

function rawOf(d, id) { return d.ata?.attributes?.find(a => a.id === id)?.raw ?? null; }

// Only what the shop needs to see; no file names or personal data.
function diskInfo(d) {
  const s = d.summary || {};
  return {
    model: d.model, serial: d.serial || '', bus: d.bus, sizeBytes: d.sizeBytes || 0, letters: d.letters || [],
    health: s.health ?? null, status: s.status || 'unknown', temp: s.temperatureC ?? null,
    hours: s.powerOnHours ?? null, grade: s.grade?.grade || null, smartOk: !!d.smartOk,
    damage: d.nvme ? { media: d.nvme.mediaErrors || 0, critical: d.nvme.criticalWarning || 0 }
      : { realloc: rawOf(d, 5), pending: rawOf(d, 197), uncorrectable: rawOf(d, 198) },
  };
}

function buildReport({ scan, alerts, device, key, customer, version }) {
  return {
    v: 1, key, device: { id: device.id, secret: device.secret }, customer: String(customer || '').slice(0, 120), version,
    pc: { name: scan.computer?.name || '', os: scan.computer?.os || '' },
    disks: (scan.disks || []).map(diskInfo),
    alerts: (alerts || []).map(a => ({ model: a.model, serial: a.key, letters: a.letters || [], kind: a.kind || '', text: a.text || [] })),
    at: new Date().toISOString(),
  };
}

// What counts as "changed" for sending early: health, status and damage, not temperature.
function stateHash(rep) {
  return crypto.createHash('sha1').update(JSON.stringify(rep.disks.map(d => [d.serial, d.health, d.status, d.damage]))).digest('hex');
}

function due(device, rep, now = Date.now()) {
  return rep.alerts.length > 0 || now - (device.lastSent || 0) >= HEARTBEAT_MS || stateHash(rep) !== device.lastHash;
}

async function post(url, body) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/api/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    let j = null; try { j = await r.json(); } catch {}
    return r.ok && j?.ok ? { ok: true } : { ok: false, error: j?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// opts: { url, key, customer, version, deviceFile, scan, alerts, force }
async function send(opts) {
  if (!opts.url || !opts.key || !opts.scan?.disks?.length) return { ok: false, skipped: true };
  const device = loadDevice(opts.deviceFile);
  const rep = buildReport({ ...opts, device });
  if (!opts.force && !due(device, rep)) return { ok: true, skipped: true };
  const r = await post(opts.url, rep);
  if (r.ok) saveDevice(opts.deviceFile, { ...device, lastSent: Date.now(), lastHash: stateHash(rep) });
  return r;
}

module.exports = { send, buildReport, diskInfo, due, stateHash, loadDevice, HEARTBEAT_MS };
