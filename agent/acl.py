"""에이전트 데이터 폴더(C:\\ProgramData\\AURORA) 권한 보강

ProgramData 기본 권한은 일반 사용자도 하위에 폴더·파일을 새로 만들 수 있고, 직접 만든 항목은
그 사용자가 소유자(전체 권한)가 된다. 에이전트는 이 폴더의 설치 파일을 SYSTEM 권한으로 실행하므로
일반 사용자가 폴더를 먼저 만들어 두면 설치 파일 바꿔치기·서명 공개키 심기가 가능해진다.

서비스(SYSTEM)가 시작할 때마다 아래를 수행한다.
  1) 관리자/SYSTEM/TrustedInstaller 가 아닌 사용자가 만든 항목을 찾아 기록 (서명 공개키는 삭제 → 재고정)
  2) 소유자를 Administrators 로 변경
  3) SYSTEM·Administrators 만 전체 권한, 상속 끊기, 하위 항목은 이 권한을 상속하도록 초기화
  4) 쓰기 확인에 실패하면 원래(ProgramData 기본) 권한으로 되돌린다
"""
import os
import subprocess
import sys

from agent_log import get_logger
from config import DATA_DIR

log = get_logger()

IS_WIN = sys.platform == "win32"
NOWIN = 0x08000000 if IS_WIN else 0
TRUSTED_OWNERS = {
    "S-1-5-18",  # SYSTEM
    "S-1-5-32-544",  # Administrators
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",  # TrustedInstaller
}
PUBKEY_NAME = "server_signing.pub"
ADMINS = "*S-1-5-32-544"
# 같은 PC에 관제 서버가 있으면 AURORA\Server 는 서버가 따로 관리하므로 건드리지 않는다
SKIP_CHILDREN = {"server"}

# 서비스 시작 시 발견한 경고 (워커가 첫 체크인 때 콘솔로 보고)
LAST_WARNINGS: list[str] = []


def _icacls(*args) -> tuple[int, str]:
    try:
        r = subprocess.run(["icacls", *args], capture_output=True, text=True, timeout=120, creationflags=NOWIN)
        return r.returncode, (r.stdout or r.stderr or "").strip()
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def _owner_sid(path: str) -> str:
    import win32security

    sd = win32security.GetFileSecurity(path, win32security.OWNER_SECURITY_INFORMATION)
    return win32security.ConvertSidToStringSid(sd.GetSecurityDescriptorOwner())


def _foreign_owned(root: str, limit: int = 50) -> list[str]:
    """관리자·SYSTEM 이 아닌 계정이 소유한 항목 (폴더 자신 포함)"""
    found = []
    try:
        candidates = [root]
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath == root:
                dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_CHILDREN]
            candidates += [os.path.join(dirpath, n) for n in dirnames + filenames]
            if len(candidates) > 5000:
                break
        for p in candidates:
            try:
                if _owner_sid(p) not in TRUSTED_OWNERS:
                    found.append(p)
                    if len(found) >= limit:
                        break
            except Exception:  # noqa: BLE001
                continue
    except Exception as e:  # noqa: BLE001
        log.warning("데이터 폴더 소유자 확인 실패: %s", e)
    return found


def _probe() -> bool:
    probe = os.path.join(DATA_DIR, ".acl_probe")
    try:
        with open(probe, "w", encoding="ascii") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def harden_data_dir() -> list[str]:
    """권한 보강 후 경고 목록을 돌려준다 (Windows 서비스에서만 동작)"""
    LAST_WARNINGS.clear()
    if not IS_WIN:
        return []
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError as e:
        log.warning("데이터 폴더 생성 실패: %s", e)
        return []

    foreign = _foreign_owned(DATA_DIR)
    if foreign:
        rel = [os.path.relpath(p, DATA_DIR) if p != DATA_DIR else "(폴더 자체)" for p in foreign]
        msg = (f"에이전트 데이터 폴더에서 일반 사용자가 만든 항목 {len(foreign)}개 발견 → 권한 초기화: "
               + ", ".join(rel[:10]) + (" ..." if len(rel) > 10 else ""))
        log.warning(msg)
        LAST_WARNINGS.append(msg)
        pub = os.path.join(DATA_DIR, PUBKEY_NAME)
        planted_pub = pub in foreign or DATA_DIR in foreign
        if planted_pub and os.path.exists(pub):
            try:
                os.remove(pub)
                note = "서명 공개키가 신뢰할 수 없는 상태라 삭제함 (다음 체크인 때 서버에서 다시 받아 고정)"
                log.warning(note)
                LAST_WARNINGS.append(note)
            except OSError as e:
                log.warning("의심 공개키 삭제 실패: %s", e)
        cfg = os.path.join(DATA_DIR, "agent_config.json")
        if cfg in foreign or DATA_DIR in foreign:
            LAST_WARNINGS.append("서버 주소 설정 파일(agent_config.json)도 일반 사용자가 만든 것일 수 있습니다. "
                                 "이 PC의 에이전트 설정 창에서 관제 서버 주소를 확인하세요.")

    try:
        children = [os.path.join(DATA_DIR, n) for n in os.listdir(DATA_DIR) if n.lower() not in SKIP_CHILDREN]
    except OSError:
        children = []
    steps = [(DATA_DIR, "/setowner", ADMINS, "/C", "/Q")]
    steps += [(c, "/setowner", ADMINS, "/T", "/C", "/Q") for c in children]
    steps += [
        (DATA_DIR, "/grant:r", "*S-1-5-18:(OI)(CI)F", "/grant:r", f"{ADMINS}:(OI)(CI)F", "/C", "/Q"),
        (DATA_DIR, "/inheritance:r", "/C", "/Q"),
    ]
    steps += [(c, "/reset", "/T", "/C", "/Q") for c in children]
    for args in steps:
        code, out = _icacls(*args)
        if code not in (0, 1):  # 1 = 일부 항목 실패(/C 로 계속 진행)
            log.warning("권한 설정 실패 (icacls %s): %s", " ".join(args[1:3]), out[:200])

    if not _probe():
        log.warning("권한 보강 후 쓰기 확인 실패 → 기본 권한으로 되돌림")
        _icacls(DATA_DIR, "/reset", "/C", "/Q")
        for c in children:
            _icacls(c, "/reset", "/T", "/C", "/Q")
        LAST_WARNINGS.append("데이터 폴더 권한 보강에 실패해 기본 권한으로 되돌렸습니다 (에이전트 로그 확인)")
    else:
        log.info("데이터 폴더 권한 확인 완료 (SYSTEM·Administrators 전용)")
    return list(LAST_WARNINGS)
