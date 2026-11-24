// Online update, same approach as smartAcc: new versions are published as GitHub releases
// on planetctc/smartdisk-releases (see "publish" in package.json). Installed version only.
const { app, dialog } = require('electron');

let updater = null;
let busy = false;
let laterVer = '';

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
      try { if (win && !win.isDestroyed()) win.setProgressBar(-1); } catch {}
      const r = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['现在重启', '稍后'], defaultId: 0, cancelId: 1, title: 'smartDisk',
        message: `smartDisk ${info.version} 已下载好`,
        detail: '重启 smartDisk 就完成更新。\n选「稍后」的话，下次关闭 smartDisk 时会自动更新。',
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
  const say = (type, message, detail) => dialog.showMessageBox(win, { type, title: 'smartDisk', message, detail });
  if (!u) { if (manual) say('info', '网上更新只适用于安装版。'); return { ok: false }; }
  if (busy) { if (manual) say('info', '正在下载更新。'); return { ok: true }; }
  try {
    const r = await u.checkForUpdates();
    const info = r && r.updateInfo;
    const newer = info && info.version && info.version !== app.getVersion() && r.isUpdateAvailable !== false;
    if (!newer) { if (manual) say('info', `已经是最新版本（${app.getVersion()}）。`); return { ok: true, latest: true }; }
    if (!manual && info.version === laterVer) return { ok: true };
    const notes = String(info.releaseNotes || '').replace(/<[^>]+>/g, '').trim().slice(0, 800);
    const a = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['下载并安装', '以后再说'], defaultId: 0, cancelId: 1, title: 'smartDisk',
      message: `有新版本 smartDisk ${info.version}（目前是 ${app.getVersion()}）`, detail: notes,
    });
    if (a.response !== 0) { laterVer = info.version; return { ok: true }; }
    busy = true;
    await u.downloadUpdate();
    return { ok: true };
  } catch (e) {
    busy = false;
    if (manual) say('warning', '无法检查更新，请检查网络。', String(e && e.message || e).slice(0, 300));
    return { ok: false };
  }
}

module.exports = { checkUpdate };
