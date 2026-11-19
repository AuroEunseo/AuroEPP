const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let serverProcess = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
const PORT = 8080;
// 로그인 자동 시작(--minimized) 시에는 창을 띄우지 않고 트레이로 시작
const START_MINIMIZED = process.argv.includes('--minimized') || process.argv.includes('--hidden');

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGJbgPxQzpKWl/WdkZGRgYmJigLJhGKwBiiHg6uvr/4eHh/+H8YEmwTQMDw8HYmJi/v/9+xeiB6YaWRjZALhiZANQxckGoIkTNYDUwR41gPgAAJ9/J+7S5Y1NAAAAAElFTkSuQmCC';

function startBackendServer() {
  const isPackaged = app.isPackaged;
  const serverExe = isPackaged
    ? path.join(process.resourcesPath, 'AuroraServerEngine', 'AuroraServerEngine.exe')
    : path.join(__dirname, 'resources', 'AuroraServerEngine', 'AuroraServerEngine.exe');

  serverProcess = spawn(serverExe, [String(PORT)], {
    cwd: path.dirname(serverExe),
    windowsHide: true,
  });

  serverProcess.on('error', (err) => {
    if (err.code === 'EACCES') {
      exec(
        `powershell -NoProfile -Command "Start-Process -FilePath '${serverExe}' -ArgumentList '${PORT}' -WorkingDirectory '${path.dirname(serverExe)}' -Verb RunAs -WindowStyle Hidden"`
      );
      return;
    }
    dialog.showErrorBox('서버 실행 오류', `백엔드 엔진을 시작할 수 없습니다:\n${err.message}`);
  });
}

function waitForServer(url, retries = 35) {
  return new Promise((resolve, reject) => {
    const check = (left) => {
      http
        .get(url, () => resolve())
        .on('error', () => {
          if (left <= 0) return reject(new Error('서버 응답 시간 초과'));
          setTimeout(() => check(left - 1), 300);
        });
    };
    check(retries);
  });
}

function readLocalAdminToken() {
  const tokenPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'AURORA', 'Server', 'admin_token.json');
  try {
    if (fs.existsSync(tokenPath)) {
      return JSON.parse(fs.readFileSync(tokenPath, 'utf8')).admin_token || '';
    }
  } catch (e) {}
  return '';
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('AURORA Control Console (서버 가동 중)');

  const menu = Menu.buildFromTemplate([
    {
      label: '관제 콘솔 창 열기',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '콘솔 및 관제 서버 완전 종료',
      click: async () => {
        const res = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['완전 종료', '취소'],
          defaultId: 1,
          title: 'AURORA Control Console 종료',
          message: '관제 콘솔과 백그라운드 API 서버를 완전히 종료하시겠습니까?',
          detail: '서버가 종료되면 원격 PC 에이전트들이 상태를 보고할 수 없게 됩니다.',
        });
        if (res.response === 0) {
          isQuitting = true;
          exec('taskkill /F /IM AuroraServerEngine.exe /T', () => {
            if (tray) tray.destroy();
            app.exit(0);
          });
        }
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function createWindow() {
  startBackendServer();

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    title: 'AURORA Update Control',
    show: !START_MINIMIZED,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({
          title: 'AURORA Control Console',
          content: '백그라운드에서 관제 서버가 계속 가동 중입니다. 완전 종료는 트레이 아이콘 우클릭을 이용하세요.',
        });
      }
    }
  });

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/docs`);
    await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

    const localToken = readLocalAdminToken();
    if (localToken) {
      await mainWindow.webContents.executeJavaScript(`
        if (!sessionStorage.getItem('aurora_admin_token')) {
          sessionStorage.setItem('aurora_admin_token', ${JSON.stringify(localToken)});
          location.reload();
        }
      `);
    }
  } catch (e) {
    dialog.showErrorBox('연결 실패', e.message);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 콘솔 자동 시작 설정 (preload.js의 consoleApi를 통해 웹 UI에서 호출)
  // 로그인 자동 시작 시에는 창 없이 트레이로 시작하도록 --minimized 인수를 함께 등록
  const LOGIN_ITEM = { path: process.execPath, args: ['--minimized'] };

  ipcMain.handle('get-console-prefs', () => {
    const settings = app.getLoginItemSettings(LOGIN_ITEM);
    return { openAtLogin: Boolean(settings.openAtLogin) };
  });

  ipcMain.handle('set-console-autostart', (_e, enable) => {
    if (!app.isPackaged) {
      // 개발 모드(electron .)에서는 electron.exe가 등록되므로 실제 반영하지 않음
      return { ok: false, openAtLogin: false, message: '개발 모드에서는 자동 시작을 설정할 수 없습니다.' };
    }
    app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: Boolean(enable) });
    const applied = Boolean(app.getLoginItemSettings(LOGIN_ITEM).openAtLogin);
    return { ok: applied === Boolean(enable), openAtLogin: applied };
  });

  app.whenReady().then(() => {
    createTray();
    createWindow();
  });
}