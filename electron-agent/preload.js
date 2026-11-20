const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentApi', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (ip, port) => ipcRenderer.invoke('save-config', { ip, port }),
  restartService: () => ipcRenderer.invoke('restart-service'),
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  openStore: () => ipcRenderer.invoke('open-store'),
  catalogList: () => ipcRenderer.invoke('catalog-list'),
  catalogIcon: (id, rev) => ipcRenderer.invoke('catalog-icon', { id, rev }),
  catalogRequest: (id) => ipcRenderer.invoke('catalog-request', { id }),
});