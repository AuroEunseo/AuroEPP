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

def secure_data_dir() -> None:
    """패키징 실행(Windows) 시 데이터 폴더를 Administrators/SYSTEM 전용으로 제한

    ProgramData 하위 폴더는 기본적으로 일반 사용자(Users)도 읽을 수 있어
    계정 DB·업데이트 DB·백업 파일이 노출될 수 있으므로 상속을 끊고 권한을 재설정한다.
    """
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    import subprocess

    try:
        subprocess.run(
            [
                "icacls", BASE_DIR, "/inheritance:r",
                "/grant:r", "*S-1-5-32-544:(OI)(CI)F",   # BUILTIN\Administrators
                "/grant:r", "*S-1-5-18:(OI)(CI)F",       # NT AUTHORITY\SYSTEM
                "/T", "/C", "/Q",
            ],
            capture_output=True,
            timeout=30,
            creationflags=0x08000000,
        )
    except Exception:
        pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()