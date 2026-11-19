"""AURORA 관제 서버 설정 (단일 설정 지점)

모든 서버 실행 설정은 데이터 폴더의 server_config.json 한 곳에서만 읽는다.
  - 패키징(.exe) 실행: C:\\ProgramData\\AURORA\\Server\\server_config.json
  - 개발 실행:         backend\\server_config.json

{
  "host": "0.0.0.0",             // 허용값: "0.0.0.0"(전체 네트워크) | "127.0.0.1"(서버 PC 내부 전용)
  "port": 1557,
  "admin_allowed_ips": []        // 관리자 콘솔 접근 허용 IP/대역(CIDR). 비어 있으면 제한 없음
}
"""
import ipaddress
import json
import os

from .database import BASE_DIR

CONFIG_FILE = os.path.join(BASE_DIR, "server_config.json")

DEFAULT_PORT = 1557
ALLOWED_HOSTS = ("0.0.0.0", "127.0.0.1")
DEFAULTS = {"host": "0.0.0.0", "port": DEFAULT_PORT, "admin_allowed_ips": []}

# ---- 운영 상수 ----
ONLINE_WINDOW_SEC = 60          # 마지막 체크인 후 이 시간 이내면 온라인으로 판단
PENDING_ALIVE_SEC = 45          # 승인 대기 PC가 이 시간 이내에 등록 요청을 보냈으면 "응답 확인됨"
# 오프라인 PC에 보낸 명령은 대기열에 보관했다가 다음 부팅(재연결) 시 바로 적용.
# 이 기간 안에 PC가 한 번도 켜지지 않으면 만료 처리
COMMAND_KEEP_DAYS = 7
RECONNECT_WATCH_SEC = 600       # 재부팅 명령 전달 후 이 시간 안에 재연결되지 않으면 콘솔 알림
RETENTION_DAYS = 7              # 이벤트/명령/접속/알림 로그 보관 기간
HISTORY_KEEP = 100              # PC별 서버 보관(=콘솔 표시) 업데이트 이력 최대 건수
REGISTRY_CHANGE_KEEP = 200      # PC별 레지스트리 변경 이력 최대 보관 건수
PACKAGE_MAX_BYTES = 4 * 1024**3  # 업로드 가능한 설치 파일 최대 크기 (4GB)
DEPLOY_KEEP_DAYS = 30           # 프로그램 배포 기록 보관 기간
SESSION_HOURS = 12              # 콘솔 로그인 세션 유효 시간(마지막 사용 기준)


def _validate(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    host = str(cfg.get("host", DEFAULTS["host"])).strip()
    out["host"] = host if host in ALLOWED_HOSTS else DEFAULTS["host"]
    try:
        port = int(cfg.get("port", DEFAULT_PORT))
        out["port"] = port if 1 <= port <= 65535 else DEFAULT_PORT
    except (TypeError, ValueError):
        out["port"] = DEFAULT_PORT
    nets = []
    for raw in cfg.get("admin_allowed_ips") or []:
        try:
            nets.append(str(ipaddress.ip_network(str(raw).strip(), strict=False)))
        except ValueError:
            pass
    out["admin_allowed_ips"] = nets
    return out


def load_server_config() -> dict:
    """설정 파일을 읽고(없으면 기본값으로 생성) 검증된 값을 반환"""
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    valid = _validate(cfg)
    if valid != cfg:
        try:
            os.makedirs(BASE_DIR, exist_ok=True)
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(valid, f, indent=2, ensure_ascii=False)
        except OSError:
            pass
    return valid


SERVER_CONFIG = load_server_config()


def is_admin_ip_allowed(ip: str) -> bool:
    nets = SERVER_CONFIG.get("admin_allowed_ips") or []
    if not nets:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.is_loopback:
        return True  # 서버 PC 본인(콘솔 앱)은 항상 허용
    return any(addr in ipaddress.ip_network(n) for n in nets)
