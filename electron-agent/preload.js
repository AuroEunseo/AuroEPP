const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentApi', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (ip, port) => ipcRenderer.invoke('save-config', { ip, port }),
  restartService: () => ipcRenderer.invoke('restart-service'),
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  openLog: () => ipcRenderer.invoke('open-log'),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, view) => cb(view)),
  catalogList: () => ipcRenderer.invoke('catalog-list'),
  catalogIcon: (id, rev) => ipcRenderer.invoke('catalog-icon', { id, rev }),
  catalogRequest: (id) => ipcRenderer.invoke('catalog-request', { id }),
});