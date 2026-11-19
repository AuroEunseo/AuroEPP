import os
import sys

import uvicorn

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "backend"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# 비상용 비밀번호 초기화 (서버 PC에서 관리자 권한 명령 프롬프트로 실행)
#   AuroraServerEngine.exe --reset-password admin
if len(sys.argv) >= 3 and sys.argv[1] == "--reset-password":
    from app.accounts import reset_password  # noqa: E402

    new_pw = reset_password(sys.argv[2])
    print(f"[OK] '{sys.argv[2]}' 계정의 임시 비밀번호: {new_pw}")
    print("     로그인 후 설정 탭에서 비밀번호를 변경해야 다른 메뉴를 사용할 수 있습니다.")
    sys.exit(0)

from app.main import app  # noqa: E402
from app.settings import SERVER_CONFIG  # noqa: E402

if __name__ == "__main__":
    # 주소/포트는 server_config.json 한 곳에서만 지정 (host: 0.0.0.0 또는 127.0.0.1)
    uvicorn.run(app, host=SERVER_CONFIG["host"], port=SERVER_CONFIG["port"], log_level="warning")
