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

STATE_DIR = r"C:\ProgramData\AURORA" if IS_WIN else os.path.expanduser("~/.aurora")
IDENTITY_FILE = os.path.join(STATE_DIR, "identity.json")


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


def get_or_create_identity(force_new_token: bool = False) -> dict:
    """로컬에 저장된 토큰이 없으면 자체 발급하여 저장"""
    os.makedirs(STATE_DIR, exist_ok=True)
    if not force_new_token and os.path.exists(IDENTITY_FILE):
        try:
            with open(IDENTITY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("machine_id") and data.get("agent_token"):
                    return data
        except Exception:
            pass

    ident = {
        "machine_id": get_machine_id(),
        "agent_token": secrets.token_urlsafe(32),
    }
    with open(IDENTITY_FILE, "w", encoding="utf-8") as f:
        json.dump(ident, f, indent=2)
    return ident


def wait_for_approval(server_url: str, agent_ver: str = "1.0", stop_event=None, wait_fn=None) -> dict:
    """서버에 토큰·PC이름·OS버전을 등록하고 콘솔 관리자가 승인할 때까지 대기

    wait_fn: 대기 함수(초 단위). 지정 시 서비스 중지/즉시 동기화 요청에 바로 반응한다.
    """
    sleep = wait_fn or time.sleep
    ident = get_or_create_identity()

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
                f"{server_url}/api/agents/register",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                if res.get("status") == "active":
                    return ident
        except urllib.error.HTTPError as e:
            if e.code == 403:
                # 거부된 경우 60초 후 재시도
                sleep(60)
                continue
        except Exception:
            pass

        sleep(15)