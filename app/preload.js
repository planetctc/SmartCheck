const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartdisk', {
  scan: () => ipcRenderer.invoke('disks:scan'),
  version: () => ipcRenderer.invoke('app:version'),
  settings: () => ipcRenderer.invoke('settings:get'),
  makeReport: (form) => ipcRenderer.invoke('report:make', form),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
});
