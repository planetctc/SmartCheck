const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
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
    scan, settings, version: app.getVersion(),
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
ipcMain.handle('update:check', () => checkUpdate(win, true));

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  createWindow();
  // Look for a new version shortly after start (installed version only).
  setTimeout(() => checkUpdate(win, false), 15000);
});
app.on('window-all-closed', () => app.quit());
