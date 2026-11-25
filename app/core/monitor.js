// Background health monitor for customer PCs: compares each scan with the baseline recorded the first time a
// disk was seen (normally when the shop installed smartPC) and returns alerts for the customer.
// Pure logic, no Electron: main.js stores the state in %ProgramData%\smartDisk\monitor.json.

const { L } = require('../renderer/i18n');

const HEALTH_DROP = 2;          // default: alert when health falls this many points (e.g. 100 -> 98)
const HOT_REPEAT_MS = 24 * 3600 * 1000;
const RANK = { good: 0, unknown: 0, warn: 1, bad: 2 };

function diskKey(d) { return d.serial || `${d.model}#${d.index}`; }
function rawOf(d, id) { return d.ata?.attributes?.find(a => a.id === id)?.raw ?? 0; }

// Hot limits by drive type.
function hotLimit(d, lim = {}) { return d.bus === 'nvme' ? lim.nvme ?? 80 : d.rpm === 1 ? lim.ssd ?? 70 : lim.hdd ?? 60; }

// Counters that only go up when the drive is physically failing.
function damage(d) {
  if (d.nvme) return { media: d.nvme.mediaErrors || 0, critical: d.nvme.criticalWarning || 0 };
  return { realloc: rawOf(d, 5), pending: rawOf(d, 197), uncorrectable: rawOf(d, 198) };
}

function snapshot(d) {
  const s = d.summary || {};
  return { health: s.health, status: s.status, damage: damage(d), at: new Date().toISOString() };
}

const DAMAGE_TEXT = () => ({
  realloc: L('重映射扇区（坏道已被替换）', 'Reallocated sectors (bad sectors replaced)'),
  pending: L('待映射扇区（读不稳的扇区）', 'Pending sectors (unstable sectors)'),
  uncorrectable: L('无法修正的扇区', 'Uncorrectable sectors'),
  media: L('介质错误', 'Media errors'), critical: L('NVMe 严重警告', 'NVMe critical warning'),
});

// state: { disks: { [key]: { model, baseline, ack, hotCount, lastHotAlert } } }
// Returns { state, alerts: [{ key, model, letters, kind, text }] }.
// lim: { drop, hdd, ssd, nvme } from Settings (limits.js); missing values use the defaults.
function check(state, scan, now = Date.now(), lim = {}) {
  const minDrop = lim.drop ?? HEALTH_DROP;
  state = state && state.disks ? state : { disks: {} };
  const alerts = [];
  for (const d of scan.disks || []) {
    if (!d.smartOk || !d.summary || d.summary.health == null) continue;
    const key = diskKey(d);
    const cur = snapshot(d);
    let e = state.disks[key];
    if (!e) {   // first time this disk is seen: this is its baseline
      state.disks[key] = { model: d.model, baseline: cur, ack: cur, hotCount: 0, lastHotAlert: 0 };
      continue;
    }
    const who = { key, model: d.model, letters: d.letters || [] };
    const ack = e.ack;
    const msgs = [];

    // New bad sectors / media errors.
    const grew = Object.keys(cur.damage).filter(k => (cur.damage[k] || 0) > (ack.damage?.[k] || 0));
    for (const k of grew) msgs.push(`${DAMAGE_TEXT()[k] || k}${L('：', ': ')}${ack.damage?.[k] || 0} → ${cur.damage[k]}`);

    // Health drop.
    const drop = (ack.health ?? cur.health) - cur.health;
    const worse = RANK[cur.status] > RANK[ack.status || 'good'];
    if (drop >= minDrop) {   // every 2 points by default, SSD wear included (nick: 每两趴)
      msgs.unshift(L(`健康度从 ${ack.health}% 降到 ${cur.health}%（安装时 ${e.baseline.health}%）`, `Health dropped from ${ack.health}% to ${cur.health}% (${e.baseline.health}% when installed)`));
    } else if (worse) {
      msgs.unshift(L(`硬盘状态变差：${cur.status === 'bad' ? '危险' : '需要注意'}（健康度 ${cur.health}%）`, `Drive condition got worse: ${cur.status === 'bad' ? 'bad' : 'caution'} (health ${cur.health}%)`));
    }
    if (msgs.length) {
      alerts.push({ ...who, kind: 'health', severity: cur.status === 'bad' || grew.length ? 'bad' : 'warn', text: msgs });
      e.ack = cur;   // next alert only when it gets worse again
    } else if (cur.health > (ack.health ?? 0)) {
      e.ack = { ...ack, health: cur.health };
    }

    // Overheating: two checks in a row over the limit, at most once a day.
    const t = d.summary.temperatureC;
    const hot = hotLimit(d, lim);
    if (t != null && t >= hot) {
      e.hotCount = (e.hotCount || 0) + 1;
      if (e.hotCount >= 2 && now - (e.lastHotAlert || 0) > HOT_REPEAT_MS) {
        e.lastHotAlert = now;
        alerts.push({ ...who, kind: 'hot', severity: 'warn', text: [L(`温度 ${t} °C，超过 ${hot} °C。请检查风扇和通风，避免长时间高温。`, `Temperature ${t} °C, above ${hot} °C. Check the fans and airflow; avoid running this hot for long.`)] });
      }
    } else e.hotCount = 0;
    e.model = d.model;
  }
  return { state, alerts };
}

// Make the current readings the new baseline (tray menu "以目前状态为基准").
function rebase(state, scan) {
  state = { disks: {} };
  for (const d of scan.disks || []) {
    if (!d.smartOk || !d.summary || d.summary.health == null) continue;
    const cur = snapshot(d);
    state.disks[diskKey(d)] = { model: d.model, baseline: cur, ack: cur, hotCount: 0, lastHotAlert: 0 };
  }
  return state;
}

module.exports = { check, rebase, diskKey };
