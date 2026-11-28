// Preload for the GPU burn-in window: get the VRAM size to test, and report load / VRAM results back to main.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('burnGpu', {
  config: () => ipcRenderer.invoke('burn:gpuConfig'),
  report: s => ipcRenderer.send('burn:gpuStat', s),
});
