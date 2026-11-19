"""시작 시 DB 백업 → 스키마 비교 → 새 구조로 테이블 재생성 + 기존 데이터 복사

- 서버가 켜지면 백그라운드 스레드에서 실행되고, 진행 상황은 STATUS 로 노출된다.
  (콘솔은 로그인 직후 /api/system/status 를 조회해 로딩 화면에 단계 메시지를 보여준다)
- 완료 전까지 에이전트/관리 API는 503(준비 중)을 반환하며, 에이전트는 자동으로 재시도한다.
- SQLite 권장 절차(새 테이블 생성 → 데이터 복사 → 기존 테이블 삭제 → 이름 변경)를 따른다.
"""
import datetime
import glob
import os
import sqlite3
import threading
import time

from sqlalchemy import inspect, text
from sqlalchemy.schema import CreateTable

from .database import BASE_DIR, DATABASE_URL, Base, engine, is_elevated, probe_data_dir

SCHEMA_VERSION = 2
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
BACKUP_KEEP = 10

_status_lock = threading.Lock()
STATUS = {
    "ready": False,
    "phase": "starting",
    "message": "관제 서버를 시작하는 중입니다...",
    "steps": [],
    "error": "",
    "backup_file": "",
    "rebuilt_tables": [],
    "started_at": time.time(),
    "finished_at": None,
}


def _set(phase: str, message: str, **extra):
    with _status_lock:
        STATUS["phase"] = phase
        STATUS["message"] = message
        STATUS["steps"].append({"ts": time.time(), "phase": phase, "message": message})
        STATUS.update(extra)


def get_status() -> dict:
    with _status_lock:
        return {k: (list(v) if isinstance(v, list) else v) for k, v in STATUS.items()}


def _sqlite_path() -> str:
    return DATABASE_URL.replace("sqlite:///", "", 1) if DATABASE_URL.startswith("sqlite:///") else ""


def backup_database() -> str:
    """SQLite 온라인 백업 API로 일관된 사본을 만든다 (WAL 내용 포함)"""
    src_path = _sqlite_path()
    if not src_path or not os.path.exists(src_path):
        return ""
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dst_path = os.path.join(BACKUP_DIR, f"aurora_enterprise_{stamp}.db")
    # 어느 단계에서 실패했는지 화면에 정확히 보이도록 단계별로 오류를 감싼다
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
    except OSError as e:
        raise RuntimeError(f"백업 폴더 생성 실패: {BACKUP_DIR} ({e})") from e
    try:
        src = sqlite3.connect(src_path, timeout=30)
        src.execute("PRAGMA schema_version").fetchone()
    except sqlite3.Error as e:
        raise RuntimeError(f"원본 DB 열기 실패: {src_path} ({e})") from e
    try:
        dst = sqlite3.connect(dst_path)
    except sqlite3.Error as e:
        src.close()
        raise RuntimeError(f"백업 파일 생성 실패: {dst_path} ({e})") from e
    try:
        src.backup(dst)
    except sqlite3.Error as e:
        raise RuntimeError(f"백업 복사 실패: {src_path} → {dst_path} ({e})") from e
    finally:
        dst.close()
        src.close()
    # 오래된 백업 정리 (최근 BACKUP_KEEP 개 유지)
    files = sorted(glob.glob(os.path.join(BACKUP_DIR, "aurora_enterprise_*.db")))
    for old in files[:-BACKUP_KEEP]:
        try:
            os.remove(old)
        except OSError:
            pass
    return dst_path


def _rebuild_table(conn, table, existing_cols: list[str]) -> None:
    name = table.name
    tmp = f"{name}__new"
    ddl = str(CreateTable(table).compile(engine)).strip()
    ddl = ddl.replace(f"CREATE TABLE {name} ", f"CREATE TABLE {tmp} ", 1)
    conn.execute(text(f"DROP TABLE IF EXISTS {tmp}"))
    conn.execute(text(ddl))

    model_cols = [c.name for c in table.columns]
    common = [c for c in model_cols if c in existing_cols]
    col_list = ", ".join(f'"{c}"' for c in common)
    conn.execute(text(f"INSERT INTO {tmp} ({col_list}) SELECT {col_list} FROM {name}"))

    # 새로 생긴 컬럼 중 파이썬 기본값(스칼라)이 있는 것은 채워 넣는다
    for c in table.columns:
        if c.name in existing_cols or c.default is None or not getattr(c.default, "is_scalar", False):
            continue
        conn.execute(text(f'UPDATE {tmp} SET "{c.name}" = :v WHERE "{c.name}" IS NULL'), {"v": c.default.arg})

    conn.execute(text(f"DROP TABLE {name}"))
    conn.execute(text(f"ALTER TABLE {tmp} RENAME TO {name}"))
    for idx in table.indexes:
        idx.create(conn, checkfirst=True)


def migrate_schema() -> list[str]:
    """모델과 실제 테이블의 컬럼 구성이 다르면 재생성. 재생성한 테이블 이름 목록 반환"""
    rebuilt: list[str] = []
    if not DATABASE_URL.startswith("sqlite"):
        Base.metadata.create_all(bind=engine)
        return rebuilt

    with engine.connect() as conn:
        # PRAGMA foreign_keys 는 트랜잭션 밖에서만 적용되므로 먼저 실행 후 커밋
        conn.execute(text("PRAGMA foreign_keys=OFF"))
        conn.execute(text("PRAGMA legacy_alter_table=OFF"))
        insp = inspect(conn)
        existing_tables = set(insp.get_table_names())
        existing_cols_map = {t: [c["name"] for c in insp.get_columns(t)] for t in existing_tables}
        conn.commit()
        try:
            with conn.begin():
                for table in Base.metadata.sorted_tables:
                    if table.name not in existing_tables:
                        table.create(conn)
                        continue
                    existing_cols = existing_cols_map[table.name]
                    if set(existing_cols) != {c.name for c in table.columns}:
                        _rebuild_table(conn, table, existing_cols)
                        rebuilt.append(table.name)
                conn.execute(text(f"PRAGMA user_version={SCHEMA_VERSION}"))
        finally:
            conn.execute(text("PRAGMA foreign_keys=ON"))
            conn.commit()
    return rebuilt


_run_lock = threading.Lock()


def run_startup(post_steps, warning: str = "") -> None:
    """백업 → 마이그레이션 → 후처리(post_steps: [(phase, message, fn)]) 순서로 실행 (재시도 가능)"""
    if not _run_lock.acquire(blocking=False):
        return
    with _status_lock:
        STATUS.update(ready=False, error="", steps=[], started_at=time.time(), finished_at=None)
    try:
        if warning:
            _set("check", warning)
        _set("check", "데이터 폴더 접근 권한을 확인하고 있습니다...")
        problem = probe_data_dir()
        if problem:
            raise RuntimeError(problem)
        _set("backup", "기존 DB를 백업하고 있습니다...")
        backup = backup_database()
        _set("backup", f"백업 완료: {os.path.basename(backup)}" if backup else "백업할 기존 DB가 없습니다 (신규 설치)",
             backup_file=backup)

        _set("migrate", "DB 구조를 확인하고 새 컬럼 구조로 데이터를 옮기는 중입니다...")
        rebuilt = migrate_schema()
        _set(
            "migrate",
            f"DB 구조 갱신 완료 ({', '.join(rebuilt)})" if rebuilt else "DB 구조가 최신 상태입니다",
            rebuilt_tables=rebuilt,
        )

        for phase, message, fn in post_steps:
            _set(phase, message)
            fn()

        _set("ready", "준비 완료", ready=True, finished_at=time.time())
    except Exception as e:  # 실패 원인과 조치 방법을 화면에 안내
        hint = ""
        if "unable to open" in str(e) or "denied" in str(e).lower() or "쓰기 불가" in str(e):
            hint = (
                " | 조치: 관리자 권한 명령 프롬프트에서 "
                f'icacls "{BASE_DIR}" /reset /T /C 실행 후 [다시 시도]를 누르세요.'
                + ("" if is_elevated() else " (현재 서버가 관리자 권한 없이 실행 중입니다)")
            )
        _set(
            "error",
            "DB 준비 중 오류가 발생했습니다.",
            error=(str(e)[:450] + hint),
            finished_at=time.time(),
        )
    finally:
        _run_lock.release()
