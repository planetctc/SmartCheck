const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartdisk', {
  scan: () => ipcRenderer.invoke('disks:scan'),
  version: () => ipcRenderer.invoke('app:version'),
});
