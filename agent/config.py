import configparser
import os
import sys

# 빌드 시 기본으로 내장할 관리 서버 주소 (배포 환경에 맞게 수정)
DEFAULT_SERVER_URL = "http://127.0.0.1:8080"

def get_exe_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

def load_server_url() -> str:
    # 1순위: 환경변수
    env_url = os.getenv("AURORA_SERVER")
    if env_url:
        return env_url.rstrip("/")

    # 2순위: 실행 파일 옆에 aurora.ini가 있는 경우 읽기
    ini_path = os.path.join(get_exe_dir(), "aurora.ini")
    if os.path.exists(ini_path):
        cfg = configparser.ConfigParser()
        cfg.read(ini_path, encoding="utf-8")
        url = cfg.get("aurora", "server", fallback="").strip()
        if url:
            return url.rstrip("/")

    # 3순위: 코드에 내장된 기본 서버 주소
    return DEFAULT_SERVER_URL.rstrip("/")