"""에이전트 서버 주소 설정 (단일 설정 지점)

관제 서버 주소는 C:\\ProgramData\\AURORA\\agent_config.json 한 곳에서만 읽는다.
이 파일은 트레이 앱(설정 창)이 저장하며, 서비스/워커/트레이가 모두 같은 파일을 사용한다.

{
  "server_ip": "192.168.0.10",
  "server_port": 1557
}
"""
import json
import os
import re
import sys

DEFAULT_SERVER_IP = "127.0.0.1"
DEFAULT_SERVER_PORT = 1557

DATA_DIR = (
    os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"), "AURORA")
    if sys.platform == "win32"
    else os.path.expanduser("~/.aurora")
)
CONFIG_FILE = os.path.join(DATA_DIR, "agent_config.json")


def _normalize_host(raw: str) -> str:
    host = re.sub(r"^https?://", "", str(raw or "").strip(), flags=re.I)
    host = host.split("/")[0]
    host = re.sub(r":\d+$", "", host)
    return host or DEFAULT_SERVER_IP


def load_server_url() -> str:
    ip, port = DEFAULT_SERVER_IP, DEFAULT_SERVER_PORT
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("server_ip"):
            ip = _normalize_host(cfg["server_ip"])
            port = int(cfg.get("server_port") or DEFAULT_SERVER_PORT)
        elif cfg.get("server_url"):  # 이전 버전 설정 파일 호환
            m = re.match(r"^(?:https?://)?([^/:]+)(?::(\d+))?", str(cfg["server_url"]).strip())
            if m:
                ip = m.group(1)
                port = int(m.group(2) or DEFAULT_SERVER_PORT)
    except (OSError, ValueError, TypeError):
        pass
    return f"http://{ip}:{port}"
