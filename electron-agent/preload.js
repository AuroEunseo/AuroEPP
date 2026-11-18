const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentApi', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (ip, port) => ipcRenderer.invoke('save-config', { ip, port }),
  restartService: () => ipcRenderer.invoke('restart-service'),
});