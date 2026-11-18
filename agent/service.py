import json
import os
import sys
import threading
import time
import urllib.request

# PyInstaller 패키징 및 Windows 서비스(System32 CWD) 환경에서 worker 모듈 경로 보장
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
if EXE_DIR not in sys.path:
    sys.path.insert(0, EXE_DIR)
    
import worker


if sys.platform == "win32":
    import servicemanager
    import win32event
    import win32service
    import win32serviceutil

from worker import AgentWorker

DATA_DIR = os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"), "AURORA")
CONFIG_FILE = os.path.join(DATA_DIR, "agent_config.json")
IDENTITY_FILE = os.path.join(DATA_DIR, "identity.json")


def load_server_base_url() -> str:
    """agent_config.json에서 관리자가 입력한 서버 IP와 포트를 읽어 URL 반환"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                ip = str(cfg.get("server_ip", "")).strip()
                port = int(cfg.get("server_port", 8080))
                if ip:
                    return f"http://{ip}:{port}"
                if cfg.get("server_url"):
                    return str(cfg["server_url"]).rstrip("/")
        except Exception:
            pass
    return "http://127.0.0.1:8080"


def load_identity() -> dict:
    if os.path.exists(IDENTITY_FILE):
        try:
            with open(IDENTITY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


class RealtimeAgentRunner:
    """기존 AgentWorker에 실시간 SSE 푸시 채널과 동적 서버 IP/포트 설정을 결합하는 실행기"""

    def __init__(self, stop_event: threading.Event):
        self.stop_event = stop_event
        self.sync_lock = threading.Lock()
        self.worker = AgentWorker(stop_event)

    def _apply_dynamic_server_url(self):
        base_url = load_server_base_url()
        for attr in ("server_url", "base_url", "api_url"):
            if hasattr(self.worker, attr):
                setattr(self.worker, attr, base_url)
        if hasattr(self.worker, "config") and isinstance(self.worker.config, dict):
            self.worker.config["server_url"] = base_url

    def trigger_immediate_sync(self):
        """실시간 푸시 수신 시 대기 없이 즉시 정책/명령 동기화 실행"""
        if not self.sync_lock.acquire(blocking=False):
            return
        try:
            self._apply_dynamic_server_url()
            for method_name in ("sync_once", "step", "tick", "poll"):
                fn = getattr(self.worker, method_name, None)
                if callable(fn):
                    fn()
                    return
        except Exception:
            pass
        finally:
            self.sync_lock.release()

    def _sse_listener_loop(self):
        """승인 후 관제 서버와 상시 SSE 스트림을 유지하며 정책/명령 하달 즉시 반영"""
        while not self.stop_event.is_set():
            identity = load_identity()
            machine_id = identity.get("machine_id")
            agent_token = identity.get("agent_token")

            if not machine_id or not agent_token:
                self.stop_event.wait(2.0)
                continue

            base_url = load_server_base_url()
            stream_url = f"{base_url}/api/agent/stream?machine_id={machine_id}"
            req = urllib.request.Request(
                stream_url,
                headers={
                    "X-Agent-Token": agent_token,
                    "Accept": "text/event-stream",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    for raw_line in resp:
                        if self.stop_event.is_set():
                            break
                        line = raw_line.decode("utf-8", errors="ignore").strip()
                        if line.startswith("data:"):
                            self.trigger_immediate_sync()
            except Exception:
                # 승인 대기 중(401)이거나 네트워크 단절 시 3초 후 자동 재연결
                self.stop_event.wait(3.0)

    def run(self):
        self._apply_dynamic_server_url()
        sse_thread = threading.Thread(target=self._sse_listener_loop, daemon=True)
        sse_thread.start()
        self.worker.run()


class AuroraAgentService(win32serviceutil.ServiceFramework):
    _svc_name_ = "AuroraUpdateAgent"
    _svc_display_name_ = "AURORA Update Control Agent"
    _svc_description_ = "중앙 정책 및 Windows 업데이트 제어 에이전트 서비스"

    def __init__(self, args):
        super().__init__(args)
        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        self.stop_event = threading.Event()

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        self.stop_event.set()
        win32event.SetEvent(self.hWaitStop)

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, ""),
        )
        runner = RealtimeAgentRunner(self.stop_event)
        runner.run()


def quick_install_and_start():
    """exe를 인자 없이 실행(더블클릭/무인배포)했을 때 서비스 자동 등록 및 가동"""
    exe_path = sys.executable
    try:
        win32serviceutil.InstallService(
            None,
            AuroraAgentService._svc_name_,
            AuroraAgentService._svc_display_name_,
            startType=win32service.SERVICE_AUTO_START,
            exeName=exe_path,
            description=AuroraAgentService._svc_description_,
        )
        print("[OK] Windows 서비스 등록 완료 (자동 시작)")
    except Exception as e:
        if "1073" in str(e):
            print("[INFO] 이미 서비스가 등록되어 있습니다.")
        else:
            print(f"[ERR] 서비스 등록 실패 (관리자 권한으로 실행하세요): {e}")
            return

    try:
        win32serviceutil.StartService(AuroraAgentService._svc_name_)
        print("[OK] AURORA 에이전트 서비스가 시작되었습니다.")
    except Exception as e:
        print(f"[INFO] 서비스 시작 상태: {e}")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        try:
            servicemanager.Initialize()
            servicemanager.PrepareToHostSingle(AuroraAgentService)
            servicemanager.StartServiceCtrlDispatcher()
        except Exception:
            quick_install_and_start()
    elif "--console" in sys.argv:
        print("AURORA Agent 포그라운드 테스트 모드 실행 (Ctrl+C 종료)")
        ev = threading.Event()
        try:
            RealtimeAgentRunner(ev).run()
        except KeyboardInterrupt:
            ev.set()
    else:
        win32serviceutil.HandleCommandLine(AuroraAgentService)