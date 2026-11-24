const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { mockTask } = require('./core/mocktask');
const { evaluate } = require('./core/health');
const { checkUpdate } = require('./core/updater');
const { readSystemInfo } = require('./core/sysinfo');

let win = null;
let lastScan = null;

// Packaged: resources/helper/smartdisk-helper.exe. Dev: ../helper/build/Release/...
function helperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'smartdisk-helper.exe');
  return path.join(__dirname, '..', 'helper', 'build', 'Release', 'smartdisk-helper.exe');
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
      raw.disks = raw.disks.map(d => ({ ...d, summary: evaluate(d) }));
      raw.scannedAt = new Date().toISOString();
      raw.mock = useMock;
      raw.computer = { name: os.hostname(), os: (os.version ? os.version() : os.type()) + ' ' + os.release() };
      lastScan = raw;
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
  const args = kind === 'bench' ? ['bench', String(letter || '').slice(0, 1), '1024'] : ['scan', String(diskIndex)];
  const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('task:event', { kind, key, ...ev }); };
  const acc = kind === 'bench' ? { letter, results: {}, startedAt: new Date().toISOString() } : { startedAt: new Date().toISOString() };

  const onEvent = (ev) => {
    if (kind === 'bench') {
      if (ev.type === 'result') acc.results[ev.test] = { mbps: ev.mbps, iops: ev.iops, ok: ev.ok };
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

// ---- settings (shop info for the report), stored in %APPDATA%\smartDisk\settings.json ----
const DEFAULT_SETTINGS = {
  shopName: 'PLANET COMPUTER TECHNOLOGY CENTRE',
  shopAddress: 'Batu Gajah, Perak',
  shopContact: 'WhatsApp +60 12-510 5542 · planet@planetctc.com.my',
  technician: '',
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const OLD_EMAIL = 'planetctc@gmail.com';
function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
    // Saved by 0.3.0 with the old shop email: switch to the new one.
    if (s.shopContact.includes(OLD_EMAIL)) s.shopContact = s.shopContact.replace(OLD_EMAIL, 'planet@planetctc.com.my');
    return s;
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = String(s[k] ?? '').slice(0, 200);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(clean, null, 2));
  return clean;
}

// ---- PDF report ----
async function makeReport(form) {
  const scan = lastScan || await scanDisks();
  const settings = saveSettings({ ...loadSettings(), ...form.shop, technician: form.technician });
  const payload = {
    scan, settings, tests: testResults, version: app.getVersion(),
    customer: String(form.customer || '').slice(0, 120),
    orderNo: String(form.orderNo || '').slice(0, 60),
    technician: settings.technician,
    note: String(form.note || '').slice(0, 1000),
    printedAt: new Date().toISOString(),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const safe = (payload.orderNo || stamp).replace(/[\\/:*?"<>|]/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存检测报告',
    defaultPath: path.join(app.getPath('documents'), `smartDisk-检测报告-${safe}.pdf`),
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
  win = new BrowserWindow({
    width: 1040, height: 700, minWidth: 860, minHeight: 580,
    title: 'smartDisk',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('disks:scan', () => scanDisks());
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('report:make', (_e, form) => makeReport(form || {}));
ipcMain.handle('task:start', (_e, a) => startTask(a?.kind === 'bench' ? 'bench' : 'scan', Number(a?.disk), a?.letter));
ipcMain.handle('task:cancel', () => { if (task) task.cancel(); return true; });
ipcMain.handle('task:results', () => testResults);
ipcMain.handle('update:check', () => checkUpdate(win, true));

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  createWindow();
  // Look for a new version shortly after start (installed version only).
  setTimeout(() => checkUpdate(win, false), 15000);
});
app.on('window-all-closed', () => { if (task) task.cancel(); app.quit(); });
