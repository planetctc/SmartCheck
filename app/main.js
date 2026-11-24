const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { evaluate } = require('./core/health');

// Packaged: resources/helper/smartdisk-helper.exe. Dev: ../helper/build/Release/...
function helperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', 'smartdisk-helper.exe');
  return path.join(__dirname, '..', 'helper', 'build', 'Release', 'smartdisk-helper.exe');
}

// Single data entry point. A future Tailscale HTTP endpoint / PDF report reuse this.
function scanDisks() {
  return new Promise((resolve) => {
    const exe = helperPath();
    const useMock = process.env.SMARTDISK_MOCK === '1' || process.platform !== 'win32' || !fs.existsSync(exe);
    const finish = (raw) => {
      raw.disks = raw.disks.map(d => ({ ...d, summary: evaluate(d) }));
      raw.scannedAt = new Date().toISOString();
      raw.mock = useMock;
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

function createWindow() {
  const win = new BrowserWindow({
    width: 980, height: 680, minWidth: 820, minHeight: 560,
    title: 'SmartDisk',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('disks:scan', () => scanDisks());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
