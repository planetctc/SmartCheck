// Online update, same approach as smartAcc: new versions are published as GitHub releases
// on planetctc/smartdisk-releases (see "publish" in package.json). Installed version only.
const { app, dialog } = require('electron');
const { L } = require('../renderer/i18n');

let updater = null;
let busy = false;
let laterVer = '';
let silent = false;   // tray monitor: download quietly, install when the app quits (e.g. Windows shutdown)

function getUpdater(win) {
  if (updater !== null) return updater;
  updater = false;
  if (!app.isPackaged) return updater;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', p => {
      try { if (win && !win.isDestroyed()) win.setProgressBar(p.percent / 100); } catch {}
    });
    autoUpdater.on('update-downloaded', async info => {
      busy = false;
      if (silent) return;
      try { if (win && !win.isDestroyed()) win.setProgressBar(-1); } catch {}
      const r = await dialog.showMessageBox(win, {
        type: 'info', buttons: [L('现在重启', 'Restart now'), L('稍后', 'Later')], defaultId: 0, cancelId: 1, title: 'smartPC',
        message: L(`smartPC ${info.version} 已下载好`, `smartPC ${info.version} is downloaded`),
        detail: L('重启 smartPC 就完成更新。\n选「稍后」的话，下次关闭 smartPC 时会自动更新。', 'Restart smartPC to finish the update.\nIf you choose Later, it updates the next time smartPC closes.'),
      });
      if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    });
    updater = autoUpdater;
  } catch { updater = false; }
  return updater;
}

// manual = true when the user clicked "检查更新" (then also report "latest" / errors).
async function checkUpdate(win, manual) {
  const u = getUpdater(win);
  const say = (type, message, detail) => dialog.showMessageBox(win, { type, title: 'smartPC', message, detail });
  if (!u) { if (manual) say('info', L('网上更新只适用于安装版。', 'Online updates only work in the installed version.')); return { ok: false }; }
  if (busy) { if (manual) say('info', L('正在下载更新。', 'An update is downloading.')); return { ok: true }; }
  try {
    const r = await u.checkForUpdates();
    const info = r && r.updateInfo;
    const newer = info && info.version && info.version !== app.getVersion() && r.isUpdateAvailable !== false;
    if (!newer) { if (manual) say('info', L(`已经是最新版本（${app.getVersion()}）。`, `You have the latest version (${app.getVersion()}).`)); return { ok: true, latest: true }; }
    if (!manual && info.version === laterVer) return { ok: true };
    const notes = String(info.releaseNotes || '').replace(/<[^>]+>/g, '').trim().slice(0, 800);
    const a = await dialog.showMessageBox(win, {
      type: 'info', buttons: [L('下载并安装', 'Download and install'), L('以后再说', 'Not now')], defaultId: 0, cancelId: 1, title: 'smartPC',
      message: L(`有新版本 smartPC ${info.version}（目前是 ${app.getVersion()}）`, `smartPC ${info.version} is available (you have ${app.getVersion()})`), detail: notes,
    });
    if (a.response !== 0) { laterVer = info.version; return { ok: true }; }
    busy = true;
    await u.downloadUpdate();
    return { ok: true };
  } catch (e) {
    busy = false;
    if (manual) say('warning', L('无法检查更新，请检查网络。', 'Could not check for updates. Check the internet connection.'), String(e && e.message || e).slice(0, 300));
    return { ok: false };
  }
}

async function checkUpdateSilent() {
  const u = getUpdater(null);
  if (!u || busy) return;
  try {
    const r = await u.checkForUpdates();
    const info = r && r.updateInfo;
    if (!info || !info.version || info.version === app.getVersion() || r.isUpdateAvailable === false) return;
    silent = true; busy = true;
    await u.downloadUpdate();
  } catch { busy = false; }
}

module.exports = { checkUpdate, checkUpdateSilent };
