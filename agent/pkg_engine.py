"""사내 프로그램 배포 실행 엔진 (에이전트 측)

- 서버 서명 공개키 고정(최초 연결 시 저장, 이후 변경 거부) + 명령 서명 검증
- 설치된 프로그램 목록 수집 ('프로그램 추가/제거' 레지스트리)
- 설치 파일 다운로드(진행률) + SHA-256·크기 검증, 같은 파일은 캐시 재사용
- MSI: msiexec /qn 무인 설치·삭제, EXE: 등록된 무인 옵션으로 실행
- 제한 시간 초과 시 설치 프로세스를 강제 종료 (SYSTEM 권한이라 설치 화면이 보이지 않아 멈출 수 있음)
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from agent_log import get_logger
from config import DATA_DIR

IS_WIN = sys.platform == "win32"
NOWIN = 0x08000000 if IS_WIN else 0
if IS_WIN:
    import winreg

PUBKEY_FILE = os.path.join(DATA_DIR, "server_signing.pub")
CACHE_DIR = os.path.join(DATA_DIR, "packages")
LOG_DIR = os.path.join(DATA_DIR, "logs")
SEEN_FILE = os.path.join(DATA_DIR, "pkg_seen.json")  # 이미 받은 배포 명령 (재전송 방지)
CACHE_KEEP = 5  # 최근 설치 파일 캐시 보관 개수
SEEN_KEEP = 1000
CMD_MAX_AGE = 8 * 86400  # 서버 대기열 보관 기간(7일) + 여유 1일. 이보다 오래된 명령은 재전송으로 보고 거부
SYSTEM_PROFILE_SID = "S-1-5-18"

log = get_logger()

SUCCESS_CODES = {0: "", 3010: "재부팅 후 적용됩니다", 1641: "설치 프로그램이 재부팅을 시작했습니다"}
MSI_ERRORS = {
    1602: "사용자가 설치를 취소함",
    1603: "설치 중 치명적 오류 (상세 내용은 PC의 설치 로그 확인)",
    1605: "설치되어 있지 않은 제품",
    1618: "다른 설치가 진행 중이라 시작하지 못함 (잠시 후 다시 시도)",
    1619: "설치 파일을 열 수 없음",
    1620: "설치 파일 형식이 올바르지 않음",
    1633: "이 PC 플랫폼(32/64비트)을 지원하지 않는 설치 파일",
    1638: "다른 버전이 이미 설치되어 있음",
    1639: "설치 옵션(명령줄)이 올바르지 않음",
}


class PackageError(Exception):
    def __init__(self, msg: str, exit_code: int | None = None):
        super().__init__(msg)
        self.exit_code = exit_code


# ==========================================================
# 서버 서명 공개키 고정 + 명령 검증
# ==========================================================
def pin_pubkey(b64: str) -> None:
    """최초 1회만 저장. 이후 다른 키가 오면 무시하고 경고만 남긴다 (서버 사칭 방지)"""
    if not b64:
        return
    try:
        if os.path.exists(PUBKEY_FILE):
            with open(PUBKEY_FILE, "r", encoding="ascii") as f:
                if f.read().strip() != b64.strip():
                    log.warning("서버 서명 키가 저장된 키와 다릅니다 → 무시 (서버를 새로 설치했다면 이 PC의 %s 삭제 필요)",
                                PUBKEY_FILE)
            return
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(PUBKEY_FILE, "w", encoding="ascii") as f:
            f.write(b64.strip())
        log.info("서버 서명 공개키 저장 (이후 변경 불가)")
    except OSError as e:
        log.warning("서명 공개키 저장 실패: %s", e)


def verify_command(payload: dict, machine_id: str) -> dict:
    """서명 검증에 성공한 경우에만 명령 내용(dict)을 돌려준다"""
    if not os.path.exists(PUBKEY_FILE):
        raise PackageError("서버 서명 공개키가 없어 명령을 검증할 수 없습니다 (에이전트 서비스를 다시 시작하세요)")
    try:
        with open(PUBKEY_FILE, "r", encoding="ascii") as f:
            pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(f.read().strip()))
        blob = base64.b64decode(payload["signed"])
        pub.verify(base64.b64decode(payload["sig"]), blob)
    except (InvalidSignature, KeyError, ValueError) as e:
        raise PackageError(f"서명 검증 실패 — 위조되었거나 다른 서버가 보낸 명령이라 실행하지 않음 ({type(e).__name__})")
    body = json.loads(blob.decode("utf-8"))
    if body.get("v") != 1 or body.get("action") not in ("install", "uninstall"):
        raise PackageError("지원하지 않는 명령 형식")
    if body.get("machine_id") != machine_id:
        raise PackageError("다른 PC 대상 명령이라 실행하지 않음")
    return body


def _seen_key(body: dict) -> str:
    return f"{body.get('deployment_id')}:{body.get('issued_at')}"


def check_and_mark_fresh(body: dict) -> None:
    """같은 명령을 다시 보내는 재전송 공격 방지: 오래된 명령·이미 받은 명령은 거부하고, 통과하면 기록"""
    issued = float(body.get("issued_at") or 0)
    if not issued or time.time() - issued > CMD_MAX_AGE:
        raise PackageError("발행된 지 너무 오래된 명령이라 실행하지 않음 (재전송 의심)")
    key = _seen_key(body)
    try:
        with open(SEEN_FILE, "r", encoding="utf-8") as f:
            seen = json.load(f)
        if not isinstance(seen, list):
            seen = []
    except (OSError, ValueError):
        seen = []
    if key in seen:
        raise PackageError("이미 받은 명령이 다시 들어와 실행하지 않음 (재전송 의심)")
    seen = (seen + [key])[-SEEN_KEEP:]
    tmp = SEEN_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(seen, f)
        os.replace(tmp, SEEN_FILE)
    except OSError as e:
        log.warning("배포 명령 기록 저장 실패: %s", e)


# ==========================================================
# 설치된 프로그램 목록
# ==========================================================
UNINSTALL_KEYS = (
    (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", 0x0100),  # 64비트 보기
    (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", 0x0200),  # 32비트 보기
)


def _uninstall_roots(include_system_profile: bool):
    """(루트, 경로, 보기, 범위) — 범위 'machine' = PC 전체, 'system_profile' = SYSTEM 계정 전용 설치"""
    for path, view in UNINSTALL_KEYS:
        yield winreg.HKEY_LOCAL_MACHINE, path, view, "machine"
    if include_system_profile:
        # 사용자별(per-user) 설치 프로그램을 SYSTEM 권한으로 설치하면 SYSTEM 계정 영역에만 등록된다
        yield winreg.HKEY_USERS, SYSTEM_PROFILE_SID + "\\" + UNINSTALL_KEYS[0][0], 0, "system_profile"


def collect_software(include_system_profile: bool = False) -> list[dict]:
    """[{name, version, publisher, uninstall, quiet_uninstall, product_code, scope}] (시스템 구성요소 제외)"""
    if not IS_WIN:
        return []
    out, seen = [], set()
    for hive, path, view, scope in _uninstall_roots(include_system_profile):
        try:
            root = winreg.OpenKey(hive, path, 0, winreg.KEY_READ | view)
        except OSError:
            continue
        with root:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(root, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(root, sub) as k:
                        def val(n, default=""):
                            try:
                                return winreg.QueryValueEx(k, n)[0]
                            except OSError:
                                return default
                        name = str(val("DisplayName")).strip()
                        if not name or val("SystemComponent", 0) == 1 or val("ParentKeyName"):
                            continue
                        version = str(val("DisplayVersion")).strip()
                        if (name, version, scope) in seen:
                            continue
                        seen.add((name, version, scope))
                        out.append({
                            "name": name, "version": version, "publisher": str(val("Publisher")).strip(),
                            "uninstall": str(val("UninstallString")).strip(),
                            "quiet_uninstall": str(val("QuietUninstallString")).strip(),
                            "product_code": sub if re.fullmatch(r"\{[0-9A-Fa-f-]{36}\}", sub) and val("WindowsInstaller", 0) == 1 else "",
                            "scope": scope,
                        })
                except OSError:
                    continue
    out.sort(key=lambda x: x["name"].lower())
    return out


def public_software(items: list[dict]) -> list[dict]:
    """서버로 보낼 때는 이름·버전·게시자만"""
    return [{"name": s["name"], "version": s["version"], "publisher": s["publisher"]} for s in items]


def find_installed(detect_name: str, include_system_profile: bool = False) -> dict | None:
    """PC 전체 설치를 먼저 찾고, 없으면 (요청 시) SYSTEM 계정 전용 설치도 찾는다"""
    key = (detect_name or "").strip().lower()
    if not key:
        return None
    items = [s for s in collect_software(include_system_profile) if key in s["name"].lower()]
    return next((s for s in items if s["scope"] == "machine"), None) or (items[0] if items else None)


SYSTEM_PROFILE_HINT = (
    "PC 전체가 아니라 SYSTEM 계정 전용으로 설치되어 사용자에게 보이지 않습니다. "
    "사용자별 설치 프로그램입니다 — 설치 인자에 '/allusers'(Electron·NSIS) 등 모든 사용자용 옵션을 추가하거나 "
    "PC 전체 설치용 설치 파일을 사용하세요"
)


# ==========================================================
# 다운로드
# ==========================================================
def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(server_url: str, ident: dict, body: dict, on_progress) -> str:
    folder = os.path.join(CACHE_DIR, body["sha256"])
    safe_name = re.sub(r'[\\/:*?"<>|]', "_", body["filename"])[:200]
    path = os.path.join(folder, safe_name)
    if os.path.exists(path) and os.path.getsize(path) == body["size"] and _sha256(path) == body["sha256"]:
        on_progress(100, "캐시된 설치 파일 사용")
        return path
    os.makedirs(folder, exist_ok=True)
    url = f"{server_url}/api/agent/packages/{body['package_id']}/file"
    last_err = None
    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(url, headers={"X-Machine-ID": ident["machine_id"], "X-Agent-Token": ident["agent_token"]})
            h = hashlib.sha256()
            got, last_pct = 0, -1
            tmp = path + ".part"
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 256)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    got += len(chunk)
                    pct = int(got * 100 / max(1, body["size"]))
                    if pct >= last_pct + 2:
                        last_pct = pct
                        on_progress(min(pct, 100), f"{got / 1048576:.1f} / {body['size'] / 1048576:.1f} MB")
            if got != body["size"] or h.hexdigest() != body["sha256"]:
                os.remove(tmp)
                raise PackageError("받은 파일이 서버에 등록된 파일과 다릅니다 (크기 또는 SHA-256 불일치) — 실행하지 않음")
            os.replace(tmp, path)
            _trim_cache()
            return path
        except PackageError:
            raise
        except Exception as e:
            last_err = e
            log.warning("설치 파일 다운로드 실패 (%d/3): %s", attempt, e)
            time.sleep(3 * attempt)
    raise PackageError(f"설치 파일 다운로드 실패: {last_err}")


def _trim_cache():
    try:
        dirs = sorted((os.path.join(CACHE_DIR, d) for d in os.listdir(CACHE_DIR)), key=os.path.getmtime)
        for d in dirs[:-CACHE_KEEP]:
            shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass


# ==========================================================
# 실행 (설치·삭제)
# ==========================================================
def _run(cmdline: str, timeout_min: int) -> int:
    log.info("실행: %s", cmdline)
    proc = subprocess.Popen(cmdline, creationflags=NOWIN, shell=False)
    try:
        return proc.wait(timeout=timeout_min * 60)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, creationflags=NOWIN)
        raise PackageError(
            f"{timeout_min}분 안에 끝나지 않아 강제 종료했습니다. 무인 설치 옵션이 맞는지 확인하세요 "
            "(옵션이 없으면 설치 화면이 보이지 않는 곳에서 입력을 기다리며 멈춥니다)"
        )


def _result(code: int, action: str) -> str:
    if code in SUCCESS_CODES:
        return SUCCESS_CODES[code]
    if action == "uninstall" and code == 1605:
        return "이미 설치되어 있지 않음"
    raise PackageError(MSI_ERRORS.get(code, f"종료 코드 {code}"), exit_code=code)


def install(path: str, body: dict) -> tuple[int, str]:
    os.makedirs(LOG_DIR, exist_ok=True)
    args = (body.get("install_args") or "").strip()
    if body["kind"] == "msi":
        msi_log = os.path.join(LOG_DIR, f"msi_{body['deployment_id']}.log")
        cmd = f'msiexec.exe /i "{path}" /qn /norestart /l*v "{msi_log}" {args}'.strip()
    else:
        cmd = f'"{path}" {args}'.strip()
    # 실행 직전에 한 번 더 확인 (다운로드·캐시 확인 이후 파일이 바뀌지 않았는지)
    if not os.path.exists(path) or _sha256(path) != body["sha256"]:
        raise PackageError("실행 직전 설치 파일 확인 실패 (SHA-256 불일치) — 실행하지 않음")
    code = _run(cmd, int(body.get("timeout_min") or 30))
    return code, _result(code, "install")


def uninstall(body: dict) -> tuple[int, str]:
    timeout = int(body.get("timeout_min") or 30)
    if (body.get("uninstall_cmd") or "").strip():
        code = _run(body["uninstall_cmd"].strip(), timeout)
        return code, _result(code, "uninstall")
    entry = find_installed(body.get("detect_name") or body.get("name"), include_system_profile=True)
    if not entry:
        return 0, "설치되어 있지 않음 (삭제할 항목 없음)"
    if entry["product_code"]:
        cmd = f"msiexec.exe /x {entry['product_code']} /qn /norestart"
    elif entry["quiet_uninstall"]:
        cmd = entry["quiet_uninstall"]
    elif re.search(r"msiexec", entry["uninstall"], re.I):
        cmd = re.sub(r"/I", "/X", entry["uninstall"], flags=re.I) + " /qn /norestart"
    elif entry["uninstall"]:
        raise PackageError(
            "이 프로그램은 무인 삭제 방법을 알 수 없습니다. 콘솔의 프로그램 정보에 '삭제 명령'(무인 옵션 포함)을 입력하세요"
        )
    else:
        raise PackageError("삭제 정보가 없는 프로그램입니다")
    code = _run(cmd, timeout)
    return code, _result(code, "uninstall")
