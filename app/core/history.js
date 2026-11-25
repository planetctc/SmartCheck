// Health history per disk (健康记录): one point every few hours from normal scans and the tray monitor.
// Stored in %ProgramData%\smartDisk\history.json as { [diskKey]: [{ t, h, c, p, w, e }] }.
//   t = ISO time, h = health %, c = temperature °C, p = power-on hours, w = TB written (NVMe) or null,
//   e = damage count (reallocated + pending + uncorrectable, or NVMe media errors).
const fs = require('fs');
const path = require('path');

const MIN_GAP_MS = 3 * 3600 * 1000;   // at most one point per 3 hours per disk
const MAX_POINTS = 1500;              // about 6 months at 8 points a day

function diskKey(d) { return d.serial || `${d.model}#${d.index}`; }
function rawOf(d, id) { return d.ata?.attributes?.find(a => a.id === id)?.raw ?? 0; }

function point(d, at) {
  const s = d.summary || {};
  return {
    t: at,
    h: s.health ?? null,
    c: s.temperatureC ?? null,
    p: s.powerOnHours ?? null,
    w: d.nvme ? Math.round(d.nvme.dataUnitsWritten * 512000 / 1e10) / 100 : null,
    e: d.nvme ? (d.nvme.mediaErrors || 0) : rawOf(d, 5) + rawOf(d, 197) + rawOf(d, 198),
  };
}

function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }

// Add the scan's readings; returns the updated history. A point is always added when health or damage changed.
function record(file, scan, now = Date.now()) {
  if (!scan || scan.mock || !scan.disks?.length) return load(file);
  const hist = load(file);
  const at = new Date(now).toISOString();
  let changed = false;
  for (const d of scan.disks) {
    if (!d.smartOk || d.summary?.health == null) continue;
    const key = diskKey(d);
    const list = hist[key] || (hist[key] = []);
    const p = point(d, at), last = list[list.length - 1];
    const due = !last || now - Date.parse(last.t) >= MIN_GAP_MS || last.h !== p.h || last.e !== p.e;
    if (!due) continue;
    list.push(p);
    if (list.length > MAX_POINTS) list.splice(0, list.length - MAX_POINTS);
    changed = true;
  }
  if (changed) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(hist)); } catch {}
  }
  return hist;
}

module.exports = { record, load, point };
