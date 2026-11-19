const { contextBridge, ipcRenderer } = require('electron');

// 관제 콘솔 웹 UI(React)에서 사용하는 IPC 브리지
// - getPrefs: 현재 Windows 로그인 시 자동 시작 여부 조회
// - setAutoStart: 자동 시작 설정/해제 (결과 { ok, openAtLogin } 반환)
contextBridge.exposeInMainWorld('consoleApi', {
  getPrefs: () => ipcRenderer.invoke('get-console-prefs'),
  setAutoStart: (enable) => ipcRenderer.invoke('set-console-autostart', Boolean(enable)),
});
