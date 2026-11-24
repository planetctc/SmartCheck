const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartdisk', {
  scan: () => ipcRenderer.invoke('disks:scan'),
});
