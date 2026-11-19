const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const { spawn, exec, execFile, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let serverProcess = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
// 관제 서버 설정의 단일 지점: 서버 엔진과 같은 server_config.json 을 읽는다
const SERVER_DATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'AURORA', 'Server');
const SERVER_CONFIG_FILE = path.join(SERVER_DATA_DIR, 'server_config.json');
const DEFAULT_PORT = 1557;
const AUTOSTART_TASK = 'AURORA Control Console';
const STARTUP_ARG = '--minimized';

function readServerPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
    const p = parseInt(cfg.port, 10);
    if (p >= 1 && p <= 65535) return p;
  } catch (e) {}
  return DEFAULT_PORT;
}
const PORT = readServerPort();
// 로그인 자동 시작(--minimized) 시에는 창을 띄우지 않고 트레이로 시작
const START_MINIMIZED = process.argv.includes('--minimized') || process.argv.includes('--hidden');

// 트레이 아이콘: assets/tray.png (+ tray@2x.png 고해상도). 파일이 없으면 아래 내장 아이콘 사용
const TRAY_ICON_FILE = path.join(__dirname, 'assets', 'tray.png');
const WINDOW_ICON_FILE = path.join(__dirname, 'build', 'icon.ico'); // 개발 모드용 (패키징 시에는 exe 아이콘 사용)
const APP_TITLE = 'AURORA Endpoint Control Console';

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGJbgPxQzpKWl/WdkZGRgYmJigLJhGKwBiiHg6uvr/4eHh/+H8YEmwTQMDw8HYmJi/v/9+xeiB6YaWRjZALhiZANQxckGoIkTNYDUwR41gPgAAJ9/J+7S5Y1NAAAAAElFTkSuQmCC';

// 이전 실행(또는 이전 버전 설치본)에서 남은 서버 엔진 정리
// 콘솔 창만 닫히고 엔진이 고아 프로세스로 남으면, 새 엔진이 포트를 못 열고
// 콘솔이 '이전 엔진'에 접속해 엉뚱한 상태(예: DB 오류 화면)를 보여주는 문제가 생긴다.
function killOrphanServerEngines() {
  try {
    execSync('taskkill /F /IM AuroraServerEngine.exe /T', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* 실행 중인 엔진이 없으면 오류 코드가 반환되므로 무시 */
  }
}

function startBackendServer() {
  killOrphanServerEngines();
  const isPackaged = app.isPackaged;
  const serverExe = isPackaged
    ? path.join(process.resourcesPath, 'AuroraServerEngine', 'AuroraServerEngine.exe')
    : path.join(__dirname, 'resources', 'AuroraServerEngine', 'AuroraServerEngine.exe');

  // 포트/주소는 서버 엔진이 server_config.json 에서 직접 읽는다 (인수로 넘기지 않음)
  serverProcess = spawn(serverExe, [], {
    cwd: path.dirname(serverExe),
    windowsHide: true,
  });

  serverProcess.on('exit', (code) => {
    if (!isQuitting && code !== 0 && code !== null) {
      dialog.showErrorBox(
        '서버 엔진 종료됨',
        `관제 서버 엔진이 비정상 종료되었습니다 (코드 ${code}).\n` +
          `포트 ${PORT}을(를) 다른 프로그램이 사용 중인지, 관리자 권한으로 실행했는지 확인하세요.`
      );
    }
  });

  serverProcess.on('error', (err) => {
    if (err.code === 'EACCES') {
      exec(
        `powershell -NoProfile -Command "Start-Process -FilePath '${serverExe}' -WorkingDirectory '${path.dirname(serverExe)}' -Verb RunAs -WindowStyle Hidden"`
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

function getAutostartScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tasks', 'aurora-autostart.ps1')
    : path.join(__dirname, 'resources', 'tasks', 'aurora-autostart.ps1');
}

// 콘솔 자동 시작: 관리자 권한 앱이므로 작업 스케줄러(현재 사용자 로그온, 가장 높은 권한)로 등록
function runAutostartTask(action) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', getAutostartScriptPath(),
        '-Action', action,
        '-TaskName', AUTOSTART_TASK,
        '-Exe', process.execPath,
        '-Arguments', STARTUP_ARG,
        '-Scope', 'CurrentUser',
      ],
      { windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        resolve({
          ok: !err && !out.startsWith('ERROR'),
          registered: out.includes('REGISTERED') && !out.includes('NOT_'),
          message: out,
        });
      }
    );
  });
}

function createTray() {
  let icon = fs.existsSync(TRAY_ICON_FILE) ? nativeImage.createFromPath(TRAY_ICON_FILE) : null;
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip(`${APP_TITLE} (서버 가동 중)`);

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
          title: `${APP_TITLE} 종료`,
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
    title: 'AURORA Endpoint Control',
    ...(fs.existsSync(WINDOW_ICON_FILE) ? { icon: WINDOW_ICON_FILE } : {}),
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
          title: APP_TITLE,
          content: '백그라운드에서 관제 서버가 계속 가동 중입니다. 완전 종료는 트레이 아이콘 우클릭을 이용하세요.',
        });
      }
    }
  });

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/health`);
    // 로그인은 아이디/비밀번호로 진행 (관리자 토큰 자동 주입 제거)
    await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  } catch (e) {
    dialog.showErrorBox('연결 실패', e.message);
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch (e) {}
  }
});

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
  ipcMain.handle('get-console-prefs', async () => {
    if (!app.isPackaged) return { openAtLogin: false };
    const r = await runAutostartTask('query');
    return { openAtLogin: r.registered };
  });

  ipcMain.handle('set-console-autostart', async (_e, enable) => {
    if (!app.isPackaged) {
      return { ok: false, openAtLogin: false, message: '개발 모드에서는 자동 시작을 설정할 수 없습니다.' };
    }
    const r = await runAutostartTask(enable ? 'register' : 'unregister');
    const q = await runAutostartTask('query');
    return { ok: r.ok && q.registered === Boolean(enable), openAtLogin: q.registered, message: r.message };
  });

  // 이전 버전이 등록한 로그인 항목(HKCU Run)은 관리자 권한 앱이라 동작하지 않으므로 정리
  if (app.isPackaged) {
    try {
      for (const args of [[], [STARTUP_ARG]]) {
        const legacy = { path: process.execPath, args };
        if (app.getLoginItemSettings(legacy).openAtLogin) {
          app.setLoginItemSettings({ ...legacy, openAtLogin: false });
        }
      }
    } catch (e) {}
  }

  app.whenReady().then(() => {
    createTray();
    createWindow();
  });
}