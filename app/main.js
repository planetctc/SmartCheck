const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
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
const I18N = require('./renderer/i18n');
const { L } = I18N;
const { readSystemInfo } = require('./core/sysinfo');

let win = null;
let lastScan = null;

// Packaged: resources/helper/smartdisk-helper.exe. Dev: ../helper/build/Release/...
function helperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'smartdisk-helper.exe');
  return path.join(__dirname, '..', 'helper', 'build', 'Release', 'smartdisk-helper.exe');
}

function diskspdPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'diskspd.exe');
  return path.join(__dirname, '..', 'third_party', 'diskspd', 'diskspd_vs', 'x64', 'Release', 'diskspd.exe');
}

// Single data entry point. The PDF report (and a future Tailscale HTTP endpoint) reuse this.
async function scanDisks() {
  const [disks, system] = await Promise.all([scanDisksOnly(), readSystemInfo({ mock: process.env.SMARTDISK_MOCK === '1' })]);
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
    if (kind === 'capacity' && status !== 'done' && L1) { try { fs.rmSync(`${L1}:\\smartDisk-capacity-test`, { recursive: true, force: true }); } catch {} }
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
// Other shops using smartDisk put their own name and WhatsApp number here (or turn the button off).
const DEFAULT_SETTINGS = {
  shopName: 'PLANET COMPUTER TECHNOLOGY CENTRE',
  shopAddress: 'Batu Gajah, Perak',
  shopContact: 'WhatsApp +60 12-510 5542 · planet@planetctc.com.my',
  technician: '',
  whatsapp: '+60 12-510 5542',
  whatsappOn: '1',
  lang: 'zh',
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
  for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = String(s[k] ?? '').slice(0, 200);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(clean, null, 2));
  I18N.setLang(clean.lang);
  return clean;
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
    defaultPath: path.join(app.getPath('documents'), `smartDisk-${L('检测报告', 'Report')}-${safe}.pdf`),
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
  return { ok: true, filePath };
}

function createWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1040, height: 700, minWidth: 860, minHeight: 580,
    title: 'smartDisk',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// ---- background monitor (tray) ----
// Started at logon by a scheduled task ("smartDisk Monitor", runs elevated for any user) with --monitor.
// Compares each check with the baseline recorded when the disk was first seen and alerts the customer only.
const MONITOR_TASK = 'smartDisk Monitor';
const CHECK_EVERY_MS = 15 * 60 * 1000;
const monitorMode = process.argv.includes('--monitor');
let tray = null;
let alertWin = null;
let pendingAlerts = [];

const monitorFile = () => path.join(process.env.ProgramData || app.getPath('userData'), 'smartDisk', 'monitor.json');
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
  const { state, alerts } = monitor.check({ disks: m.disks || {} }, scan);
  saveMonitor({ ...m, disks: state.disks });
  if (notify && alerts.length) showAlerts(alerts, scan);
}

function xmlEsc(v) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Create or remove the logon task. Only for the installed app on Windows; the app itself runs elevated.
function setMonitorTask(enabled) {
  if (!app.isPackaged || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    if (!enabled) return execFile('schtasks.exe', ['/Delete', '/TN', MONITOR_TASK, '/F'], { windowsHide: true }, () => resolve(true));
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>PLANET COMPUTER TECHNOLOGY CENTRE</Author><Description>smartDisk 硬盘健康监控</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><Delay>PT1M</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><GroupId>S-1-5-32-545</GroupId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
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
      title: L('smartDisk 硬盘提醒', 'smartDisk drive alert'),
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
    title: L('smartDisk 硬盘提醒', 'smartDisk drive alert'), icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
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
    const lines = [L(`你好${shop ? ' ' + shop : ''}，smartDisk 提醒我的硬盘有问题：`, `Hi${shop ? ' ' + shop : ''}, smartDisk warned me about a problem with my drive:`),
      ...a.map(x => `- ${x.model}${x.letters.length ? ' (' + x.letters.join(' ') + ')' : ''}: ${x.text.join(L('；', '; '))}`),
      `${L('电脑', 'PC')}: ${a[0]?.pc || os.hostname()}`];
    shell.openExternal(`https://wa.me/${whatsappNumber()}?text=${encodeURIComponent(lines.join('\n'))}`);
  } else if (action === 'open') {
    createWindow();
  }
  if (action !== 'whatsapp' && alertWin && !alertWin.isDestroyed()) alertWin.close();
}

async function monitorCheck(manual) {
  const scan = await scanDisksOnly();
  if (!scan.disks?.length) return;
  history.record(historyFile(), scan);
  const m = loadMonitor();
  const { state, alerts } = monitor.check({ disks: m.disks || {} }, scan);
  saveMonitor({ ...m, disks: state.disks });
  if (alerts.length) showAlerts(alerts, scan);
  else if (manual) {
    const worst = scan.disks.filter(d => d.summary?.health != null).map(d => `${d.model}：${d.summary.health}%`).join('\n');
    dialog.showMessageBox({ type: 'info', title: 'smartDisk', message: L('硬盘状况和安装时一样，没有新问题。', 'No new problems since the drives were first checked.'), detail: worst });
  }
  updateTrayTip(scan);
}

function updateTrayTip(scan) {
  if (!tray) return;
  const parts = (scan?.disks || []).filter(d => d.summary?.health != null).map(d => `${(d.letters || []).join(' ') || d.model.slice(0, 16)} ${d.summary.health}%`);
  tray.setToolTip(`${L('smartDisk 硬盘监控', 'smartDisk drive monitor')}\n${parts.join('\n')}`.slice(0, 127));
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: L('打开 smartDisk', 'Open smartDisk'), click: () => createWindow() },
    { label: L('立即检查', 'Check now'), click: () => monitorCheck(true) },
    ...(whatsappNumber() ? [{ label: L('WhatsApp 联系我们', 'Contact us on WhatsApp'), click: () => shell.openExternal(`https://wa.me/${whatsappNumber()}`) }] : []),
    { type: 'separator' },
    { label: L('以目前状态为基准', 'Use current state as baseline'), click: async () => {
      const r = await dialog.showMessageBox({ type: 'question', buttons: [L('确定', 'OK'), L('取消', 'Cancel')], cancelId: 1, title: 'smartDisk',
        message: L('把目前的硬盘状态设为新的基准？', 'Make the current drive state the new baseline?'),
        detail: L('之后只会在比目前更差时才提醒。一般只在换硬盘或维修后使用。', 'Alerts will only come when things get worse than now. Use this after replacing or repairing a drive.') });
      if (r.response !== 0) return;
      const scan = await scanDisksOnly();
      const m = loadMonitor();
      saveMonitor({ ...m, disks: monitor.rebase(null, scan).disks });
    } },
    { label: L('退出监控', 'Quit monitor'), click: async () => {
      const r = await dialog.showMessageBox({ type: 'question', buttons: [L('只是这次', 'Just this time'), L('以后都不要监控', 'Turn monitoring off'), L('取消', 'Cancel')], cancelId: 2, title: 'smartDisk',
        message: L('退出硬盘监控？', 'Quit the drive monitor?'), detail: L('选「只是这次」，下次开机还会自动监控。', 'With "Just this time", monitoring starts again at the next sign-in.') });
      if (r.response === 2) return;
      if (r.response === 1) { saveMonitor({ ...loadMonitor(), enabled: false }); await setMonitorTask(false); }
      app.quit();
    } },
  ]);
  tray.setContextMenu(menu);
}

function startMonitor() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(L('smartDisk 硬盘监控', 'smartDisk drive monitor'));
  refreshTrayMenu();
  tray.on('double-click', () => createWindow());
  setTimeout(() => monitorCheck(false), 2 * 60 * 1000);
  setInterval(() => monitorCheck(false), CHECK_EVERY_MS);
  // Installed copies on customer PCs update themselves quietly; the new version installs when Windows restarts.
  setTimeout(() => checkUpdateSilent(), 10 * 60 * 1000);
  setInterval(() => checkUpdateSilent(), 24 * 3600 * 1000);
}

ipcMain.handle('disks:scan', async () => { const r = await scanDisks(); updateMonitor(r, false); return r; });
ipcMain.handle('alert:get', () => alertPayload());
ipcMain.handle('monitor:get', () => loadMonitor());
ipcMain.handle('history:get', () => history.load(historyFile()));
ipcMain.handle('alert:action', (_e, a) => alertAction(String(a)));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, v) => { const r = saveSettings({ ...loadSettings(), ...(v || {}) }); refreshTrayMenu(); return r; });
ipcMain.handle('report:make', (_e, form) => makeReport(form || {}));
ipcMain.handle('task:start', (_e, a) => startTask(['bench', 'capacity', 'erase'].includes(a?.kind) ? a.kind : 'scan', Number(a?.disk), a?.letter));
ipcMain.handle('task:cancel', () => { if (task) task.cancel(); return true; });
ipcMain.handle('task:results', () => testResults);
ipcMain.handle('selftest', (_e, a) => selfTest(Number(a?.disk), ['short', 'long', 'abort'].includes(a?.what) ? a.what : 'status'));
ipcMain.handle('update:check', () => checkUpdate(win, true));

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
// Opening smartDisk while the monitor runs just opens the window in the monitor process.
app.on('second-instance', () => createWindow());

app.whenReady().then(() => {
  if (monitorMode) {
    if (loadMonitor().enabled === false) return app.quit();
    startMonitor();
    return;
  }
  createWindow();
  // Make sure the logon task exists (the shop's first run sets it up), unless monitoring was turned off.
  if (loadMonitor().enabled !== false) setMonitorTask(true);
  // Look for a new version shortly after start (installed version only).
  setTimeout(() => checkUpdate(win, false), 15000);
});
app.on('window-all-closed', () => {
  if (task) task.cancel();
  if (!tray) app.quit();   // the monitor keeps running in the tray
});
