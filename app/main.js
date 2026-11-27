const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { mockTask } = require('./core/mocktask');
const diskspd = require('./core/diskspd');
const { evaluate } = require('./core/health');
const { checkUpdate, checkUpdateSilent } = require('./core/updater');
const monitor = require('./core/monitor');
const history = require('./core/history');
const license = require('./core/license');
const remote = require('./core/remote');
const smartacc = require('./core/smartacc');
const I18N = require('./renderer/i18n');
const { L } = I18N;
// Renamed from smartDisk to smartPC in 0.15.0 and to smartCheck in 0.18.0. Keep the old user-data folder so the single-instance lock,
// the remembered skin and old settings carry over (shared data stays in %ProgramData%\smartDisk).
app.setPath('userData', path.join(app.getPath('appData'), 'smartDisk'));
const { readSystemInfo, mergeSensors, sensorLevel } = require('./core/sysinfo');
const limits = require('./core/limits');
const burnin = require('./core/burnin');
const memtest = require('./core/memtest');
const battery = require('./core/battery');
const sensors = require('./core/sensors');

let win = null;
let lastScan = null;

// Packaged: resources/helper/smartdisk-helper.exe. Dev: ../helper/build/Release/...
function helperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'smartdisk-helper.exe');
  return path.join(__dirname, '..', 'helper', 'build', 'Release', 'smartdisk-helper.exe');
}

function sensorsPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'sensors', 'smartdisk-sensors.exe');
  return path.join(__dirname, '..', 'sensors', 'out', 'smartdisk-sensors.exe');
}

function diskspdPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'diskspd.exe');
  return path.join(__dirname, '..', 'third_party', 'diskspd', 'diskspd_vs', 'x64', 'Release', 'diskspd.exe');
}

// Single data entry point. The PDF report (and a future Tailscale HTTP endpoint) reuse this.
async function scanDisks() {
  const mock = process.env.SMARTDISK_MOCK === '1';
  const st = loadSettings(), sensOn = limits.featureOn(st, 'sensors'), lim = limits.limitsOf(st);
  const [disks, system, lhm, pawnio] = await Promise.all([scanDisksOnly(), readSystemInfo({ mock }),
    mock || !sensOn ? null : sensors.read(sensorsPath()), mock || !sensOn ? false : sensors.pawnioInstalled()]);
  if (system && !system.error) {
    // Sensors turned off in Settings: nothing is read, shown or printed.
    system.sensors = sensOn ? mergeSensors(system.sensors, lhm).map(x => ({ ...x, level: sensorLevel(x, lim) })) : [];
    system.pawnio = pawnio; system.canInstallPawnio = sensOn && process.platform === 'win32' && fs.existsSync(sensorsPath());
  }
  disks.system = system;
  lastScan = disks;
  return disks;
}

function scanDisksOnly() {
  return new Promise((resolve) => {
    const exe = helperPath();
    const useMock = process.env.SMARTDISK_MOCK === '1' || process.platform !== 'win32' || !fs.existsSync(exe);
    const finish = (raw) => {
      const sysL = String(process.env.SystemDrive || 'C:').slice(0, 1).toUpperCase();
      raw.disks = raw.disks.map(d => ({ ...d, isSystem: (d.letters || []).some(x => x.toUpperCase().startsWith(sysL)), summary: evaluate(d) }));
      raw.scannedAt = new Date().toISOString();
      raw.mock = useMock;
      raw.computer = { name: os.hostname(), os: (os.version ? os.version() : os.type()) + ' ' + os.release() };
      resolve(raw);
    };
    if (useMock) {
      return finish(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'helper', 'mock.json'), 'utf8')));
    }
    execFile(exe, [], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      try { finish(JSON.parse(stdout)); }
      catch (e) { resolve({ version: 1, error: String(err || e), disks: [] }); }
    });
  });
}

// ---- benchmark / surface scan ----
// One task at a time. The helper streams JSON lines; each is forwarded to the window as 'task:event'.
// Finished results are kept per disk (by serial) so the PDF report can include them.
let task = null;
const testResults = {};   // serial -> { bench, scan }

function diskKey(d) { return d.serial || `${d.model}#${d.index}`; }

function startTask(kind, diskIndex, letter) {
  if (task) return { ok: false, error: 'busy' };
  if (burn || mem) return { ok: false, error: L('请先等烤机或内存测试完成。', 'Wait for the burn-in or memory test to finish first.') };   // burn-in or memory test running: results would be wrong
  const disk = lastScan?.disks?.find(d => d.index === diskIndex);
  if (!disk) return { ok: false, error: 'nodisk' };
  const key = diskKey(disk);
  const L1 = String(letter || '').slice(0, 1).toUpperCase();
  if (kind === 'erase') {
    const sys = String(process.env.SystemDrive || 'C:').slice(0, 1).toUpperCase();
    if ((disk.letters || []).some(x => x.startsWith(sys))) return { ok: false, error: 'system' };
  }
  const args = kind === 'bench' ? ['bench', L1, '1024'] : kind === 'capacity' ? ['capacity', L1]
    : kind === 'erase' ? ['erase', String(diskIndex), `ERASE-${diskIndex}`, 'auto'] : ['scan', String(diskIndex)];
  const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('task:event', { kind, key, ...ev }); };
  const acc = kind === 'bench' ? { letter, results: {}, startedAt: new Date().toISOString() } : { letter: L1, startedAt: new Date().toISOString() };

  const onEvent = (ev) => {
    if (kind === 'bench') {
      if (ev.type === 'result') acc.results[ev.test] = { mbps: ev.mbps, iops: ev.iops, ok: ev.ok, error: ev.error };
    } else if (kind === 'capacity' || kind === 'erase') {
      if (ev.type === 'start') Object.assign(acc, ev, { type: undefined });
      if (ev.type === 'phase') acc.phase = ev.name;
      if (ev.type === 'progress') Object.assign(acc, { phase: ev.phase || acc.phase, pct: ev.pct, done: ev.done, mbps: ev.mbps, bad: ev.bad, errors: ev.errors });
      if (ev.type === 'done') Object.assign(acc, ev, { type: undefined, pct: 100 });
      if (ev.type === 'error') acc.code = ev.code;
    } else {
      if (ev.type === 'start') { acc.size = ev.size; acc.cells = new Array(ev.cells).fill(-1); }
      if (ev.type === 'progress') {
        Object.assign(acc, { pct: ev.pct, bad: ev.bad, slow: ev.slow, verySlow: ev.verySlow, mbps: ev.mbps, elapsed: ev.elapsed });
        (ev.cells || []).forEach((v, i) => { if (acc.cells) acc.cells[ev.from + i] = v; });
      }
      if (ev.type === 'done') Object.assign(acc, { pct: 100, bad: ev.bad, slow: ev.slow, verySlow: ev.verySlow, seconds: ev.seconds, badLbas: ev.badLbas });
    }
    if (ev.type === 'error') acc.error = ev.message;
    send(ev);
  };

  const finish = (status) => {
    if (!task) return;
    task = null;
    acc.status = status;   // done | canceled | error
    acc.finishedAt = new Date().toISOString();
    // A killed capacity check leaves its test files behind: remove them.
    if (kind === 'capacity' && status !== 'done' && L1) { try { fs.rmSync(`${L1}:\\smartCheck-capacity-test`, { recursive: true, force: true }); } catch {} }
    if (status === 'done' || (kind === 'scan' && acc.pct > 0)) testResults[key] = { ...testResults[key], [kind]: acc };
    send({ type: 'end', status, result: acc });
  };

  const exe = helperPath();
  const useMock = lastScan.mock || !fs.existsSync(exe);
  if (useMock) {
    const stop = mockTask(kind, disk, onEvent, (st) => finish(st));
    task = { cancel: () => { stop(); finish('canceled'); } };
    return { ok: true, key };
  }
  // Benchmark: DiskSpd (same engine as CrystalDiskMark) when it is bundled, else the helper's own benchmark.
  const dspd = diskspdPath();
  if (kind === 'bench' && fs.existsSync(dspd)) {
    const run = diskspd.runBench({ exe: dspd, letter, logFile: path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'bench-log.txt'), onEvent, onEnd: (st) => finish(st) });
    task = { cancel: () => run.cancel() };
    return { ok: true, key };
  }
  const child = spawn(exe, args, { windowsHide: true });
  let buf = '', canceled = false, failed = false;
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const ev = JSON.parse(line); if (ev.type === 'error') failed = true; onEvent(ev); } catch {}
    }
  });
  child.on('close', (code) => finish(canceled ? 'canceled' : failed || code ? 'error' : 'done'));
  child.on('error', (e) => { onEvent({ type: 'error', message: String(e) }); finish('error'); });
  task = { cancel: () => { canceled = true; child.kill(); } };
  return { ok: true, key };
}

// ---- SMART self-test: the drive tests itself, the helper only starts it and reads the status ----
const selfTestStarted = {};   // disk key -> 'short' | 'long' started in this session (for the report)
const mockSelfTest = {};      // demo mode: disk index -> { what, at }

function runHelperJson(args) {
  return new Promise((resolve) => {
    execFile(helperPath(), args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: String(err?.message || 'no output') }); }
    });
  });
}

async function selfTest(diskIndex, what) {
  const disk = lastScan?.disks?.find(d => d.index === diskIndex);
  if (!disk) return { ok: false, error: 'nodisk' };
  const key = diskKey(disk);
  if (lastScan.mock || !fs.existsSync(helperPath())) {
    const now = Date.now(), m = mockSelfTest[diskIndex];
    if (what === 'short' || what === 'long') { mockSelfTest[diskIndex] = { what, at: now }; selfTestStarted[key] = what; return { ok: true, started: what }; }
    if (what === 'abort') { delete mockSelfTest[diskIndex]; return { ok: true, started: 'abort' }; }
    const len = m ? (m.what === 'short' ? 20000 : 60000) : 0, pct = m ? Math.min(100, Math.round((now - m.at) / len * 100)) : 100;
    const st = { ok: true, kind: disk.nvme ? 'nvme' : 'sata', running: !!m && pct < 100, progress: pct, shortMin: 2, longMin: disk.nvme ? 10 : 240,
      last: m && pct >= 100 ? { type: m.what, result: 'passed', code: 0, hours: disk.summary?.powerOnHours } : undefined };
    if (st.last) testResults[key] = { ...testResults[key], selftest: st.last };
    return st;
  }
  const r = await runHelperJson(['selftest', String(diskIndex), what]);
  if (r.ok && r.started && what !== 'abort') selfTestStarted[key] = what;
  if (r.ok && what === 'status' && r.last && !r.running && selfTestStarted[key]) testResults[key] = { ...testResults[key], selftest: r.last };
  return r;
}

// ---- settings: shop info for the report and the customer alert ----
// Stored in %ProgramData%\smartDisk\settings.json so the tray monitor sees them for every Windows user.
// Other shops using smartCheck put their own name and WhatsApp number here (or turn the button off).
const DEFAULT_SETTINGS = {
  shopName: 'PLANET COMPUTER TECHNOLOGY CENTRE',
  shopAddress: 'Batu Gajah, Perak',
  shopContact: 'WhatsApp +60 12-510 5542 · planet@planetctc.com.my',
  technician: '',
  whatsapp: '+60 12-510 5542',
  whatsappOn: '1',
  lang: 'zh',
  remoteCustomer: '',   // PLANET remote alerts: whose PC this is, as shown to the shop
  remoteUrl: '',        // the shop's Cloudflare service; empty = use REMOTE_URL
  smartaccUrl: '',      // smartAcc link; empty = this computer (http://localhost:3000)
  smartaccUser: '',
  smartaccPw: '',       // encrypted with Windows DPAPI (safeStorage), never plain text
  ...limits.defaults(), // f_* feature switches ('1'/'0') and lim_* warning limits, changed in Settings
};
const settingsFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'settings.json');
const oldSettingsFile = () => path.join(app.getPath('userData'), 'settings.json');   // before 0.6.1
const OLD_EMAIL = 'planetctc@gmail.com';
function loadSettings() {
  try {
    let text;
    try { text = fs.readFileSync(settingsFile(), 'utf8'); } catch { text = fs.readFileSync(oldSettingsFile(), 'utf8'); }
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
    // Saved by 0.3.0 with the old shop email: switch to the new one.
    I18N.setLang(s.lang);
    if (s.shopContact.includes(OLD_EMAIL)) s.shopContact = s.shopContact.replace(OLD_EMAIL, 'planet@planetctc.com.my');
    return s;
  } catch { I18N.setLang(DEFAULT_SETTINGS.lang); return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = String(s[k] ?? '').slice(0, k === 'smartaccPw' ? 2000 : 200);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(clean, null, 2));
  I18N.setLang(clean.lang);
  return clean;
}

// ---- smartAcc link: free when smartAcc is on this computer, otherwise PLANET licence only ----
function encryptPw(pw) {
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(pw).toString('base64'); } catch {}
  return '';
}
function decryptPw(v) {
  try { if (String(v).startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch {}
  return '';
}
function smartaccLogin() {
  const st = loadSettings();
  return { url: st.smartaccUrl || smartacc.DEFAULT_URL, username: st.smartaccUser, password: decryptPw(st.smartaccPw) };
}
async function smartaccState() {
  const { url } = smartaccLogin();
  const h = await smartacc.detect(url);
  const licensed = license.status(licenseFile()).licensed;
  return { url, found: h.ok, version: h.version, users: h.users || 0, local: smartacc.isLocal(url), licensed, unlocked: h.ok && (smartacc.isLocal(url) || licensed) };
}

// ---- PDF report ----
async function makeReport(form) {
  const scan = lastScan || await scanDisks();
  const settings = saveSettings({ ...loadSettings(), technician: form.technician });
  const payload = {
    scan, settings, tests: testResults, history: history.load(historyFile()), version: app.getVersion(), lang: settings.lang,
    customer: String(form.customer || '').slice(0, 120),
    orderNo: String(form.orderNo || '').slice(0, 60),
    technician: settings.technician,
    note: String(form.note || '').slice(0, 1000),
    printedAt: new Date().toISOString(),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const safe = (payload.orderNo || stamp).replace(/[\\/:*?"<>|]/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: L('保存检测报告', 'Save inspection report'),
    defaultPath: path.join(app.getPath('documents'), `smartCheck-${L('检测报告', 'Report')}-${safe}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const pdfWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    await pdfWin.loadFile(path.join(__dirname, 'renderer', 'report.html'));
    await pdfWin.webContents.executeJavaScript(`window.renderReport(${JSON.stringify(payload)}); true`);
    const pdf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
    fs.writeFileSync(filePath, pdf);
  } finally {
    pdfWin.destroy();
  }
  shell.openPath(filePath);
  let sa = null;
  if (form.toSmartAcc) {
    const serials = (scan.disks || []).map(d => d.serial).filter(Boolean);
    sa = (await smartaccState()).unlocked
      ? await smartacc.sendReport({ ...smartaccLogin(), pdf: fs.readFileSync(filePath), name: path.basename(filePath), serials }).catch(e => ({ ok: false, error: 'server', msg: e.message }))
      : { ok: false, error: 'locked' };
  }
  return { ok: true, filePath, smartacc: sa };
}

function createWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1040, height: 700, minWidth: 860, minHeight: 580,
    title: 'smartCheck',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
    liveWanted = false; liveStop();
    // Nobody can see or stop them any more: stop the burn-in and the memory test instead of loading the PC unseen.
    if (burn) burnFinish('canceled');
    if (mem) mem.stop();
  });
}

// ---- background monitor (tray) ----
// Started at logon by a scheduled task ("smartDisk Monitor", runs elevated for any user) with --monitor.
// Compares each check with the baseline recorded when the disk was first seen and alerts the customer only.
const MONITOR_TASK = 'smartDisk Monitor';   // internal name kept from before the rename, so existing tasks are reused
const CHECK_EVERY_MS = 15 * 60 * 1000;
const monitorMode = process.argv.includes('--monitor');
let tray = null;
let alertWin = null;
let pendingAlerts = [];

const monitorFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'monitor.json');
const licenseFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'license.key');
const deviceFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'device.json');
const historyFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'history.json');
function loadMonitor() { try { return JSON.parse(fs.readFileSync(monitorFile(), 'utf8')); } catch { return { enabled: true, disks: {} }; } }
function saveMonitor(m) {
  try { fs.mkdirSync(path.dirname(monitorFile()), { recursive: true }); fs.writeFileSync(monitorFile(), JSON.stringify(m, null, 2)); } catch {}
}

// Record a baseline for disks seen for the first time (also from normal scans, so the shop's own check sets it).
function updateMonitor(scan, notify) {
  if (!scan || scan.mock) return;
  history.record(historyFile(), scan);
  const m = loadMonitor();
  const { state, alerts } = monitor.check({ disks: m.disks || {} }, scan, Date.now(), limits.limitsOf(loadSettings()));
  saveMonitor({ ...m, disks: state.disks });
  if (notify && alerts.length) showAlerts(alerts, scan);
  remoteSend(scan, alerts);
}

// ---- PLANET remote alerts (licensed PCs only) ----
const REMOTE_URL = 'https://smartdisk-remote.planetctc.workers.dev';   // the shop's Cloudflare service (deployed 2026-11-26)
const remoteUrl = () => (loadSettings().remoteUrl || REMOTE_URL).trim();
let remoteLast = null;
async function remoteSend(scan, alerts, force) {
  try {
    if (!scan || scan.mock || !license.status(licenseFile()).licensed || !remoteUrl()) return { ok: false, skipped: true };
    let key = ''; try { key = fs.readFileSync(licenseFile(), 'utf8').trim(); } catch {}
    const r = await remote.send({ url: remoteUrl(), key, customer: loadSettings().remoteCustomer, version: app.getVersion(), deviceFile: deviceFile(), scan, alerts, force });
    if (!r.skipped) remoteLast = { ...r, at: new Date().toISOString() };
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
}

function xmlEsc(v) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// The signed-in Windows user. The task runs for this user with highest privileges, so the elevated
// (requireAdministrator) exe starts at logon without a UAC prompt. A "Users" group task cannot elevate.
function taskUser() {
  const u = process.env.USERNAME || os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${u}` : u;
}

// Create or remove the logon task. Only for the installed app on Windows; the app itself runs elevated.
function setMonitorTask(enabled) {
  if (!app.isPackaged || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    if (!enabled) return execFile('schtasks.exe', ['/Delete', '/TN', MONITOR_TASK, '/F'], { windowsHide: true }, () => resolve(true));
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>PLANET COMPUTER TECHNOLOGY CENTRE</Author><Description>smartCheck 硬盘健康监控</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEsc(taskUser())}</UserId><Delay>PT1M</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEsc(taskUser())}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(process.execPath)}</Command><Arguments>--monitor</Arguments></Exec></Actions>
</Task>`;
    const file = path.join(os.tmpdir(), 'smartdisk-monitor-task.xml');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    execFile('schtasks.exe', ['/Create', '/TN', MONITOR_TASK, '/XML', file, '/F'], { windowsHide: true }, (err) => {
      try { fs.unlinkSync(file); } catch {}
      resolve(!err);
    });
  });
}

// Digits for wa.me, or '' when the shop turned the button off or left the number empty.
function whatsappNumber() {
  const st = loadSettings();
  if (st.whatsappOn !== '1') return '';
  const digits = String(st.whatsapp || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : '';
}

function showAlerts(alerts, scan) {
  pendingAlerts = alerts.map(a => ({ ...a, pc: scan.computer?.name || os.hostname() }));
  const first = pendingAlerts[0];
  if (Notification.isSupported()) {
    const n = new Notification({
      title: first.pcHot ? L('smartCheck 电脑温度提醒', 'smartCheck temperature alert') : L('smartCheck 硬盘提醒', 'smartCheck drive alert'),
      body: `${first.model}${first.letters.length ? ' (' + first.letters.join(' ') + ')' : ''}: ${first.text[0]}`,
      icon: path.join(__dirname, 'icon.png'),
    });
    n.on('click', openAlertWindow);
    n.show();
  }
  openAlertWindow();
}

function openAlertWindow() {
  if (!pendingAlerts.length) return;
  if (alertWin && !alertWin.isDestroyed()) { alertWin.webContents.send('alert:data', alertPayload()); alertWin.show(); alertWin.focus(); return; }
  alertWin = new BrowserWindow({
    width: 480, height: 440, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
    title: L('smartCheck 硬盘提醒', 'smartCheck drive alert'), icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  alertWin.loadFile(path.join(__dirname, 'renderer', 'alert.html'));
  alertWin.on('closed', () => { alertWin = null; });
}

function alertPayload() {
  const st = loadSettings();
  return { alerts: pendingAlerts, shopName: st.shopName, shopContact: st.shopContact, whatsapp: !!whatsappNumber(), lang: st.lang };
}

function alertAction(action) {
  if (action === 'whatsapp' && whatsappNumber()) {
    const a = pendingAlerts;
    const shop = loadSettings().shopName || '';
    const what = a.every(x => x.pcHot) ? L('电脑温度过高', 'my PC is overheating') : L('硬盘有问题', 'a problem with my drive');
    const lines = [L(`你好${shop ? ' ' + shop : ''}，smartCheck 提醒我的${what}：`, `Hi${shop ? ' ' + shop : ''}, smartCheck warned me about ${what}:`),
      ...a.map(x => `- ${x.model}${x.letters.length ? ' (' + x.letters.join(' ') + ')' : ''}: ${x.text.join(L('；', '; '))}`),
      `${L('电脑', 'PC')}: ${a[0]?.pc || os.hostname()}`];
    shell.openExternal(`https://wa.me/${whatsappNumber()}?text=${encodeURIComponent(lines.join('\n'))}`);
  } else if (action === 'open') {
    createWindow();
  }
  if (action !== 'whatsapp' && alertWin && !alertWin.isDestroyed()) alertWin.close();
}

async function monitorCheck(manual) {
  if (loadMonitor().enabled === false) return;   // turned off in Settings
  const scan = await scanDisksOnly();
  if (!scan.disks?.length) return;
  history.record(historyFile(), scan);
  const m = loadMonitor();
  const st = loadSettings(), lim = limits.limitsOf(st);
  const { state, alerts } = monitor.check({ disks: m.disks || {} }, scan, Date.now(), lim);
  // CPU / GPU / board temperatures too (the shop sets the limits in Settings → 警告门槛).
  let sensState = m.sensors || {}, sensAlerts = [], sens = [];
  if (limits.featureOn(st, 'sensors') && !burn) {   // not during a burn-in: the test makes the PC hot on purpose
    try { sens = ((await sensors.read(sensorsPath())) || []).map(x => ({ ...x, level: sensorLevel(x, lim) })); } catch {}
    ({ state: sensState, alerts: sensAlerts } = monitor.checkSensors(sensState, sens, Date.now(), lim));
  }
  saveMonitor({ ...m, disks: state.disks, sensors: sensState });
  remoteSend(scan, alerts);
  const all = [...alerts, ...sensAlerts];
  if (all.length) showAlerts(all, scan);
  else if (manual) {
    const temps = ['cpu', 'gpu'].map(g => sens.filter(x => x.group === g && x.kind === 'temp').sort((a, b) => b.value - a.value)[0]).filter(Boolean).map(x => `${x.name}：${x.value} °C`);
    const worst = [...scan.disks.filter(d => d.summary?.health != null).map(d => `${d.model}：${d.summary.health}%`), ...temps].join('\n');
    dialog.showMessageBox({ type: 'info', title: 'smartCheck', message: L('硬盘状况和安装时一样，没有新问题。', 'No new problems since the drives were first checked.'), detail: worst });
  }
  updateTrayTip(scan);
}

function updateTrayTip(scan) {
  if (!tray) return;
  const parts = (scan?.disks || []).filter(d => d.summary?.health != null).map(d => `${(d.letters || []).join(' ') || d.model.slice(0, 16)} ${d.summary.health}%`);
  tray.setToolTip(`${L('smartCheck 硬盘监控', 'smartCheck drive monitor')}\n${parts.join('\n')}`.slice(0, 127));
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: L('打开 smartCheck', 'Open smartCheck'), click: () => createWindow() },
    { label: L('立即检查', 'Check now'), click: () => monitorCheck(true) },
    ...(whatsappNumber() ? [{ label: L('WhatsApp 联系我们', 'Contact us on WhatsApp'), click: () => shell.openExternal(`https://wa.me/${whatsappNumber()}`) }] : []),
    { type: 'separator' },
    { label: L('以目前状态为基准', 'Use current state as baseline'), click: async () => {
      const r = await dialog.showMessageBox({ type: 'question', buttons: [L('确定', 'OK'), L('取消', 'Cancel')], cancelId: 1, title: 'smartCheck',
        message: L('把目前的硬盘状态设为新的基准？', 'Make the current drive state the new baseline?'),
        detail: L('之后只会在比目前更差时才提醒。一般只在换硬盘或维修后使用。', 'Alerts will only come when things get worse than now. Use this after replacing or repairing a drive.') });
      if (r.response !== 0) return;
      const scan = await scanDisksOnly();
      const m = loadMonitor();
      saveMonitor({ ...m, disks: monitor.rebase(null, scan).disks });
    } },
    { label: L('退出监控', 'Quit monitor'), click: async () => {
      const r = await dialog.showMessageBox({ type: 'question', buttons: [L('只是这次', 'Just this time'), L('以后都不要监控', 'Turn monitoring off'), L('取消', 'Cancel')], cancelId: 2, title: 'smartCheck',
        message: L('退出硬盘监控？', 'Quit the drive monitor?'), detail: L('选「只是这次」，下次开机还会自动监控。', 'With "Just this time", monitoring starts again at the next sign-in.') });
      if (r.response === 2) return;
      if (r.response === 1) { saveMonitor({ ...loadMonitor(), enabled: false }); await setMonitorTask(false); }
      app.quit();
    } },
  ]);
  tray.setContextMenu(menu);
}

function startMonitor(fromApp) {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(L('smartCheck 硬盘监控', 'smartCheck drive monitor'));
  refreshTrayMenu();
  tray.on('double-click', () => createWindow());
  tray.on('click', () => createWindow());
  // Closing the main window leaves the monitor running, so say once where it went.
  if (fromApp) {
    try {
      tray.displayBalloon({ iconType: 'info', title: L('smartCheck 硬盘监控', 'smartCheck drive monitor'),
        content: L('smartCheck 会在右下角继续监控硬盘，有问题会提醒。右键图标可以退出。', 'smartCheck keeps watching the drives from here and will warn you of problems. Right-click the icon to quit.') });
    } catch {}
  }
  setTimeout(() => monitorCheck(false), 2 * 60 * 1000);
  setInterval(() => monitorCheck(false), CHECK_EVERY_MS);
  // Installed copies on customer PCs update themselves quietly; the new version installs when Windows restarts.
  // Settings → 自动更新 off: no quiet downloads; the shop can still click 检查更新.
  const autoUpd = () => { if (limits.featureOn(loadSettings(), 'autoupdate')) checkUpdateSilent(); };
  setTimeout(autoUpd, 10 * 60 * 1000);
  setInterval(autoUpd, 24 * 3600 * 1000);
}

ipcMain.handle('disks:scan', async () => { const r = await scanDisks(); updateMonitor(r, false); return r; });
ipcMain.handle('alert:get', () => alertPayload());
ipcMain.handle('monitor:get', () => loadMonitor());
ipcMain.handle('history:get', () => history.load(historyFile()));
ipcMain.handle('license:get', () => ({ ...license.status(licenseFile()), remoteUrl: remoteUrl(), builtInUrl: !!REMOTE_URL, last: remoteLast }));
ipcMain.handle('license:set', (_e, key) => {
  const r = license.activate(licenseFile(), String(key || ''));
  return r.ok ? { ok: true, status: license.status(licenseFile()) } : { ok: false, why: r.why };
});
ipcMain.handle('remote:test', async () => remoteSend(lastScan || await scanDisksOnly(), [], true));
ipcMain.handle('alert:action', (_e, a) => alertAction(String(a)));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('settings:get', () => { const s = loadSettings(); return { ...s, smartaccPw: s.smartaccPw ? '1' : '', monitorOn: loadMonitor().enabled !== false ? '1' : '' }; });
ipcMain.handle('settings:save', (_e, v) => {
  v = { ...(v || {}) };
  // The smartAcc password arrives in plain text only when it was typed; store it encrypted, keep the old one otherwise.
  if ('smartaccPw' in v) v.smartaccPw = v.smartaccPw ? encryptPw(v.smartaccPw) : loadSettings().smartaccPw;
  // Background monitor switch lives in monitor.json (the tray reads it) and the logon task.
  if ('monitorOn' in v) {
    const on = v.monitorOn === '1';
    if (on !== (loadMonitor().enabled !== false)) { saveMonitor({ ...loadMonitor(), enabled: on }); setMonitorTask(on); }
    if (!on && tray) { tray.destroy(); tray = null; }
    delete v.monitorOn;
  }
  const r = saveSettings({ ...loadSettings(), ...v }); refreshTrayMenu(); return { ...r, smartaccPw: r.smartaccPw ? '1' : '' };
});
ipcMain.handle('smartacc:state', () => smartaccState());
ipcMain.handle('sensors:install', async () => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: [L('安装', 'Install'), L('取消', 'Cancel')], cancelId: 1, title: 'smartCheck',
    message: L('安装 PawnIO 传感器驱动？', 'Install the PawnIO sensor driver?'),
    detail: L('读取 CPU 温度、主板风扇和电压需要这个驱动。会从 PawnIO 官方 GitHub 下载有数字签名的安装程序，装好后以后都不用再装。',
      'Reading CPU temperatures, board fans and voltages needs this driver. The signed installer is downloaded from PawnIO\'s official GitHub; it is installed once.') });
  if (r.response !== 0) return { ok: false, canceled: true };
  return sensors.installPawnIO();
});
// ---- live sensors on the hardware page ----
// While the hardware page (or the temperature step) is open, smartdisk-sensors.exe --watch reads every 2 s and the
// values go to the window. During a burn-in the burn-in's own watcher feeds this too, so only one reader runs.
let liveWanted = false, liveProc = null, liveMockT = null;
function liveSend(raw) {
  if (!liveWanted || !win || win.isDestroyed()) return;
  const lim = limits.limitsOf(loadSettings());
  win.webContents.send('sensors:live', sensors.toSensors(raw).map(x => ({ ...x, level: sensorLevel(x, lim) })));
}
function liveStop() {
  clearInterval(liveMockT); liveMockT = null;
  const p = liveProc; liveProc = null;
  if (p) { try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 1500); }
}
function liveStart() {
  if (liveProc || liveMockT || burn || !limits.featureOn(loadSettings(), 'sensors')) return;
  if (process.env.SMARTDISK_MOCK === '1') {   // demo values that move a little
    const j = v => Math.round((v + (Math.random() - 0.5) * v * 0.08) * 10) / 10;
    const tick = () => liveSend([
      { hw: 'Cpu', part: 'Intel Core i5-14400F', type: 'Temperature', name: 'CPU Package', value: j(44) },
      { hw: 'Cpu', part: 'Intel Core i5-14400F', type: 'Power', name: 'CPU Package', value: j(12) },
      { hw: 'Cpu', part: 'Intel Core i5-14400F', type: 'Load', name: 'CPU Total', value: j(6) },
      { hw: 'GpuNvidia', part: 'NVIDIA GeForce RTX 4060', type: 'Temperature', name: 'GPU Core', value: j(38) },
      { hw: 'SuperIO', part: 'Nuvoton NCT6798D', type: 'Fan', name: 'Fan #1', value: Math.round(j(1050)) },
      { hw: 'SuperIO', part: 'Nuvoton NCT6798D', type: 'Temperature', name: 'System', value: j(33) },
    ]);
    tick(); liveMockT = setInterval(tick, 2000);
    return;
  }
  const exe = sensorsPath();
  if (process.platform !== 'win32' || !fs.existsSync(exe)) return;
  try {
    const p = liveProc = spawn(exe, ['--watch', '2000'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.ok) liveSend(j.sensors || []); } catch {}
      }
    });
    p.on('error', () => {});
    p.on('exit', () => { if (liveProc === p) liveProc = null; });
  } catch { liveProc = null; }
}
ipcMain.handle('sensors:live', (_e, on) => { liveWanted = !!on; if (liveWanted) liveStart(); else liveStop(); return true; });
ipcMain.handle('report:make', (_e, form) => makeReport(form || {}));
ipcMain.handle('task:start', (_e, a) => startTask(['bench', 'capacity', 'erase'].includes(a?.kind) ? a.kind : 'scan', Number(a?.disk), a?.letter));
ipcMain.handle('task:cancel', () => { if (task) task.cancel(); return true; });

// ---- burn-in test (烤机) ----
// CPU load in worker threads, GPU load in a WebGL window, sensors every 2 s from smartdisk-sensors.exe --watch.
// Progress is written to %ProgramData%\smartDisk\burnin.json while it runs, so if Windows freezes, restarts or loses
// power the next start finds a "running" test and reports it as interrupted.
const burnFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'burnin.json');
let burn = null;
function burnSave(run) { try { fs.mkdirSync(path.dirname(burnFile()), { recursive: true }); fs.writeFileSync(burnFile(), JSON.stringify(run)); } catch {} }
function burnSend(ev) { if (win && !win.isDestroyed()) win.webContents.send('burn:event', ev); }
function burnPublic(run) { return run && { ...run, samples: burnin.thin(run.samples || []) }; }

// A test that was still "running" when smartCheck last stopped: the PC froze, restarted or lost power.
function burnRecover() {
  try {
    const run = JSON.parse(fs.readFileSync(burnFile(), 'utf8'));
    if (run.status === 'running') {
      run.status = 'interrupted'; run.finishedAt = run.samples?.[run.samples.length - 1]?.t ? new Date(run.samples[run.samples.length - 1].t).toISOString() : run.startedAt;
      run.result = burnin.evaluate(run, limits.limitsOf(loadSettings()));
      burnSave(run);
    }
    if (run.status && run.status !== 'running') testResults.pc = { ...testResults.pc, burn: run };
  } catch {}
}

function burnStart(opts = {}) {
  if (burn) return { ok: false, error: 'busy' };
  if (task) return { ok: false, error: 'task' };
  if (mem) return { ok: false, error: 'mem' };
  const minutes = Math.max(1, Math.min(60, Math.round(Number(opts.minutes) || 10)));
  const run = { status: 'running', startedAt: new Date().toISOString(), minutes, cpu: opts.cpu !== false, gpu: !!opts.gpu, level: opts.level === 'std' ? 'std' : 'high', samples: [], threads: 0 };
  const mock = process.env.SMARTDISK_MOCK === '1';
  const b = burn = { run, latest: {}, hasSensors: false };
  liveStop();   // the burn-in's watcher takes over
  // Sensors.
  const exe = sensorsPath();
  if (!mock && fs.existsSync(exe)) {
    try {
      b.proc = spawn(exe, ['--watch', '2000'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      b.proc.stdout.on('data', d => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          try { const j = JSON.parse(line); if (j.ok) { b.latest = burnin.pick(j.sensors || []); b.hasSensors = true; liveSend(j.sensors || []); } } catch {}
        }
      });
      b.proc.on('error', () => {});
    } catch {}
  }
  // Load.
  // High intensity: the helper's AVX2/FMA load (like Prime95 small FFT). Standard, or no helper: worker threads in Node.
  const helper = helperPath();
  if (run.cpu && run.level === 'high' && !mock && fs.existsSync(helper)) {
    try {
      const p = spawn(helper, ['stress'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      p.stdout.once('data', d => { try { const j = JSON.parse(String(d).split('\n')[0]); run.engine = j.mode; run.threads = j.threads; } catch {} });
      p.on('error', () => {});
      b.cpu = { stop: () => { try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 1500); } };
    } catch { b.cpu = null; }
  }
  if (run.cpu && !b.cpu) { b.cpu = burnin.startCpuLoad(); run.threads = b.cpu.threads; run.engine = 'js'; if (run.level === 'high' && !mock) run.level = 'std'; }
  if (run.gpu) {
    b.gpuWin = new BrowserWindow({ width: 640, height: 380, title: L('smartCheck 显卡烤机', 'smartCheck GPU burn-in'), icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    b.gpuWin.loadFile(path.join(__dirname, 'renderer', 'burn.html'));
    b.gpuWin.on('closed', () => { b.gpuWin = null; });
  }
  // Sample every 2 s; demo data when there is no sensor reader (development / mock).
  const t0 = Date.now();
  b.timer = setInterval(() => {
    const t = Date.now(), k = (t - t0) / 60000;
    const sm = b.hasSensors ? { ...b.latest, t } : mock
      ? { t, cpuTemp: Math.round((45 + 40 * (1 - Math.exp(-k * 1.5))) * 10) / 10, gpuTemp: run.gpu ? Math.round((40 + 30 * (1 - Math.exp(-k))) * 10) / 10 : null, cpuClock: 4300 - Math.round(k * 40), cpuLoad: 100, gpuLoad: run.gpu ? 99 : null, cpuPower: 58, cpuFan: 1500 }
      : { t };
    run.samples.push(sm);
    burnSend({ type: 'sample', sample: sm, elapsed: Math.round((t - t0) / 1000), total: minutes * 60 });
    if (run.samples.length % 5 === 0) burnSave(burnPublic(run));
    if (t - t0 >= minutes * 60000) burnFinish('done');
  }, 2000);
  burnSave(run);
  burnSend({ type: 'start', run: burnPublic(run) });
  return { ok: true };
}

function burnFinish(status) {
  const b = burn;
  if (!b) return;
  burn = null;
  clearInterval(b.timer);
  try { b.cpu?.stop(); } catch {}
  try { if (b.gpuWin && !b.gpuWin.isDestroyed()) b.gpuWin.close(); } catch {}
  try { b.proc?.stdin.end(); setTimeout(() => { try { b.proc.kill(); } catch {} }, 1500); } catch {}
  const run = b.run;
  run.status = status; run.finishedAt = new Date().toISOString();
  run.result = burnin.evaluate(run, limits.limitsOf(loadSettings()));
  run.samples = burnin.thin(run.samples);
  burnSave(run);
  testResults.pc = { ...testResults.pc, burn: run };
  burnSend({ type: 'done', run });
  if (liveWanted) setTimeout(liveStart, 1600);
}

ipcMain.handle('burn:start', (_e, o) => burnStart(o || {}));
ipcMain.handle('burn:stop', () => { burnFinish('canceled'); return true; });
ipcMain.handle('burn:state', () => (burn ? { running: true, run: burnPublic(burn.run) } : { running: false, run: testResults.pc?.burn || null }));
app.on('will-quit', () => { if (burn) burnFinish('canceled'); if (mem) mem.stop(); });

// ---- memory test ----
let mem = null;
ipcMain.handle('mem:start', (_e, o) => {
  if (mem) return { ok: false, error: 'busy' };
  if (burn) return { ok: false, error: 'burn' };
  if (task) return { ok: false, error: 'task' };
  const passes = Math.max(1, Math.min(5, Number(o?.passes) || 1));
  const acc = { status: 'running', passes, startedAt: new Date().toISOString(), pct: 0, errors: 0 };
  const send = ev => { if (win && !win.isDestroyed()) win.webContents.send('mem:event', ev); };
  if (process.env.SMARTDISK_MOCK === '1') {   // demo
    let p = 0; const t = setInterval(() => { p += 5; send({ type: 'progress', pct: p, errors: 0, pass: 1 });
      if (p >= 100) { clearInterval(t); mem = null; Object.assign(acc, { status: 'done', errors: 0, testedBytes: 12 * 1024 ** 3, finishedAt: new Date().toISOString(), pct: 100 }); testResults.pc = { ...testResults.pc, mem: acc }; send({ type: 'done', result: acc }); } }, 300);
    mem = { stop: () => clearInterval(t) };
    send({ type: 'start', planBytes: 12 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 });
    return { ok: true };
  }
  const onEvent = ev => {
    if (ev.type === 'start') Object.assign(acc, { planBytes: ev.planBytes, totalBytes: ev.totalBytes, lockedBytes: ev.lockedBytes });
    if (ev.type === 'progress') Object.assign(acc, { pct: ev.pct, errors: ev.errors });
    if (ev.type === 'done') {
      if (!mem) return;   // only one end per test
      mem = null;
      Object.assign(acc, { status: ev.stopped ? 'canceled' : ev.error ? 'error' : 'done', errors: ev.errors, bad: ev.bad, testedBytes: ev.testedBytes, lockedBytes: ev.lockedBytes ?? acc.lockedBytes, error: ev.error, finishedAt: new Date().toISOString() });
      if (acc.status === 'done') testResults.pc = { ...testResults.pc, mem: acc };
      send({ type: 'done', result: acc });
      return;
    }
    send(ev);
  };
  // The helper locks the memory it tests in RAM and runs MemTest86-style patterns on all cores; without it, the
  // slower in-Node test (which Windows may page out under pressure).
  const exe = helperPath();
  if (fs.existsSync(exe)) {
    acc.engine = 'native';
    const child = spawn(exe, ['memtest', String(passes)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', gotDone = false;
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        try { const ev = JSON.parse(line); if (ev.type === 'done') gotDone = true; onEvent(ev); } catch {}
      }
    });
    child.on('error', e => onEvent({ type: 'done', errors: 0, error: String(e.message || e), testedBytes: 0 }));
    child.on('close', code => { if (!gotDone) onEvent({ type: 'done', errors: 0, error: `helper stopped (${code})`, testedBytes: 0, stopped: stopAsked }); });
    let stopAsked = false;
    send({ type: 'start', planBytes: 0, totalBytes: os.totalmem() });   // show "running" while the helper reserves memory
    mem = { stop: () => { stopAsked = true; try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill(); } catch {} }, 5000); } };
    return { ok: true };
  }
  acc.engine = 'js';
  mem = memtest.quickTest({ passes, onEvent });
  return { ok: true };
});
ipcMain.handle('mem:stop', () => { if (mem) mem.stop(); return true; });
ipcMain.handle('mem:state', async () => ({ running: !!mem, last: testResults.pc?.mem || null,
  full: process.env.SMARTDISK_MOCK === '1' ? { ok: true, id: 1201, time: '2026-11-20T10:12:00Z' } : await memtest.lastFullResult().catch(() => null) }));
ipcMain.handle('mem:full', async () => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: [L('现在重启并测试', 'Restart and test now'), L('下次重启时测试', 'Test at the next restart'), L('取消', 'Cancel')], cancelId: 2, title: 'smartCheck',
    message: L('用 Windows 内存诊断做完整测试？', 'Run the full Windows Memory Diagnostic?'),
    detail: L('电脑会重启进入蓝色的内存诊断画面（约 10 到 30 分钟），测完自动回到 Windows。回来后打开 smartCheck 就能看到结果。请先保存好工作。',
      'The PC restarts into the blue memory diagnostic screen (about 10 to 30 minutes) and returns to Windows by itself. Open smartCheck afterwards to see the result. Save your work first.') });
  if (r.response === 2) return { ok: false, canceled: true };
  const s = await memtest.scheduleFull();
  if (s.ok && r.response === 0) execFile('shutdown.exe', ['/r', '/t', '5'], { windowsHide: true }, () => {});
  return { ...s, restart: r.response === 0 };
});

// ---- full battery report ----
let batCache = null;
ipcMain.handle('battery:read', async () => {
  if (process.env.SMARTDISK_MOCK === '1') return { ok: true, report: { name: 'DELL 51KD7', maker: 'SMP', chemistry: 'LiP', design: 51000, full: 40120, cycles: 312, wear: 21.3, runtimeNow: 253, runtimeNew: 320,
    history: Array.from({ length: 24 }, (_, i) => ({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, full: 50500 - i * 430, design: 51000 })) } };
  batCache = await battery.read();
  if (batCache.ok) testResults.pc = { ...testResults.pc, battery: batCache.report };
  return { ok: batCache.ok, report: batCache.report, error: batCache.error, hasHtml: !!batCache.htmlFile };
});
ipcMain.handle('battery:html', () => { if (batCache?.htmlFile) shell.openPath(batCache.htmlFile); return !!batCache?.htmlFile; });
ipcMain.handle('task:results', () => testResults);
ipcMain.handle('selftest', (_e, a) => selfTest(Number(a?.disk), ['short', 'long', 'abort'].includes(a?.what) ? a.what : 'status'));
ipcMain.handle('update:check', () => checkUpdate(win, true));

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
// Opening smartCheck while the monitor runs just opens the window in the monitor process.
app.on('second-instance', () => createWindow());

app.whenReady().then(() => {
  // Before the monitor branch: after a crash the logon task starts the tray first, and the window opens in that process.
  burnRecover();
  if (monitorMode) {
    if (loadMonitor().enabled === false) return app.quit();
    startMonitor();
    return;
  }
  createWindow();
  // Make sure the logon task exists (the shop's first run sets it up), unless monitoring was turned off.
  if (loadMonitor().enabled !== false) setMonitorTask(true);
  // Look for a new version shortly after start (installed version only).
  setTimeout(() => { if (limits.featureOn(loadSettings(), 'autoupdate')) checkUpdate(win, false); }, 15000);
});
app.on('window-all-closed', () => {
  if (task) task.cancel();
  if (tray) return;   // the monitor keeps running in the tray
  // Installed copy: closing the window moves smartCheck to the tray right away instead of waiting for the next logon.
  if (app.isPackaged && process.platform === 'win32' && loadMonitor().enabled !== false) return startMonitor(true);
  app.quit();
});
