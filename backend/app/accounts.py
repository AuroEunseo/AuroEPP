"""관리자 콘솔 계정 DB (업데이트 관제 DB와 분리된 별도 SQLite 파일)

저장 방식
- 파일: <데이터 폴더>/aurora_accounts.db
- 계정 정보 암호화: 아이디·비밀번호 해시·생성자 등은 AES-256-GCM 으로 암호화해 저장
    · 암호화 키: <데이터 폴더>/accounts.key
      Windows 에서는 DPAPI(이 PC 전용, LocalMachine)로 한 번 더 보호 → DB·키 파일을 다른 PC로 복사해도 복호화 불가
    · 아이디 조회용 값: HMAC-SHA256(아이디) — DB에 아이디 원문이 남지 않음
- 비밀번호: PBKDF2-HMAC-SHA256(솔트 16바이트, 310,000회) 해시를 만든 뒤, 그 해시를 다시 암호화해 저장
- 세션: 무작위 토큰을 발급하고 DB에는 SHA-256 해시만 저장 (마지막 사용 후 SESSION_HOURS 동안 유효)
- 권한(role): admin(관리자: 계정 관리 포함 전체) | operator(운영자: 계정 관리 제외 전체)
- 최초 실행 시 admin 계정을 만들고 임시 비밀번호를 initial_admin_password.txt 에 기록
  → 첫 로그인 후 비밀번호를 변경하면 파일은 자동 삭제
- 로그인 5회 연속 실패 시 해당 (계정, IP) 조합을 5분간 잠금

※ 키가 같은 서버 PC에 있으므로, 서버 PC의 관리자 권한을 가진 사람은 복호화할 수 있다.
   이 암호화는 DB 파일·백업이 외부로 유출됐을 때를 대비한 것이다.
"""
import base64
import ctypes
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .database import BASE_DIR
from .settings import SESSION_HOURS

ACCOUNTS_DB = os.path.join(BASE_DIR, "aurora_accounts.db")
KEY_FILE = os.path.join(BASE_DIR, "accounts.key")
INITIAL_PASSWORD_FILE = os.path.join(BASE_DIR, "initial_admin_password.txt")

SCHEMA_VERSION = 2
PBKDF2_ITER = 310_000
MIN_PASSWORD_LEN = 8
MAX_FAILS = 5
LOCK_SEC = 300
ROLES = ("admin", "operator")
ROLE_LABEL = {"admin": "관리자", "operator": "운영자"}
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")

_lock = threading.RLock()
_fail_counter: dict[tuple[str, str], list[float]] = {}
_key_cache: bytes | None = None


# ==========================================================
# 키 관리 (Windows DPAPI 보호)
# ==========================================================
class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DataBlob()
    CRYPTPROTECT_LOCAL_MACHINE = 0x4
    CRYPTPROTECT_UI_FORBIDDEN = 0x1
    flags = CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(blob_in), None, None, None, None, flags, ctypes.byref(blob_out))
    if not ok:
        raise OSError(f"DPAPI {'암호화' if protect else '복호화'} 실패 (오류 {ctypes.GetLastError()})")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _wrap_key(key: bytes) -> bytes:
    if sys.platform == "win32":
        return b"DPAPI1" + _dpapi(key, True)
    return b"PLAIN1" + key  # 개발(비 Windows) 환경용


def _unwrap_key(blob: bytes) -> bytes:
    if blob.startswith(b"DPAPI1"):
        return _dpapi(blob[6:], False)
    if blob.startswith(b"PLAIN1"):
        return blob[6:]
    raise ValueError("알 수 없는 키 파일 형식")


def _master_key() -> bytes:
    global _key_cache
    if _key_cache:
        return _key_cache
    with _lock:
        if os.path.exists(KEY_FILE):
            with open(KEY_FILE, "rb") as f:
                _key_cache = _unwrap_key(f.read())
        else:
            key = secrets.token_bytes(32)
            tmp = KEY_FILE + ".tmp"
            with open(tmp, "wb") as f:
                f.write(_wrap_key(key))
            os.replace(tmp, KEY_FILE)
            _key_cache = key
    return _key_cache


def _enc(field: str, value) -> str:
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    nonce = secrets.token_bytes(12)
    ct = AESGCM(_master_key()).encrypt(nonce, raw, field.encode())
    return base64.b64encode(nonce + ct).decode("ascii")


def _dec(field: str, token: str):
    data = base64.b64decode(token)
    raw = AESGCM(_master_key()).decrypt(data[:12], data[12:], field.encode())
    return json.loads(raw.decode("utf-8"))


def _user_key(username: str) -> str:
    """아이디 조회용 키 (원문 대신 HMAC 저장, 대소문자 구분 없음)"""
    hkey = hashlib.sha256(b"aurora-user-key:" + _master_key()).digest()
    return hmac.new(hkey, (username or "").strip().lower().encode("utf-8"), hashlib.sha256).hexdigest()


def _sha(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _hash_pw(password: str, salt: bytes, iterations: int = PBKDF2_ITER) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


def _make_secret(password: str) -> str:
    salt = secrets.token_bytes(16)
    return _enc("secret", {"pw_hash": _hash_pw(password, salt), "salt": salt.hex(), "iterations": PBKDF2_ITER})


def _check_secret(secret_enc: str, password: str) -> bool:
    try:
        s = _dec("secret", secret_enc)
    except Exception:
        return False
    return hmac.compare_digest(s["pw_hash"], _hash_pw(password or "", bytes.fromhex(s["salt"]), s["iterations"]))


# ==========================================================
# DB 초기화 / 이전 형식(평문 아이디) 이관
# ==========================================================
def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(ACCOUNTS_DB, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA secure_delete=ON")  # 삭제·수정된 데이터가 파일에 남지 않도록 0으로 덮어씀
    return c


def _create_tables(c: sqlite3.Connection) -> None:
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS accounts (
            user_key      TEXT PRIMARY KEY,
            username_enc  TEXT NOT NULL,
            secret_enc    TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'operator',
            must_change   INTEGER NOT NULL DEFAULT 1,
            created_by_enc TEXT,
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash  TEXT PRIMARY KEY,
            user_key    TEXT NOT NULL,
            ip          TEXT,
            created_at  REAL NOT NULL,
            last_used   REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        """
    )


def _migrate_v1(c: sqlite3.Connection) -> None:
    """이전 형식(아이디 평문 + PBKDF2 해시) → 암호화 형식. 기존 비밀번호는 그대로 사용 가능"""
    rows = c.execute("SELECT * FROM accounts").fetchall()
    c.execute("ALTER TABLE accounts RENAME TO accounts_v1")
    c.execute("DROP TABLE IF EXISTS sessions")  # 기존 세션은 폐기 → 다시 로그인
    _create_tables(c)
    for r in rows:
        secret = _enc("secret", {"pw_hash": r["pw_hash"], "salt": r["salt"], "iterations": r["iterations"]})
        c.execute(
            "INSERT INTO accounts(user_key, username_enc, secret_enc, role, must_change, created_by_enc, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (_user_key(r["username"]), _enc("username", r["username"]), secret, "admin",
             int(r["must_change"]), None, r["created_at"], r["updated_at"]),
        )
    c.execute("DROP TABLE accounts_v1")


def init_accounts_db() -> None:
    os.makedirs(BASE_DIR, exist_ok=True)
    _master_key()
    migrated = False
    with _lock, _conn() as c:
        cols = [r[1] for r in c.execute("PRAGMA table_info(accounts)")]
        if cols and "username" in cols:
            _migrate_v1(c)
            migrated = True
        _create_tables(c)
        c.execute("INSERT OR REPLACE INTO meta(k, v) VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
        if c.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0:
            _insert_account(c, "admin", _write_initial_password(), "admin", True, created_by="system")
    if migrated:
        # 이전 형식의 평문 아이디가 빈 페이지에 남지 않도록 파일 재작성
        with _lock:
            c = _conn()
            try:
                c.execute("VACUUM")
            finally:
                c.close()


def _write_initial_password() -> str:
    pw = secrets.token_urlsafe(12)
    with open(INITIAL_PASSWORD_FILE, "w", encoding="utf-8") as f:
        f.write(
            "AURORA Endpoint Control Console 최초 관리자 계정\n"
            "아이디: admin\n"
            f"임시 비밀번호: {pw}\n\n"
            "첫 로그인 후 비밀번호를 변경하면 이 파일은 자동으로 삭제됩니다.\n"
        )
    return pw


def _insert_account(c, username: str, password: str, role: str, must_change: bool, created_by: str = "") -> None:
    now = time.time()
    c.execute(
        "INSERT INTO accounts(user_key, username_enc, secret_enc, role, must_change, created_by_enc, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (_user_key(username), _enc("username", username), _make_secret(password), role,
         1 if must_change else 0, _enc("created_by", created_by) if created_by else None, now, now),
    )


def _get_row(c, username: str):
    return c.execute("SELECT * FROM accounts WHERE user_key=?", (_user_key(username),)).fetchone()


# ==========================================================
# 로그인 / 세션
# ==========================================================
def _is_locked(username: str, ip: str) -> bool:
    now = time.time()
    k = ((username or "").strip().lower(), ip)
    fails = [t for t in _fail_counter.get(k, []) if now - t < LOCK_SEC]
    _fail_counter[k] = fails
    return len(fails) >= MAX_FAILS


def authenticate(username: str, password: str, ip: str) -> tuple[bool, str, bool]:
    """(성공여부, 메시지, 비밀번호 변경 필요 여부)"""
    k = ((username or "").strip().lower(), ip)
    with _lock:
        if _is_locked(username, ip):
            return False, "로그인 실패가 반복되어 5분간 잠겼습니다. 잠시 후 다시 시도하세요.", False
        with _conn() as c:
            row = _get_row(c, username)
        if not row or not _check_secret(row["secret_enc"], password):
            _fail_counter.setdefault(k, []).append(time.time())
            return False, "아이디 또는 비밀번호가 올바르지 않습니다.", False
        _fail_counter.pop(k, None)
        return True, "OK", bool(row["must_change"])


def is_locked_out(username: str, ip: str) -> bool:
    with _lock:
        return _is_locked(username, ip)


def canonical_username(username: str) -> str:
    """로그인 시 입력한 대소문자와 관계없이 저장된 아이디 표기로 반환"""
    with _lock, _conn() as c:
        row = _get_row(c, username)
    return _dec("username", row["username_enc"]) if row else (username or "").strip()


def create_session(username: str, ip: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO sessions(token_hash, user_key, ip, created_at, last_used) VALUES (?,?,?,?,?)",
            (_sha(token), _user_key(username), ip, now, now),
        )
    return token


def get_session_user(token: str) -> dict | None:
    if not token:
        return None
    now = time.time()
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT s.last_used, a.username_enc, a.must_change, a.role FROM sessions s "
            "JOIN accounts a ON a.user_key = s.user_key WHERE s.token_hash=?",
            (_sha(token),),
        ).fetchone()
        if not row:
            return None
        if now - row["last_used"] > SESSION_HOURS * 3600:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (_sha(token),))
            return None
        if now - row["last_used"] > 60:
            c.execute("UPDATE sessions SET last_used=? WHERE token_hash=?", (now, _sha(token)))
        return {
            "username": _dec("username", row["username_enc"]),
            "must_change": bool(row["must_change"]),
            "role": row["role"],
        }


def delete_session(token: str) -> None:
    with _lock, _conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?", (_sha(token or ""),))


def purge_expired_sessions() -> None:
    with _lock, _conn() as c:
        c.execute("DELETE FROM sessions WHERE last_used < ?", (time.time() - SESSION_HOURS * 3600,))


# ==========================================================
# 비밀번호 변경 (본인)
# ==========================================================
def change_password(username: str, old_pw: str, new_pw: str, keep_token: str = "") -> tuple[bool, str]:
    if len(new_pw or "") < MIN_PASSWORD_LEN:
        return False, f"새 비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다."
    if new_pw == old_pw:
        return False, "새 비밀번호가 현재 비밀번호와 같습니다."
    with _lock, _conn() as c:
        row = _get_row(c, username)
        if not row or not _check_secret(row["secret_enc"], old_pw):
            return False, "현재 비밀번호가 올바르지 않습니다."
        c.execute(
            "UPDATE accounts SET secret_enc=?, must_change=0, updated_at=? WHERE user_key=?",
            (_make_secret(new_pw), time.time(), row["user_key"]),
        )
        # 비밀번호 변경 시 현재 세션을 제외한 모든 세션 종료
        c.execute("DELETE FROM sessions WHERE user_key=? AND token_hash<>?", (row["user_key"], _sha(keep_token or "")))
    if username.lower() == "admin" and os.path.exists(INITIAL_PASSWORD_FILE):
        try:
            os.remove(INITIAL_PASSWORD_FILE)
        except OSError:
            pass
    return True, "비밀번호가 변경되었습니다."


# ==========================================================
# 계정 관리 (관리자 권한)
# ==========================================================
def list_accounts() -> list[dict]:
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM accounts ORDER BY created_at").fetchall()
        last_used = {
            r["user_key"]: r["lu"]
            for r in c.execute("SELECT user_key, MAX(last_used) AS lu FROM sessions GROUP BY user_key")
        }
    out = []
    for r in rows:
        out.append({
            "username": _dec("username", r["username_enc"]),
            "role": r["role"],
            "role_label": ROLE_LABEL.get(r["role"], r["role"]),
            "must_change": bool(r["must_change"]),
            "created_by": _dec("created_by", r["created_by_enc"]) if r["created_by_enc"] else "",
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "last_active": last_used.get(r["user_key"]),
        })
    return out


def _admin_count(c) -> int:
    return c.execute("SELECT COUNT(*) FROM accounts WHERE role='admin'").fetchone()[0]


def create_account(username: str, role: str, created_by: str, password: str = "") -> tuple[bool, str, str]:
    """(성공, 메시지, 발급한 임시 비밀번호). password 를 비우면 임시 비밀번호를 발급하고 첫 로그인 시 변경을 강제"""
    username = (username or "").strip()
    if not USERNAME_RE.fullmatch(username):
        return False, "아이디는 영문·숫자·. _ - 조합 3~32자로 입력하세요.", ""
    if role not in ROLES:
        return False, "권한 값이 올바르지 않습니다.", ""
    if password and len(password) < MIN_PASSWORD_LEN:
        return False, f"비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다.", ""
    temp = "" if password else secrets.token_urlsafe(9)
    with _lock, _conn() as c:
        if _get_row(c, username):
            return False, "이미 존재하는 아이디입니다.", ""
        # 관리자가 정한 비밀번호도 첫 로그인 때 본인이 바꾸도록 강제
        _insert_account(c, username, password or temp, role, True, created_by=created_by)
    return True, f"'{username}' 계정을 만들었습니다.", temp


def delete_account(username: str, actor: str) -> tuple[bool, str]:
    if (username or "").strip().lower() == (actor or "").strip().lower():
        return False, "현재 로그인한 본인 계정은 삭제할 수 없습니다."
    with _lock, _conn() as c:
        row = _get_row(c, username)
        if not row:
            return False, "계정을 찾을 수 없습니다."
        if row["role"] == "admin" and _admin_count(c) <= 1:
            return False, "마지막 관리자 계정은 삭제할 수 없습니다."
        c.execute("DELETE FROM sessions WHERE user_key=?", (row["user_key"],))
        c.execute("DELETE FROM accounts WHERE user_key=?", (row["user_key"],))
    return True, f"'{username}' 계정을 삭제했습니다."


def set_role(username: str, role: str, actor: str) -> tuple[bool, str]:
    if role not in ROLES:
        return False, "권한 값이 올바르지 않습니다."
    with _lock, _conn() as c:
        row = _get_row(c, username)
        if not row:
            return False, "계정을 찾을 수 없습니다."
        if row["role"] == "admin" and role != "admin" and _admin_count(c) <= 1:
            return False, "마지막 관리자 계정의 권한은 낮출 수 없습니다."
        if (username or "").strip().lower() == (actor or "").strip().lower() and role != "admin":
            return False, "본인 계정의 관리자 권한은 해제할 수 없습니다."
        c.execute("UPDATE accounts SET role=?, updated_at=? WHERE user_key=?", (role, time.time(), row["user_key"]))
    return True, f"'{username}' 계정 권한을 {ROLE_LABEL[role]}(으)로 변경했습니다."


def admin_reset_password(username: str) -> tuple[bool, str, str]:
    """관리자가 다른 계정의 비밀번호를 초기화 → 임시 비밀번호 발급, 해당 계정의 세션 모두 종료"""
    temp = secrets.token_urlsafe(9)
    with _lock, _conn() as c:
        row = _get_row(c, username)
        if not row:
            return False, "계정을 찾을 수 없습니다.", ""
        c.execute(
            "UPDATE accounts SET secret_enc=?, must_change=1, updated_at=? WHERE user_key=?",
            (_make_secret(temp), time.time(), row["user_key"]),
        )
        c.execute("DELETE FROM sessions WHERE user_key=?", (row["user_key"],))
    return True, f"'{username}' 계정의 비밀번호를 초기화했습니다.", temp


def reset_password(username: str) -> str:
    """비상용(서버 PC에서 관리자 권한으로 실행): 임시 비밀번호를 새로 발급. 계정이 없으면 관리자 계정으로 생성"""
    init_accounts_db()
    with _lock, _conn() as c:
        exists = _get_row(c, username)
    if not exists:
        ok, msg, temp = create_account(username, "admin", "reset-password")
        if not ok:
            raise ValueError(msg)
        return temp
    return admin_reset_password(username)[2]
