import json
import os
import sys
import threading
import time
import urllib.parse
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

from agent_log import get_logger
from config import DATA_DIR, load_server_url  # 서버 주소 단일 설정 지점 (agent_config.json)

log = get_logger()
SERVICE_NAME = "AuroraUpdateAgent"

IDENTITY_FILE = os.path.join(DATA_DIR, "identity.json")


def load_identity() -> dict:
    if os.path.exists(IDENTITY_FILE):
        try:
            with open(IDENTITY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


class RealtimeAgentRunner:
    """AgentWorker에 실시간 SSE 푸시 채널을 결합하는 실행기"""

    def __init__(self, stop_event: threading.Event):
        self.stop_event = stop_event
        self.worker = AgentWorker(stop_event)

    def trigger_immediate_sync(self):
        """실시간 푸시 수신 시 대기 없이 즉시 정책/명령 동기화 요청.

        실제 체크인은 AgentWorker 메인 루프가 수행하고, 여기서는 대기만 깨운다.
        (여러 푸시가 몰려와도 체크인은 한 번으로 합쳐짐)
        """
        try:
            self.worker.sync_once()
        except Exception:
            pass

    def _sse_listener_loop(self):
        """승인 후 관제 서버와 상시 SSE 스트림을 유지하며 정책/명령 하달 즉시 반영"""
        backoff = 3.0
        while not self.stop_event.is_set():
            identity = load_identity()
            machine_id = identity.get("machine_id")
            agent_token = identity.get("agent_token")

            # 승인 전에는 스트림이 401로 거부되므로 연결 시도 자체를 하지 않음
            if not machine_id or not agent_token or not getattr(self.worker, "approved", False):
                self.stop_event.wait(5.0)
                continue

            base_url = load_server_url()
            stream_url = f"{base_url}/api/agent/stream?machine_id={urllib.parse.quote(machine_id)}"
            req = urllib.request.Request(
                stream_url,
                headers={
                    "X-Agent-Token": agent_token,
                    "Accept": "text/event-stream",
                },
            )
            try:
                # 서버는 20초마다 keepalive를 보내므로 60초 무응답 시 끊긴 것으로 판단
                with urllib.request.urlopen(req, timeout=60) as resp:
                    if backoff > 3.0:
                        log.info("실시간 알림 채널 재연결")
                    backoff = 3.0
                    for raw_line in resp:
                        if self.stop_event.is_set():
                            break
                        line = raw_line.decode("utf-8", errors="ignore").strip()
                        # 'connected' 포함 모든 data 이벤트에서 동기화 요청
                        # (연결이 끊겨 있던 동안 놓친 변경분을 따라잡기 위함, ': keepalive'는 무시)
                        if line.startswith("data:"):
                            self.trigger_immediate_sync()
                # 서버가 채널을 닫음(토큰 폐기·삭제·거부 등) → 바로 체크인해 상태 변화를 확인
                self.trigger_immediate_sync()
            except Exception as e:
                if backoff == 3.0:
                    log.info("실시간 알림 채널 끊김: %s", e)
            # 단절/거부 시 지수 백오프(3s → 최대 60s)로 재연결, 서버 폭주 방지
            self.stop_event.wait(backoff)
            backoff = min(backoff * 2, 60.0)

    def run(self):
        sse_thread = threading.Thread(target=self._sse_listener_loop, daemon=True)
        sse_thread.start()
        self.worker.run()


class AuroraAgentService(win32serviceutil.ServiceFramework):
    _svc_name_ = "AuroraUpdateAgent"
    _svc_display_name_ = "AURORA Endpoint Agent"
    _svc_description_ = "중앙 정책 및 Windows 업데이트 제어 에이전트 서비스"

    def __init__(self, args):
        super().__init__(args)
        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        self.stop_event = threading.Event()

    def SvcStop(self):
        log.info("Windows 서비스 중지 요청")
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        self.stop_event.set()
        win32event.SetEvent(self.hWaitStop)

    def SvcDoRun(self):
        log.info("Windows 서비스 시작")
        ensure_service_recovery()
        try:
            import acl

            acl.harden_data_dir()  # 데이터 폴더를 SYSTEM·Administrators 전용으로 (설치 파일 바꿔치기 방지)
        except Exception as e:  # noqa: BLE001
            log.warning("데이터 폴더 권한 점검 실패: %s", e)
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, ""),
        )
        runner = RealtimeAgentRunner(self.stop_event)
        runner.run()


def ensure_service_recovery():
    """부팅 시 자동 시작 + 비정상 종료 시 자동 재시작을 서비스 스스로 보장

    설치 방식(설치 파일/수동 install/더블클릭)과 관계없이, 서비스가 한 번이라도 실행되면
    다음 부팅부터 자동 시작되도록 설정을 바로잡는다. (SYSTEM 권한으로 실행되므로 변경 가능)
    """
    if sys.platform != "win32":
        return
    import subprocess

    for args in (
        ["sc", "config", SERVICE_NAME, "start=", "auto"],
        ["sc", "failure", SERVICE_NAME, "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/30000"],
        ["sc", "failureflag", SERVICE_NAME, "1"],
    ):
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=15, creationflags=0x08000000)
            if r.returncode != 0:
                log.warning("서비스 설정 실패 %s: %s", " ".join(args[:2]), (r.stdout or r.stderr).strip()[:200])
        except Exception as e:
            log.warning("서비스 설정 실패 %s: %s", " ".join(args[:2]), e)


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