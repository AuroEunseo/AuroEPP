"""에이전트 로컬 로그 (연결 문제 진단용)

C:\\ProgramData\\AURORA\\logs\\agent.log  (1MB × 최대 3개 순환 보관)
부팅 후 재연결 실패 같은 문제가 생기면 이 파일에서 원인(네트워크 오류, 401/403/404 응답 등)을 확인할 수 있다.
"""
import logging
import os
from logging.handlers import RotatingFileHandler

from config import DATA_DIR

LOG_DIR = os.path.join(DATA_DIR, "logs")
LOG_FILE = os.path.join(LOG_DIR, "agent.log")

_logger = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger:
        return _logger
    logger = logging.getLogger("aurora.agent")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        h = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logger.addHandler(h)
    except OSError:
        logger.addHandler(logging.NullHandler())
    _logger = logger
    return logger
