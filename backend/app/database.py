import os
import sys
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base

def get_base_dir() -> str:
    # 패키징(.exe) 실행 시 쓰기 권한이 보장되는 C:\ProgramData\AURORA\Server 사용
    if getattr(sys, "frozen", False):
        data_dir = os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"), "AURORA", "Server")
        os.makedirs(data_dir, exist_ok=True)
        return data_dir
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE_DIR = get_base_dir()
DEFAULT_DB_URL = f"sqlite:///{os.path.join(BASE_DIR, 'aurora_enterprise.db')}"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DB_URL)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)

# SQLite 동시성 향상을 위한 WAL 모드 및 외래키 활성화
if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, _):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA synchronous=NORMAL;")
        cursor.execute("PRAGMA foreign_keys=ON;")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def is_elevated() -> bool:
    """Windows 관리자 권한(UAC 상승)으로 실행 중인지 여부"""
    if sys.platform != "win32":
        return True
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _icacls(*args) -> tuple[int, str]:
    import subprocess

    try:
        r = subprocess.run(["icacls", *args], capture_output=True, text=True, timeout=60, creationflags=0x08000000)
        return r.returncode, (r.stdout or r.stderr or "").strip()
    except Exception as e:
        return -1, str(e)


def probe_data_dir() -> str:
    """데이터 폴더와 DB 파일을 실제로 열 수 있는지 확인. 문제 없으면 빈 문자열, 있으면 원인 메시지"""
    import sqlite3

    try:
        os.makedirs(BASE_DIR, exist_ok=True)
        probe = os.path.join(BASE_DIR, ".write_probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
    except OSError as e:
        return f"데이터 폴더 쓰기 불가: {BASE_DIR} ({e})"
    db_path = os.path.join(BASE_DIR, "aurora_enterprise.db")
    if os.path.exists(db_path):
        try:
            c = sqlite3.connect(db_path, timeout=5)
            c.execute("PRAGMA schema_version").fetchone()
            c.close()
        except sqlite3.Error as e:
            return f"DB 파일을 열 수 없음: {db_path} ({e})"
    return ""


def secure_data_dir() -> str:
    """패키징 실행(Windows) 시 데이터 폴더를 Administrators/SYSTEM 전용으로 제한

    ProgramData 하위 폴더는 기본적으로 일반 사용자(Users)도 읽을 수 있어
    계정 DB·업데이트 DB·백업 파일이 노출될 수 있으므로 상속을 끊고 권한을 재설정한다.
    순서: ① 폴더에 관리자/SYSTEM 권한 부여 → ② 상위 상속 제거 → ③ 하위 항목은 폴더 권한을 상속하도록 초기화
    적용 후 실제로 파일을 열 수 없으면 ProgramData 기본 권한으로 즉시 되돌린다.
    반환: 경고 메시지(없으면 빈 문자열)
    """
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return ""
    if not is_elevated():
        # 관리자 권한이 아니면 권한을 바꾸지 않는다 (바꾸면 이후 이 프로세스가 파일을 못 열게 됨)
        return "서버가 관리자 권한 없이 실행되어 데이터 폴더 보안 설정을 건너뛰었습니다."
    _icacls(BASE_DIR, "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "/grant:r", "*S-1-5-18:(OI)(CI)F", "/C", "/Q")
    _icacls(BASE_DIR, "/inheritance:r", "/C", "/Q")
    _icacls(os.path.join(BASE_DIR, "*"), "/reset", "/T", "/C", "/Q")
    problem = probe_data_dir()
    if problem:
        _icacls(BASE_DIR, "/reset", "/T", "/C", "/Q")  # 원래(ProgramData 기본) 권한으로 복구
        return f"데이터 폴더 보안 설정 후 접근 오류가 발생해 기본 권한으로 되돌렸습니다: {problem}"
    return ""


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()