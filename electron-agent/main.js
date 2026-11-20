const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

const DATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'AURORA');
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json');
// 관제 서버 주소의 단일 설정 지점 (서비스·워커·트레이 모두 이 파일만 사용)
const CONFIG_FILE = path.join(DATA_DIR, 'agent_config.json');
// 서비스가 남기는 연결 진단 로그 (부팅 후 재연결 실패 시 원인 확인용)
const AGENT_LOG_FILE = path.join(DATA_DIR, 'logs', 'agent.log');
const DEFAULT_SERVER_IP = '127.0.0.1';
const DEFAULT_SERVER_PORT = 1557;
// 작업 스케줄러 작업 이름은 제품명이 바뀌어도 유지 (기존 설치본과 같은 이름이어야 제거·업데이트 시 정리됨)
const AUTOSTART_TASK = 'AURORA Update Agent Tray';
const APP_TITLE = 'AURORA Endpoint Agent';

// 로그인 자동 실행 인수: --minimized (작업 스케줄러 자동 시작 작업과 동일)
// --tray / --hidden 은 이전 버전 설치본 호환용으로만 인식
const STARTUP_ARG = '--minimized';
const START_MINIMIZED = [STARTUP_ARG, '--tray', '--hidden'].some((a) => process.argv.includes(a));

let mainWindow = null;
let storeWindow = null;
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

// 사용자가 'http://192.168.0.10:1557' 형태로 입력해도 순수 호스트명만 추출
function normalizeHost(rawIp) {
  return (
    String(rawIp || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '') || DEFAULT_SERVER_IP
  );
}

function readServerConfig() {
  const cfg = readJsonSafe(CONFIG_FILE, {});
  let ip = cfg.server_ip;
  let port = cfg.server_port;
  if (!ip && cfg.server_url) {
    // 이전 버전 설정 파일 호환
    const m = String(cfg.server_url).match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?/i);
    if (m) {
      ip = m[1];
      port = m[2];
    }
  }
  return {
    server_ip: normalizeHost(ip || DEFAULT_SERVER_IP),
    server_port: parseInt(port, 10) || DEFAULT_SERVER_PORT,
  };
}

function writeServerConfig(ip, port) {
  ensureDataDir();
  const payload = {
    server_ip: normalizeHost(ip),
    server_port: parseInt(port, 10) || DEFAULT_SERVER_PORT,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function getAutostartScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tasks', 'aurora-autostart.ps1')
    : path.join(__dirname, 'resources', 'tasks', 'aurora-autostart.ps1');
}

// 작업 스케줄러 자동 시작 작업 등록/해제/조회 (관리자 권한 앱은 Run 레지스트리로 자동 실행되지 않음)
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
        '-Scope', 'AllUsers',
      ],
      { windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        resolve({ ok: !err && !out.startsWith('ERROR'), registered: out.includes('REGISTERED') && !out.includes('NOT_'), message: out });
      }
    );
  });
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
    const cleanPort = parseInt(port, 10) || DEFAULT_SERVER_PORT;
    const req = http.get(
      { hostname: cleanHost, port: cleanPort, path: '/api/health', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
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

  // 1. 마지막 연결 서버 설정(agent_config.json) 보존 (없으면 기본값, 이전 형식이면 새 형식으로 정리)
  const cfg = readServerConfig();
  writeServerConfig(cfg.server_ip, cfg.server_port);

  // 2. 로그인 자동 실행: 작업 스케줄러(가장 높은 권한, 모든 사용자 로그온, --minimized)
  //    설치 파일이 등록하지만, 누락된 경우를 대비해 실행 시마다 확인 후 재등록한다.
  //    이전 버전이 등록한 HKCU 로그인 항목은 중복 실행 방지를 위해 정리한다.
  if (app.isPackaged) {
    try {
      for (const args of [[STARTUP_ARG], ['--tray']]) {
        const legacy = { path: process.execPath, args };
        if (app.getLoginItemSettings(legacy).openAtLogin) {
          app.setLoginItemSettings({ ...legacy, openAtLogin: false });
        }
      }
    } catch (e) {}
    runAutostartTask('query').then((r) => {
      if (!r.registered) runAutostartTask('register');
    });
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
    const config = readServerConfig();

    if (!identity.machine_id || !identity.agent_token) return resolve();

    const baseUrl = `http://${config.server_ip}:${config.server_port}`;
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
  const config = readServerConfig();
  const serviceStatus = await checkServiceStatus();
  const serverReachable = await pingServer(config.server_ip, config.server_port);
  return { identity, config, serviceStatus, serverReachable };
});

ipcMain.handle('get-tasks', () => readTasks().tasks);

ipcMain.handle('save-config', async (_event, { ip, port }) => {
  writeServerConfig(ip, port);
  return await restartAgentService();
});

ipcMain.handle('restart-service', async () => {
  return await restartAgentService();
});

// ------------------------------------------------------------------
// 프로그램 설치 센터 (관리자가 '셀프 설치 허용'으로 공개한 프로그램을 사용자가 직접 설치)
//  - 목록·아이콘 조회와 설치 요청만 서버에 보낸다. 실제 설치 명령은 서버가 서명해서 서비스에 전달하므로
//    이 창(트레이 앱)이 직접 설치를 실행하지 않는다.
// ------------------------------------------------------------------
function agentRequest(method, apiPath, body, { raw = false, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const identity = readJsonSafe(IDENTITY_FILE, {});
    const config = readServerConfig();
    if (!identity.machine_id || !identity.agent_token) {
      return resolve({ status: 0, error: '아직 서버에 등록되지 않은 PC입니다. (콘솔에서 승인 후 사용 가능)' });
    }
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: config.server_ip,
        port: config.server_port,
        path: apiPath,
        method,
        timeout,
        headers: {
          'X-Machine-ID': identity.machine_id,
          'X-Agent-Token': identity.agent_token,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 512 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (raw) return resolve({ status: res.statusCode, buffer: buf, type: String(res.headers['content-type'] || '') });
          let json = {};
          try {
            json = JSON.parse(buf.toString('utf8') || '{}');
          } catch (e) {}
          resolve({ status: res.statusCode, json, error: res.statusCode >= 400 ? json.detail || `서버 오류 (${res.statusCode})` : '' });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: `관제 서버에 연결할 수 없습니다 (${e.code || e.message})` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: '관제 서버 응답 시간 초과' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const iconCache = new Map(); // `${id}:${rev}` → data URL

ipcMain.handle('catalog-list', async () => {
  const r = await agentRequest('GET', '/api/agent/catalog');
  if (r.error) return { ok: false, error: r.error, items: [] };
  return { ok: true, items: r.json.items || [] };
});

ipcMain.handle('catalog-icon', async (_e, { id, rev }) => {
  const key = `${parseInt(id, 10)}:${parseInt(rev, 10)}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const r = await agentRequest('GET', `/api/agent/catalog/${parseInt(id, 10)}/icon`, undefined, { raw: true });
  let url = '';
  if (r.status === 200 && r.buffer && r.buffer.length) {
    const type = r.type.startsWith('image/png') ? 'image/png' : r.type.startsWith('image/x-icon') ? 'image/x-icon' : '';
    if (type) url = `data:${type};base64,${r.buffer.toString('base64')}`;
  }
  iconCache.set(key, url);
  return url;
});

ipcMain.handle('catalog-request', async (_e, { id }) => {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch (e) {}
  const r = await agentRequest('POST', `/api/agent/catalog/${parseInt(id, 10)}/request`, { user });
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, ...r.json };
});

ipcMain.handle('open-store', () => showStoreWindow());

function showStoreWindow() {
  if (storeWindow && !storeWindow.isDestroyed()) {
    if (storeWindow.isMinimized()) storeWindow.restore();
    storeWindow.show();
    storeWindow.focus();
    return;
  }
  storeWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: '#090d16',
    title: '프로그램 설치 센터',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  storeWindow.on('closed', () => {
    storeWindow = null;
  });
  storeWindow.loadFile(path.join(__dirname, 'store.html'));
}

// ------------------------------------------------------------------
// 작업 현황 (서비스가 기록하는 tasks.json → 트레이 메뉴 '진행 중인 작업' / 설정 창)
// ------------------------------------------------------------------
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
let lastTasksStamp = 0;
let notifiedFinished = null; // 이미 알림을 띄운 완료 작업 ID

function readTasks() {
  const data = readJsonSafe(TASKS_FILE, { updated: 0, tasks: [] });
  return { updated: data.updated || 0, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
}

function taskLabel(t) {
  const pct = t.progress != null && !t.finished && t.status === '다운로드 중' ? ` ${t.progress}%` : '';
  const state = t.finished ? (t.ok ? '완료' : '실패') : t.status;
  return `${t.title} — ${state}${pct}`;
}

function buildTrayMenu(tasks) {
  const active = tasks.filter((t) => !t.finished);
  const recent = tasks.filter((t) => t.finished).slice(-5).reverse();
  return Menu.buildFromTemplate([
    {
      label: active.length ? `진행 중인 작업 (${active.length})` : '진행 중인 작업 없음',
      enabled: active.length > 0,
      submenu: active.length ? active.map((t) => ({ label: taskLabel(t), enabled: false })) : undefined,
    },
    {
      label: '최근 완료된 작업',
      enabled: recent.length > 0,
      submenu: recent.length
        ? recent.map((t) => ({ label: `${t.ok ? '✔' : '✖'} ${t.title} (${new Date(t.finished * 1000).toLocaleTimeString('ko-KR')})`, enabled: false }))
        : undefined,
    },
    { type: 'separator' },
    {
      label: '프로그램 설치 센터 열기',
      click: () => showStoreWindow(),
    },
    {
      label: '에이전트 설정 및 작업 현황 열기',
      click: () => showStatusWindow(),
    },
    {
      label: '백그라운드 서비스 재시작 (서버 재연결)',
      click: () => restartAgentService(),
    },
    {
      label: '연결 진단 로그 열기',
      click: () => {
        if (fs.existsSync(AGENT_LOG_FILE)) shell.openPath(AGENT_LOG_FILE);
        else dialog.showMessageBox({ type: 'info', message: '아직 기록된 로그가 없습니다.', detail: AGENT_LOG_FILE });
      },
    },
    { type: 'separator' },
    {
      label: '완전 종료 (서버에 종료 로그 전송)',
      click: async () => {
        const res = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['완전 종료', '취소'],
          defaultId: 1,
          title: `${APP_TITLE} 완전 종료`,
          message: '에이전트와 백그라운드 업데이트 서비스를 완전히 종료하시겠습니까?',
          detail: '종료 시 중앙 관제 서버에 종료 로그가 기록되며 원격 업데이트 제어가 중단됩니다.',
        });
        if (res.response === 0) {
          await performFullShutdown();
        }
      },
    },
  ]);
}

// 2초마다 작업 현황을 읽어 트레이 메뉴·툴팁을 갱신하고, 프로그램 설치가 끝나면 알림 풍선 표시
function refreshTasks() {
  if (!tray || tray.isDestroyed()) return;
  const { updated, tasks } = readTasks();
  if (updated === lastTasksStamp) return;
  lastTasksStamp = updated;
  tray.setContextMenu(buildTrayMenu(tasks));
  const active = tasks.filter((t) => !t.finished);
  const tip = active.length ? `${APP_TITLE} — ${taskLabel(active[0])}${active.length > 1 ? ` 외 ${active.length - 1}건` : ''}` : `${APP_TITLE} (백그라운드 상시 실행 중)`;
  tray.setToolTip(tip.slice(0, 120));

  const finished = tasks.filter((t) => t.finished);
  if (notifiedFinished === null) {
    notifiedFinished = new Set(finished.map((t) => t.id)); // 앱 시작 전 완료분은 알리지 않음
    return;
  }
  for (const t of finished) {
    if (notifiedFinished.has(t.id)) continue;
    notifiedFinished.add(t.id);
    if (t.kind === 'package') {
      tray.displayBalloon({
        title: t.ok ? '프로그램 작업 완료' : '프로그램 작업 실패',
        content: `${t.title}${t.detail ? `\n${t.detail}` : ''}`.slice(0, 250),
      });
    }
  }
}

function createTray() {
  const icon = nativeImage
    .createFromDataURL(TRAY_ICON_DATA_URL)
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(`${APP_TITLE} (백그라운드 상시 실행 중)`);
  tray.setContextMenu(buildTrayMenu([]));
  tray.on('click', () => showStatusWindow());
  tray.on('double-click', () => showStatusWindow());
  refreshTasks();
  setInterval(refreshTasks, 2000);
}

function createStatusWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 760,
    show: !startHidden,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#090d16',
    title: `${APP_TITLE} 설정`,
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
          title: APP_TITLE,
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