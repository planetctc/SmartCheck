// Full laptop battery report from Windows' own "powercfg /batteryreport" (XML), parsed into what a technician
// shows the customer: wear, cycles, capacity history and estimated runtime now vs. when new.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');

const run = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 60000 }, (err) => resolve(!err)));
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1].trim() : ''; };
const num = v => { const n = Number(String(v).replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
// ISO 8601 duration (PT3H12M5S) -> minutes
function minutes(d) {
  const m = String(d || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m || !m[0] || m[0] === 'P' || m[0] === 'PT') return null;
  return Math.round((+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) + (+(m[4] || 0)) / 60);
}
function attrs(s) { const o = {}; for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; }

function parse(xml) {
  const bat = (xml.match(/<Battery>([\s\S]*?)<\/Battery>/) || [])[1] || '';
  if (!bat) return null;
  const design = num(tag(bat, 'DesignCapacity')), full = num(tag(bat, 'FullChargeCapacity'));
  const history = [...xml.matchAll(/<HistoryEntry\s([^>]*?)\/?>/g)].map(m => attrs(m[1])).map(a => ({
    date: (a.LocalEndDate || a.EndDate || a.LocalStartDate || a.StartDate || '').slice(0, 10),
    full: num(a.FullChargeCapacity), design: num(a.DesignCapacity), cycles: num(a.CycleCount),
  })).filter(h => h.date && h.full);
  const est = (xml.match(/<RuntimeEstimates>([\s\S]*?)<\/RuntimeEstimates>/) || [])[1] || '';
  const fullBlock = (est.match(/<FullChargeCapacity>([\s\S]*?)<\/FullChargeCapacity>/) || [])[1] || '';
  const designBlock = (est.match(/<DesignCapacity>([\s\S]*?)<\/DesignCapacity>/) || [])[1] || '';
  return {
    name: tag(bat, 'Id'), maker: tag(bat, 'Manufacturer'), serial: tag(bat, 'SerialNumber'), chemistry: tag(bat, 'Chemistry'),
    design, full, cycles: num(tag(bat, 'CycleCount')),
    wear: design && full ? Math.max(0, Math.round((1 - full / design) * 1000) / 10) : null,
    runtimeNow: minutes(tag(fullBlock, 'ActiveRuntime')), runtimeNew: minutes(tag(designBlock, 'ActiveRuntime')),
    history: history.slice(-60),
  };
}

// { ok, report, htmlFile } ; htmlFile = Windows' own full HTML report, for "open full report".
async function read() {
  if (process.platform !== 'win32') return { ok: false, error: 'windows only' };
  const dir = path.join(os.tmpdir(), 'smartpc-battery'); fs.mkdirSync(dir, { recursive: true });
  const xmlFile = path.join(dir, 'battery.xml'), htmlFile = path.join(dir, 'battery-report.html');
  if (!(await run('powercfg.exe', ['/batteryreport', '/xml', '/output', xmlFile]))) return { ok: false, error: 'powercfg' };
  let report = null;
  try { report = parse(fs.readFileSync(xmlFile, 'utf8').replace(/^﻿/, '')); } catch {}
  await run('powercfg.exe', ['/batteryreport', '/output', htmlFile]);
  return report ? { ok: true, report, htmlFile: fs.existsSync(htmlFile) ? htmlFile : null } : { ok: false, error: 'no battery' };
}

module.exports = { read, parse, minutes };
