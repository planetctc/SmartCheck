const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartdisk', {
  scan: () => ipcRenderer.invoke('disks:scan'),
  version: () => ipcRenderer.invoke('app:version'),
  settings: () => ipcRenderer.invoke('settings:get'),
  makeReport: (form) => ipcRenderer.invoke('report:make', form),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  startTask: (kind, disk, letter) => ipcRenderer.invoke('task:start', { kind, disk, letter }),
  cancelTask: () => ipcRenderer.invoke('task:cancel'),
  taskResults: () => ipcRenderer.invoke('task:results'),
  onTask: (fn) => ipcRenderer.on('task:event', (_e, ev) => fn(ev)),
});
