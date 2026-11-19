"""관리자 콘솔 계정 DB (업데이트 관제 DB와 분리된 별도 SQLite 파일)

- 파일: <데이터 폴더>/aurora_accounts.db
- 비밀번호: PBKDF2-HMAC-SHA256(솔트 16바이트, 310,000회) 해시만 저장
- 세션: 무작위 토큰을 발급하고 DB에는 SHA-256 해시만 저장 (마지막 사용 후 SESSION_HOURS 동안 유효)
- 최초 실행 시 admin 계정을 만들고 임시 비밀번호를 initial_admin_password.txt 에 기록
  → 첫 로그인 후 비밀번호를 변경하면 파일은 자동 삭제
- 로그인 5회 연속 실패 시 해당 (계정, IP) 조합을 5분간 잠금
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time

from .database import BASE_DIR
from .settings import SESSION_HOURS

ACCOUNTS_DB = os.path.join(BASE_DIR, "aurora_accounts.db")
INITIAL_PASSWORD_FILE = os.path.join(BASE_DIR, "initial_admin_password.txt")

PBKDF2_ITER = 310_000
MIN_PASSWORD_LEN = 8
MAX_FAILS = 5
LOCK_SEC = 300

_lock = threading.Lock()
_fail_counter: dict[tuple[str, str], list[float]] = {}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(ACCOUNTS_DB, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def _hash_pw(password: str, salt: bytes, iterations: int = PBKDF2_ITER) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


def _sha(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def init_accounts_db() -> None:
    os.makedirs(BASE_DIR, exist_ok=True)
    with _lock, _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                username     TEXT PRIMARY KEY,
                pw_hash      TEXT NOT NULL,
                salt         TEXT NOT NULL,
                iterations   INTEGER NOT NULL,
                must_change  INTEGER NOT NULL DEFAULT 1,
                created_at   REAL NOT NULL,
                updated_at   REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash   TEXT PRIMARY KEY,
                username     TEXT NOT NULL,
                ip           TEXT,
                created_at   REAL NOT NULL,
                last_used    REAL NOT NULL
            );
            """
        )
        row = c.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
        if row == 0:
            _create_account(c, "admin", _write_initial_password(), must_change=True)


def _write_initial_password() -> str:
    pw = secrets.token_urlsafe(12)
    with open(INITIAL_PASSWORD_FILE, "w", encoding="utf-8") as f:
        f.write(
            "AURORA Control Console 최초 관리자 계정\n"
            "아이디: admin\n"
            f"임시 비밀번호: {pw}\n\n"
            "첫 로그인 후 비밀번호를 변경하면 이 파일은 자동으로 삭제됩니다.\n"
        )
    return pw


def _create_account(c: sqlite3.Connection, username: str, password: str, must_change: bool) -> None:
    salt = secrets.token_bytes(16)
    now = time.time()
    c.execute(
        "INSERT OR REPLACE INTO accounts(username, pw_hash, salt, iterations, must_change, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (username, _hash_pw(password, salt), salt.hex(), PBKDF2_ITER, 1 if must_change else 0, now, now),
    )


def _is_locked(username: str, ip: str) -> bool:
    now = time.time()
    fails = [t for t in _fail_counter.get((username, ip), []) if now - t < LOCK_SEC]
    _fail_counter[(username, ip)] = fails
    return len(fails) >= MAX_FAILS


def authenticate(username: str, password: str, ip: str) -> tuple[bool, str, bool]:
    """(성공여부, 메시지, 비밀번호 변경 필요 여부)"""
    username = (username or "").strip()
    with _lock:
        if _is_locked(username, ip):
            return False, "로그인 실패가 반복되어 5분간 잠겼습니다. 잠시 후 다시 시도하세요.", False
        with _conn() as c:
            row = c.execute("SELECT * FROM accounts WHERE username=?", (username,)).fetchone()
        ok = bool(row) and hmac.compare_digest(
            row["pw_hash"], _hash_pw(password or "", bytes.fromhex(row["salt"]), row["iterations"])
        )
        if not ok:
            _fail_counter.setdefault((username, ip), []).append(time.time())
            return False, "아이디 또는 비밀번호가 올바르지 않습니다.", False
        _fail_counter.pop((username, ip), None)
        return True, "OK", bool(row["must_change"])


def is_locked_out(username: str, ip: str) -> bool:
    with _lock:
        return _is_locked((username or "").strip(), ip)


def create_session(username: str, ip: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO sessions(token_hash, username, ip, created_at, last_used) VALUES (?,?,?,?,?)",
            (_sha(token), username, ip, now, now),
        )
    return token


def get_session_user(token: str) -> dict | None:
    if not token:
        return None
    now = time.time()
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT s.username, s.last_used, a.must_change FROM sessions s "
            "JOIN accounts a ON a.username = s.username WHERE s.token_hash=?",
            (_sha(token),),
        ).fetchone()
        if not row:
            return None
        if now - row["last_used"] > SESSION_HOURS * 3600:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (_sha(token),))
            return None
        if now - row["last_used"] > 60:
            c.execute("UPDATE sessions SET last_used=? WHERE token_hash=?", (now, _sha(token)))
        return {"username": row["username"], "must_change": bool(row["must_change"])}


def delete_session(token: str) -> None:
    with _lock, _conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?", (_sha(token or ""),))


def change_password(username: str, old_pw: str, new_pw: str, keep_token: str = "") -> tuple[bool, str]:
    if len(new_pw or "") < MIN_PASSWORD_LEN:
        return False, f"새 비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다."
    if new_pw == old_pw:
        return False, "새 비밀번호가 현재 비밀번호와 같습니다."
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM accounts WHERE username=?", (username,)).fetchone()
        if not row or not hmac.compare_digest(
            row["pw_hash"], _hash_pw(old_pw or "", bytes.fromhex(row["salt"]), row["iterations"])
        ):
            return False, "현재 비밀번호가 올바르지 않습니다."
        _create_account(c, username, new_pw, must_change=False)
        c.execute("UPDATE accounts SET created_at=? WHERE username=?", (row["created_at"], username))
        # 비밀번호 변경 시 현재 세션을 제외한 모든 세션 종료
        c.execute(
            "DELETE FROM sessions WHERE username=? AND token_hash<>?", (username, _sha(keep_token or ""))
        )
    if username == "admin" and os.path.exists(INITIAL_PASSWORD_FILE):
        try:
            os.remove(INITIAL_PASSWORD_FILE)
        except OSError:
            pass
    return True, "비밀번호가 변경되었습니다."


def reset_password(username: str) -> str:
    """비상용(서버 PC에서 관리자 권한으로 실행): 임시 비밀번호를 새로 발급"""
    init_accounts_db()
    pw = secrets.token_urlsafe(12)
    with _lock, _conn() as c:
        _create_account(c, username, pw, must_change=True)
        c.execute("DELETE FROM sessions WHERE username=?", (username,))
    return pw


def purge_expired_sessions() -> None:
    with _lock, _conn() as c:
        c.execute("DELETE FROM sessions WHERE last_used < ?", (time.time() - SESSION_HOURS * 3600,))
