const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'AURORA');
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json');
const CONFIG_FILE = path.join(DATA_DIR, 'agent_config.json');

// --minimized / --hidden 인수로 부팅 자동 실행될 때만 트레이로 숨김 시작
const START_MINIMIZED =
  process.argv.includes('--minimized') || process.argv.includes('--hidden');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// 외부 아이콘 파일 없이도 선명하게 표시되는 16x16 내장 시안(Cyan) 트레이 아이콘
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGJbgPxQzpKWl/WdkZGRgYmJigLJhGKwBiiHg6uvr/4eHh/+H8YEmwTQMDw8HYmJi/v/9+xeiB6YaWRjZALhiZANQxckGoIkTNYDUwR41gPgAAJ9/J+7S5Y1NAAAAAElFTkSuQmCC';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return fallback;
}

// 사용자가 'http://192.168.0.10:8080' 형태로 입력해도 순수 호스트명만 추출
function normalizeHost(rawIp) {
  return (
    String(rawIp || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '') || '127.0.0.1'
  );
}

function getEngineExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'AuroraAgentEngine', 'AuroraAgentEngine.exe')
    : path.join(__dirname, 'resources', 'AuroraAgentEngine', 'AuroraAgentEngine.exe');
}

function checkServiceStatus() {
  return new Promise((resolve) => {
    exec('sc query AuroraUpdateAgent', (err, stdout) => {
      if (err) return resolve('NOT_INSTALLED');
      if (stdout.includes('RUNNING')) return resolve('RUNNING');
      if (stdout.includes('STOPPED')) return resolve('STOPPED');
      return resolve('UNKNOWN');
    });
  });
}

function pingServer(ip, port) {
  return new Promise((resolve) => {
    const cleanHost = normalizeHost(ip);
    const cleanPort = parseInt(port, 10) || 8080;
    const req = http.get(
      { hostname: cleanHost, port: cleanPort, path: '/api/state', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 403);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Windows 부팅 시 서비스 자동 시작(auto) + 장애 복구 + 트레이 앱 로그인 자동 실행 + 마지막 서버 재연결 강제
function ensureBootPersistenceAndReconnect() {
  ensureDataDir();

  // 1. 마지막 연결 서버 설정(agent_config.json) 보존 (없을 때만 기본값 생성)
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultCfg = {
      server_ip: '127.0.0.1',
      server_port: 8080,
      server_url: 'http://127.0.0.1:8080',
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultCfg, null, 2), 'utf8');
  }

  // 2. Windows 로그인 시 에이전트 트레이 UI 자동 시작 등록 (--minimized)
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: ['--minimized'],
      });
    } catch (e) {}
  }

  // 3. Windows 부팅 시 백그라운드 서비스 자동 시작 및 실패 시 자동 재시작 설정 + 즉시 기동
  const exePath = getEngineExePath();
  exec('sc query AuroraUpdateAgent', (err) => {
    if (err) {
      if (fs.existsSync(exePath)) {
        exec(
          `"${exePath}" install && sc config AuroraUpdateAgent start= auto && sc failure AuroraUpdateAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 && "${exePath}" start`
        );
      }
    } else {
      exec(
        'sc config AuroraUpdateAgent start= auto & sc failure AuroraUpdateAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 & net start AuroraUpdateAgent'
      );
    }
  });
}

function restartAgentService() {
  return new Promise((resolve) => {
    const exePath = getEngineExePath();

    exec('sc query AuroraUpdateAgent', (err) => {
      if (err) {
        exec(
          `"${exePath}" install && sc config AuroraUpdateAgent start= auto && sc failure AuroraUpdateAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 && "${exePath}" start`,
          (e2, _out, err2) => {
            resolve({
              ok: !e2,
              message: e2
                ? `서비스 설치 실패 (관리자 권한 확인): ${err2 || e2.message}`
                : '서비스 설치 및 시작 완료 (서버로 등록 요청 송신 중)',
            });
          }
        );
      } else {
        exec('net stop AuroraUpdateAgent', () => {
          exec(
            'sc config AuroraUpdateAgent start= auto & net start AuroraUpdateAgent',
            (e2, _out, err2) => {
              const alreadyRunning = err2 && err2.includes('2182');
              const ok = !e2 || alreadyRunning;
              resolve({
                ok,
                message: ok
                  ? '서비스 재시작 완료 (저장된 서버로 강제 연결 시도 중)'
                  : `서비스 시작 실패: ${err2 || e2.message}`,
              });
            }
          );
        });
      }
    });
  });
}

function sendShutdownLogToServer() {
  return new Promise((resolve) => {
    const identity = readJsonSafe(IDENTITY_FILE, {});
    const config = readJsonSafe(CONFIG_FILE, { server_ip: '127.0.0.1', server_port: 8080 });

    if (!identity.machine_id || !identity.agent_token) return resolve();

    const baseUrl =
      config.server_url ||
      `http://${normalizeHost(config.server_ip)}:${config.server_port || 8080}`;
    const targetUrl = new URL('/api/agent/shutdown', baseUrl);
    const body = JSON.stringify({
      machine_id: identity.machine_id,
      reason: '에이전트 트레이 메뉴에서 완전 종료 실행',
    });

    const client = targetUrl.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname,
        method: 'POST',
        timeout: 2500,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Agent-Token': identity.agent_token,
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

async function performFullShutdown() {
  if (isQuitting) return;
  isQuitting = true;

  await sendShutdownLogToServer();

  exec('net stop AuroraUpdateAgent', () => {
    if (tray) tray.destroy();
    app.exit(0);
  });
}

function showStatusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createStatusWindow(false);
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.handle('get-state', async () => {
  const identity = readJsonSafe(IDENTITY_FILE, { machine_id: '', agent_token: '' });
  const config = readJsonSafe(CONFIG_FILE, { server_ip: '127.0.0.1', server_port: 8080 });
  const serviceStatus = await checkServiceStatus();
  const serverReachable = await pingServer(
    config.server_ip || '127.0.0.1',
    config.server_port || 8080
  );
  return { identity, config, serviceStatus, serverReachable };
});

ipcMain.handle('save-config', async (_event, { ip, port }) => {
  ensureDataDir();
  const cleanIp = normalizeHost(ip);
  const cleanPort = parseInt(port, 10) || 8080;
  const payload = {
    server_ip: cleanIp,
    server_port: cleanPort,
    server_url: `http://${cleanIp}:${cleanPort}`,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return await restartAgentService();
});

ipcMain.handle('restart-service', async () => {
  return await restartAgentService();
});

function createTray() {
  const icon = nativeImage
    .createFromDataURL(TRAY_ICON_DATA_URL)
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('AURORA Update Agent (백그라운드 상시 실행 중)');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '에이전트 설정 및 토큰 열기',
      click: () => showStatusWindow(),
    },
    {
      label: '백그라운드 서비스 재시작 (서버 재연결)',
      click: () => restartAgentService(),
    },
    { type: 'separator' },
    {
      label: '완전 종료 (서버에 종료 로그 전송)',
      click: async () => {
        const res = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['완전 종료', '취소'],
          defaultId: 1,
          title: 'AURORA Agent 완전 종료',
          message: '에이전트와 백그라운드 업데이트 서비스를 완전히 종료하시겠습니까?',
          detail: '종료 시 중앙 관제 서버에 종료 로그가 기록되며 원격 업데이트 제어가 중단됩니다.',
        });
        if (res.response === 0) {
          await performFullShutdown();
        }
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => showStatusWindow());
  tray.on('double-click', () => showStatusWindow());
}

function createStatusWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 570,
    show: !startHidden,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#090d16',
    title: 'AURORA Update Agent 설정',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({
          title: 'AURORA Update Agent',
          content: '백그라운드 트레이에서 계속 실행 중입니다. 완전히 종료하려면 트레이 아이콘을 우클릭하세요.',
        });
      }
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showStatusWindow();
  });

  app.whenReady().then(() => {
    ensureBootPersistenceAndReconnect();
    createTray();
    createStatusWindow(START_MINIMIZED);
  });
}