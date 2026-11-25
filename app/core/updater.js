// Online update, same approach as smartAcc: new versions are published as GitHub releases
// on planetctc/smartdisk-releases (see "publish" in package.json). Installed version only.
//
// 0.15.1 fix: the tray monitor downloads updates quietly. When the shop then clicked "Download and install" in a
// window, the update was already downloaded, the quiet flag swallowed the "ready" dialog and nothing seemed to
// happen. Now a downloaded update is remembered and the window always shows progress and the restart dialog.
const { app, dialog, BrowserWindow } = require('electron');
const { L } = require('../renderer/i18n');

let updater = null;
let downloading = false;
let downloadedVer = '';   // version already downloaded and waiting to install
let laterVer = '';
let showDialog = false;   // a person asked for this download in a window: show progress and the restart dialog
let winRef = null;        // the main window at the time of the last call (it can be closed and reopened)

const liveWin = () => (winRef && !winRef.isDestroyed() ? winRef : BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null);

// Tell the window what the updater is doing; the sidebar shows it under the scan time.
function status(phase, extra = {}) {
  const w = liveWin();
  if (!w) return;
  try {
    w.setProgressBar(phase === 'progress' ? Math.max(0.01, (extra.pct || 0) / 100) : phase === 'start' ? 2 : -1);
    w.webContents.send('update:status', { phase, ...extra });
  } catch {}
}

async function askRestart(version) {
  const w = liveWin();
  const opts = {
    type: 'info', buttons: [L('现在重启', 'Restart now'), L('稍后', 'Later')], defaultId: 0, cancelId: 1, title: 'smartPC',
    message: L(`smartPC ${version} 已下载好`, `smartPC ${version} is downloaded`),
    detail: L('重启 smartPC 就完成更新。\n选「稍后」的话，下次关闭 smartPC 时会自动更新。', 'Restart smartPC to finish the update.\nIf you choose Later, it updates the next time smartPC closes.'),
  };
  const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
  if (r.response === 0) setImmediate(() => updater.quitAndInstall(false, true));
}

function getUpdater() {
  if (updater !== null) return updater;
  updater = false;
  if (!app.isPackaged) return updater;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', p => { if (showDialog) status('progress', { pct: Math.round(p.percent || 0) }); });
    autoUpdater.on('update-downloaded', info => {
      downloading = false;
      downloadedVer = info.version;
      status('ready', { version: info.version });
      if (showDialog) { showDialog = false; askRestart(info.version); }
    });
    autoUpdater.on('error', () => { downloading = false; if (showDialog) status('error'); showDialog = false; });
    updater = autoUpdater;
  } catch { updater = false; }
  return updater;
}

// manual = true when the user clicked "检查更新" (then also report "latest" / errors).
async function checkUpdate(win, manual) {
  if (win) winRef = win;
  const u = getUpdater();
  const say = (type, message, detail) => { const w = liveWin(); const o = { type, title: 'smartPC', message, detail }; return w ? dialog.showMessageBox(w, o) : dialog.showMessageBox(o); };
  if (!u) { if (manual) say('info', L('网上更新只适用于安装版。', 'Online updates only work in the installed version.')); return { ok: false }; }
  if (downloading) {
    // Already downloading (maybe quietly by the tray): from now on show progress and the restart dialog here.
    showDialog = true; status('start');
    if (manual) say('info', L('正在下载更新，下载好会提示你重启。', 'The update is downloading. You will be asked to restart when it is ready.'));
    return { ok: true };
  }
  try {
    const r = await u.checkForUpdates();
    const info = r && r.updateInfo;
    const newer = info && info.version && info.version !== app.getVersion() && r.isUpdateAvailable !== false;
    if (!newer) { if (manual) say('info', L(`已经是最新版本（${app.getVersion()}）。`, `You have the latest version (${app.getVersion()}).`)); return { ok: true, latest: true }; }
    if (downloadedVer === info.version) { await askRestart(info.version); return { ok: true }; }
    if (!manual && info.version === laterVer) return { ok: true };
    const notes = String(info.releaseNotes || '').replace(/<[^>]+>/g, '').trim().slice(0, 800);
    const opts = {
      type: 'info', buttons: [L('下载并安装', 'Download and install'), L('以后再说', 'Not now')], defaultId: 0, cancelId: 1, title: 'smartPC',
      message: L(`有新版本 smartPC ${info.version}（目前是 ${app.getVersion()}）`, `smartPC ${info.version} is available (you have ${app.getVersion()})`), detail: notes,
    };
    const w = liveWin();
    const a = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    if (a.response !== 0) { laterVer = info.version; return { ok: true }; }
    if (downloading) { showDialog = true; status('start'); return { ok: true }; }   // the tray started it meanwhile
    downloading = true; showDialog = true;
    status('start', { version: info.version });
    u.downloadUpdate().catch(() => { downloading = false; showDialog = false; status('error'); });
    return { ok: true };
  } catch (e) {
    downloading = false;
    if (manual) say('warning', L('无法检查更新，请检查网络。', 'Could not check for updates. Check the internet connection.'), String(e && e.message || e).slice(0, 300));
    return { ok: false };
  }
}

async function checkUpdateSilent() {
  const u = getUpdater();
  if (!u || downloading || downloadedVer) return;
  try {
    const r = await u.checkForUpdates();
    const info = r && r.updateInfo;
    if (!info || !info.version || info.version === app.getVersion() || r.isUpdateAvailable === false) return;
    downloading = true;
    await u.downloadUpdate();
  } catch { downloading = false; }
}

module.exports = { checkUpdate, checkUpdateSilent };
