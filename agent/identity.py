import json
import os
import platform
import secrets
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid

IS_WIN = sys.platform == "win32"
if IS_WIN:
    import winreg

from config import DATA_DIR as STATE_DIR  # noqa: E402  (서비스·트레이와 같은 데이터 폴더)
from agent_log import get_logger  # noqa: E402

IDENTITY_FILE = os.path.join(STATE_DIR, "identity.json")
IDENTITY_BACKUP = IDENTITY_FILE + ".bak"
log = get_logger()


def _reg_read(path: str, name: str):
    if not IS_WIN:
        return None
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY
        ) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def get_machine_id() -> str:
    guid = _reg_read(r"SOFTWARE\Microsoft\Cryptography", "MachineGuid")
    return guid or str(uuid.uuid5(uuid.NAMESPACE_DNS, socket.gethostname()))


def get_os_info() -> tuple[str, str]:
    """(운영체제 에디션명, 상세 빌드 버전) 반환"""
    if not IS_WIN:
        return f"{platform.system()} {platform.release()}", platform.version()

    cv = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    prod_name = _reg_read(cv, "ProductName") or "Windows"
    build_num = int(_reg_read(cv, "CurrentBuildNumber") or 0)
    ubr = _reg_read(cv, "UBR") or 0
    disp_ver = _reg_read(cv, "DisplayVersion") or ""

    # Windows 11(빌드 22000 이상)인데 레지스트리에 Windows 10으로 표기되는 MS 특성 보정
    if build_num >= 22000 and "Windows 10" in prod_name:
        prod_name = prod_name.replace("Windows 10", "Windows 11")

    build_str = f"{disp_ver} ({build_num}.{ubr})".strip()
    return prod_name, build_str


def _read_identity(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("machine_id") and data.get("agent_token"):
            return data
    except (OSError, ValueError):
        pass
    return None


def _write_identity(ident: dict) -> None:
    """원자적 저장: 임시 파일에 쓴 뒤 교체 + 백업 사본 유지
    (전원이 갑자기 꺼져 파일이 깨져도 토큰을 잃지 않도록 → 재승인 없이 재연결)"""
    tmp = IDENTITY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ident, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, IDENTITY_FILE)
    try:
        with open(IDENTITY_BACKUP, "w", encoding="utf-8") as f:
            json.dump(ident, f, indent=2)
    except OSError:
        pass


def get_or_create_identity(force_new_token: bool = False) -> dict:
    """로컬에 저장된 토큰이 없을 때만 자체 발급 (force_new_token: 서버가 토큰 불일치(401)를 알린 경우)"""
    os.makedirs(STATE_DIR, exist_ok=True)
    if not force_new_token:
        data = _read_identity(IDENTITY_FILE)
        if data:
            return data
        data = _read_identity(IDENTITY_BACKUP)
        if data:
            log.warning("identity.json 손상/누락 → 백업에서 복구 (기존 토큰 유지)")
            _write_identity(data)
            return data

    ident = {
        "machine_id": get_machine_id(),
        "agent_token": secrets.token_urlsafe(32),
    }
    _write_identity(ident)
    log.warning("새 에이전트 토큰 발급 (%s) → 콘솔에서 재승인 필요", "서버 요청" if force_new_token else "최초 실행")
    return ident


def wait_for_approval(server_url, agent_ver: str = "1.0", stop_event=None, wait_fn=None) -> dict:
    """서버에 토큰·PC이름·OS버전을 등록하고 콘솔 관리자가 승인할 때까지 대기

    server_url: 주소 문자열 또는 주소를 돌려주는 함수(설정 변경을 매 요청마다 반영)
    wait_fn: 대기 함수(초 단위). 지정 시 서비스 중지/즉시 동기화 요청에 바로 반응한다.
    """
    sleep = wait_fn or time.sleep
    ident = get_or_create_identity()
    net_backoff = 2  # 부팅 직후 네트워크가 늦게 올라오는 경우를 위해 짧게 시작해 15초까지 늘림
    last_state = None

    while True:
        if stop_event and stop_event.is_set():
            raise SystemExit(0)

        os_name, os_build = get_os_info()
        payload = {
            "machine_id": ident["machine_id"],
            "hostname": socket.gethostname(),
            "os_name": os_name,
            "os_build": os_build,
            "agent_token": ident["agent_token"],
            "agent_ver": agent_ver,
        }

        try:
            req = urllib.request.Request(
                f"{server_url() if callable(server_url) else server_url}/api/agents/register",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                res = json.loads(resp.read().decode("utf-8"))
            net_backoff = 2
            status = res.get("status")
            if status != last_state:
                log.info("등록 상태: %s", status)
                last_state = status
            if status == "active":
                return ident
        except urllib.error.HTTPError as e:
            net_backoff = 2
            if e.code == 403:
                if last_state != "rejected":
                    log.warning("등록 거부 상태 (콘솔에서 거부 해제 필요)")
                    last_state = "rejected"
                # 거부된 경우 30초 후 재시도 (콘솔에서 거부 해제 시 30초 이내 '응답 확인됨' 표시)
                sleep(30)
                continue
            log.warning("등록 요청 실패: HTTP %s", e.code)
        except Exception as e:
            log.warning("서버 연결 실패 (%ss 후 재시도): %s", net_backoff, e)
            sleep(net_backoff)
            net_backoff = min(net_backoff * 2, 15)
            continue

        sleep(15)