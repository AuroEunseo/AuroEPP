import hashlib
import json
import os
import secrets
from fastapi import Header, HTTPException, Depends
from sqlalchemy.orm import Session
from .database import BASE_DIR, get_db
from .models import Agent

TOKEN_FILE = os.path.join(BASE_DIR, "admin_token.json")


def load_or_create_admin_token() -> str:
    os.makedirs(BASE_DIR, exist_ok=True)
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                tok = data.get("admin_token") or data.get("token")
                if tok and isinstance(tok, str) and len(tok.strip()) >= 16:
                    return tok.strip()
        except Exception:
            pass

    new_token = secrets.token_urlsafe(32)
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump({"admin_token": new_token, "token": new_token}, f, indent=2)
    return new_token

ADMIN_TOKEN_FILE = os.path.join(BASE_DIR, "admin_token.json")

def load_or_create_admin_token() -> str:
    if os.path.exists(ADMIN_TOKEN_FILE):
        with open(ADMIN_TOKEN_FILE, "r", encoding="utf-8") as f:
            return json.load(f)["admin_token"]
    token = secrets.token_urlsafe(24)
    with open(ADMIN_TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump({"admin_token": token}, f, indent=2)
    return token

ADMIN_TOKEN = load_or_create_admin_token()

def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

def verify_admin(x_admin_token: str = Header(default="")):
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="관리자 인증 토큰이 유효하지 않습니다.")
    return True

def verify_agent(
    x_machine_id: str = Header(default=""),
    x_agent_token: str = Header(default=""),
    db: Session = Depends(get_db),
) -> Agent:
    if not x_machine_id or not x_agent_token:
        raise HTTPException(status_code=401, detail="에이전트 인증 헤더 누락")
    
    agent = db.query(Agent).filter(Agent.machine_id == x_machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="미등록 에이전트")
    if agent.status != "active":
        raise HTTPException(status_code=403, detail=f"에이전트 상태가 active가 아닙니다 ({agent.status})")
    if not secrets.compare_digest(agent.token_hash, hash_token(x_agent_token)):
        raise HTTPException(status_code=401, detail="에이전트 고유 토큰 불일치")
    
    return agent