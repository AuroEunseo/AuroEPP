import hashlib
import secrets

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from . import accounts
from .database import get_db
from .migrations import get_status
from .models import Agent
from .settings import is_admin_ip_allowed


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def require_ready():
    """DB 백업/마이그레이션이 끝나기 전에는 데이터 API를 막는다 (에이전트는 자동 재시도)"""
    st = get_status()
    if not st["ready"]:
        raise HTTPException(status_code=503, detail=st["message"] or "서버 준비 중입니다.")
    return True


def check_admin_ip(request: Request):
    if not is_admin_ip_allowed(client_ip(request)):
        raise HTTPException(status_code=403, detail="이 PC에서는 관리자 콘솔에 접근할 수 없습니다. (허용 IP 아님)")
    return True


def current_admin(
    request: Request,
    x_session_token: str = Header(default=""),
    _ip_ok: bool = Depends(check_admin_ip),
) -> dict:
    """로그인 세션 확인 (계정 DB 기반). 비밀번호 변경이 필요한 계정도 통과시키되 플래그를 넘긴다."""
    user = accounts.get_session_user(x_session_token)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    user["token"] = x_session_token
    return user


def verify_admin(user: dict = Depends(current_admin)) -> dict:
    """일반 관리 API용(관리자·운영자 공통): 임시 비밀번호 상태에서는 비밀번호 변경 전까지 사용 불가"""
    if user.get("must_change"):
        raise HTTPException(status_code=403, detail="PASSWORD_CHANGE_REQUIRED")
    return user


def require_admin_role(user: dict = Depends(verify_admin)) -> dict:
    """계정 관리 등 '관리자' 권한 전용 API"""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자 권한이 필요한 기능입니다.")
    return user


def verify_agent(
    x_machine_id: str = Header(default=""),
    x_agent_token: str = Header(default=""),
    db: Session = Depends(get_db),
) -> Agent:
    if not x_machine_id or not x_agent_token:
        raise HTTPException(status_code=401, detail="에이전트 인증 헤더 누락")

    # 응답 코드 규칙 (에이전트 동작과 짝을 이룸)
    #  404: 서버에 기록 없음(삭제/DB 초기화) → 같은 토큰으로 재등록
    #  401: 토큰 불일치(토큰 폐기 포함)     → 새 토큰 발급 후 재등록
    #  403: 승인 대기/거부 상태             → 같은 토큰으로 승인 대기
    agent = db.query(Agent).filter(Agent.machine_id == x_machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="미등록 에이전트")
    if not secrets.compare_digest(agent.token_hash, hash_token(x_agent_token)):
        raise HTTPException(status_code=401, detail="에이전트 고유 토큰 불일치")
    if agent.status != "active":
        raise HTTPException(status_code=403, detail=f"에이전트 상태가 active가 아닙니다 ({agent.status})")

    return agent
