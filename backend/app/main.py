import asyncio
import hashlib
import json
import os
import re
import sys
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from .catalog_sync import sync_catalog_database
from .database import BASE_DIR, Base, SessionLocal, engine, get_db
from .models import Agent, AgentCommand, EventLog, KbRule, Policy, UpdateCatalog
from .schemas import (
    CheckinRequest,
    CommandRequest,
    DecisionRequest,
    PolicySaveRequest,
    RegisterRequest,
    RingChangeRequest,
    RuleRequest,
)
from .security import ADMIN_TOKEN, hash_token, verify_admin, verify_agent


def policy_hash(items: list) -> str:
    return hashlib.sha1(json.dumps(items, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def log_event(db: Session, host: str, msg: str):
    db.add(EventLog(ts=time.time(), host=host, msg=msg[:500]))


def _periodic_catalog_worker():
    """6시간마다 Microsoft 공식 Windows 11 업데이트 및 사내 PC 보고 내역을 자동 수집"""
    while True:
        try:
            with SessionLocal() as db:
                sync_catalog_database(db, fetch_online=True)
        except Exception:
            pass
        time.sleep(6 * 3600)


def init_default_data():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        wu = "SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"

        def default_policy(days: int):
            return [
                {"path": wu, "name": "DeferQualityUpdates", "type": "DWORD", "value": 1 if days else 0},
                {"path": wu, "name": "DeferQualityUpdatesPeriodInDays", "type": "DWORD", "value": days},
                {"path": wu, "name": "ProductVersion", "type": "SZ", "value": "Windows 11"},
                {"path": wu, "name": "TargetReleaseVersion", "type": "DWORD", "value": 1},
                {"path": wu, "name": "TargetReleaseVersionInfo", "type": "SZ", "value": "24H2"},
                {"path": wu, "name": "ExcludeWUDriversInQualityUpdate", "type": "DWORD", "value": 1},
                {"path": wu + "\\AU", "name": "NoAutoRebootWithLoggedOnUsers", "type": "DWORD", "value": 1},
            ]

        for ring_name, defer_days in (("ring0", 0), ("ring1", 7)):
            if not db.query(Policy).filter(Policy.ring == ring_name).first():
                db.add(Policy(ring=ring_name, items_json=json.dumps(default_policy(defer_days))))
        db.commit()
    finally:
        db.close()


# ==========================================
# 실시간 에이전트 알림 스트림 큐 (SSE)
# ==========================================
AGENT_STREAMS: dict[str, asyncio.Queue] = {}


def notify_agent_realtime(machine_id: str, event_type: str = "sync"):
    q = AGENT_STREAMS.get(machine_id)
    if q:
        try:
            q.put_nowait({"type": event_type, "ts": time.time()})
        except asyncio.QueueFull:
            pass


def notify_ring_realtime(db: Session, ring: str, event_type: str = "policy"):
    targets = (
        db.query(Agent).filter(Agent.status == "active").all()
        if ring == "*"
        else db.query(Agent).filter(Agent.status == "active", Agent.ring == ring).all()
    )
    for a in targets:
        notify_agent_realtime(a.machine_id, event_type)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_default_data()
    # 서버 시작 시 6시간 주기 Windows 11 업데이트 카탈로그 자동 수집 스레드 가동
    threading.Thread(target=_periodic_catalog_worker, daemon=True).start()
    print("=" * 60)
    print("  AURORA Update Control Server 가동됨")
    print(f"  관리자 콘솔 접속 토큰: {ADMIN_TOKEN}")
    print("=" * 60)
    yield


app = FastAPI(title="AURORA Update Control API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================
# 1. 에이전트 통신 API (무인 등록, 체크인, 실시간 스트림, 종료 보고)
# ==========================================

@app.post("/api/agents/register")
def register_agent(req: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    """에이전트 PC가 자체 생성한 토큰 + PC이름 + OS버전을 전송해 등록 요청"""
    t_hash = hash_token(req.agent_token)
    preview = f"{req.agent_token[:6]}...{req.agent_token[-4:]}" if len(req.agent_token) > 10 else "***"
    client_ip = request.client.host if request.client else "unknown"

    agent = db.query(Agent).filter(Agent.machine_id == req.machine_id).first()
    if agent:
        if agent.status == "rejected":
            raise HTTPException(status_code=403, detail="관리자에 의해 등록이 거부된 PC입니다.")
        if agent.status == "active" and agent.token_hash == t_hash:
            agent.last_seen = time.time()
            agent.ip = client_ip
            db.commit()
            return {"status": "active", "ring": agent.ring}

        agent.hostname = req.hostname
        agent.os_name = req.os_name
        agent.os_build = req.os_build
        agent.ip = client_ip
        agent.token_hash = t_hash
        agent.token_preview = preview
        agent.agent_ver = req.agent_ver
        agent.status = "pending"
        agent.last_seen = time.time()
        log_event(db, req.hostname, f"에이전트 재등록 요청 (토큰: {preview})")
    else:
        agent = Agent(
            machine_id=req.machine_id,
            hostname=req.hostname,
            ip=client_ip,
            os_name=req.os_name,
            os_build=req.os_build,
            token_hash=t_hash,
            token_preview=preview,
            status="pending",
            ring="ring1",
            agent_ver=req.agent_ver,
            last_seen=time.time(),
        )
        db.add(agent)
        log_event(db, req.hostname, f"신규 PC 등록 대기 ({req.os_name} / {req.os_build})")

    db.commit()
    return {"status": "pending", "message": "콘솔 관리자의 승인을 기다리는 중입니다."}


@app.post("/api/agents/checkin")
def agent_checkin(
    req: CheckinRequest,
    request: Request,
    agent: Agent = Depends(verify_agent),
    db: Session = Depends(get_db),
):
    """승인된 에이전트의 정기/즉시 상태 보고 및 명령/정책 수신"""
    agent.hostname = req.hostname
    if req.os_name:
        agent.os_name = req.os_name
    if req.os_build:
        agent.os_build = req.os_build
    if request.client:
        agent.ip = request.client.host

    agent.last_seen = time.time()
    agent.applied_hash = req.applied_hash
    agent.reboot_required = req.reboot_required
    agent.hotfix = req.hotfix
    agent.agent_ver = req.agent_ver

    if req.mac_addr:
        agent.mac_addr = req.mac_addr
    if req.cpu_info:
        agent.cpu_info = req.cpu_info
    if req.ram_gb:
        agent.ram_gb = req.ram_gb

    for r in req.results:
        status_txt = "OK" if r.get("ok") else "FAIL"
        log_event(db, agent.hostname, f"{status_txt} [{r.get('type')}]: {r.get('out', '')}")

    if req.updates is not None:
        agent.pend_json = json.dumps(req.updates, ensure_ascii=False)
        agent.upd_ts = time.time()
    if req.history is not None:
        agent.hist_json = json.dumps(req.history, ensure_ascii=False)

    queued_cmds = (
        db.query(AgentCommand)
        .filter(AgentCommand.machine_id == agent.machine_id, AgentCommand.status == "queued")
        .order_by(AgentCommand.id.asc())
        .all()
    )
    commands_out = []
    for c in queued_cmds:
        commands_out.append({
            "id": c.id,
            "type": c.cmd_type,
            "payload": json.loads(c.payload_json or "{}"),
        })
        db.delete(c)

    pol_row = db.query(Policy).filter(Policy.ring == agent.ring).first()
    pol_items = json.loads(pol_row.items_json) if pol_row else []

    rule_map = {}
    rules_rows = db.query(KbRule).filter(KbRule.ring.in_(["*", agent.ring])).all()
    for r in sorted(rules_rows, key=lambda x: 0 if x.ring == "*" else 1):
        rule_map[r.kb] = r.action
    rules_out = [{"kb": k, "action": v} for k, v in sorted(rule_map.items())]

    db.commit()
    return {
        "policy": {"items": pol_items, "hash": policy_hash(pol_items)},
        "rules": rules_out,
        "rules_hash": policy_hash(rules_out),
        "commands": commands_out,
    }


@app.get("/api/agent/stream")
async def agent_realtime_stream(
    machine_id: str,
    x_agent_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """승인된 에이전트와 상시 연결되는 실시간 정책/명령 푸시 채널"""
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent or agent.status != "active" or agent.token_hash != hash_token(x_agent_token):
        raise HTTPException(status_code=401, detail="미승인 또는 유효하지 않은 에이전트 토큰")

    q: asyncio.Queue = asyncio.Queue(maxsize=32)
    AGENT_STREAMS[machine_id] = q

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20.0)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if AGENT_STREAMS.get(machine_id) is q:
                AGENT_STREAMS.pop(machine_id, None)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/agent/shutdown")
def agent_shutdown_log(
    payload: dict,
    x_agent_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """트레이 완전 종료 시 감사 로그 기록 및 오프라인 전환"""
    machine_id = payload.get("machine_id", "unknown")
    reason = payload.get("reason", "관리자/사용자 트레이 완전 종료")
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()

    if agent and agent.token_hash == hash_token(x_agent_token):
        agent.last_seen = 0
        log_event(db, agent.hostname, f"에이전트 완전 종료 보고 ({reason})")
        db.commit()
    return {"ok": True}


# ==========================================
# 2. 관리자 콘솔 API (프론트엔드 연동)
# ==========================================

@app.get("/api/state", dependencies=[Depends(verify_admin)])
def get_dashboard_state(db: Session = Depends(get_db)):
    pol_dict = {}
    for p in db.query(Policy).all():
        items = json.loads(p.items_json or "[]")
        pol_dict[p.ring] = {"items": items, "hash": policy_hash(items)}

    def serialize_agent(a: Agent):
        return {
            "machine_id": a.machine_id,
            "hostname": a.hostname,
            "ip": a.ip,
            "os_name": a.os_name,
            "os_build": a.os_build,
            "mac_addr": getattr(a, "mac_addr", None) or "-",
            "cpu_info": getattr(a, "cpu_info", None) or "-",
            "ram_gb": getattr(a, "ram_gb", None) or "-",
            "token_preview": a.token_preview,
            "status": a.status,
            "ring": a.ring,
            "last_seen": a.last_seen,
            "applied_hash": a.applied_hash,
            "target_hash": pol_dict.get(a.ring, {}).get("hash"),
            "reboot_required": a.reboot_required,
            "hotfix": a.hotfix,
            "agent_ver": a.agent_ver,
            "pend": json.loads(a.pend_json or "[]"),
            "hist": json.loads(a.hist_json or "[]"),
            "upd_ts": a.upd_ts,
        }

    raw_active = db.query(Agent).filter(Agent.status == "active").order_by(Agent.hostname).all()
    active_agents = [serialize_agent(a) for a in raw_active]
    pending_agents = [
        serialize_agent(a)
        for a in db.query(Agent).filter(Agent.status == "pending").order_by(Agent.last_seen.desc()).all()
    ]
    rules = [
        {"kb": r.kb, "ring": r.ring, "action": r.action, "note": r.note}
        for r in db.query(KbRule).order_by(KbRule.kb).all()
    ]
    events = [
        {"id": e.id, "ts": e.ts, "host": e.host, "msg": e.msg}
        for e in db.query(EventLog).order_by(EventLog.id.desc()).limit(80).all()
    ]

    # 수집된 Windows 11 업데이트 카탈로그 + 사내 설치/대기 대수 집계
    catalog_rows = db.query(UpdateCatalog).order_by(UpdateCatalog.updated_at.desc()).limit(100).all()
    catalog_list = []
    for c in catalog_rows:
        installed_cnt = sum(1 for a in raw_active if c.kb in (a.hotfix or "").upper())
        pending_cnt = sum(
            1
            for a in raw_active
            if any((u.get("kb") or "").upper() == c.kb for u in json.loads(a.pend_json or "[]"))
        )
        catalog_list.append({
            "kb": c.kb,
            "title": c.title,
            "category": c.category,
            "summary": c.summary,
            "release_date": c.release_date,
            "source": c.source,
            "installed_count": installed_cnt,
            "pending_count": pending_cnt,
        })

    return {
        "now": time.time(),
        "agents": active_agents,
        "pending_agents": pending_agents,
        "policies": pol_dict,
        "rules": rules,
        "events": events,
        "catalog": catalog_list,
    }


@app.post("/api/catalog/sync", dependencies=[Depends(verify_admin)])
def trigger_catalog_sync(db: Session = Depends(get_db)):
    added = sync_catalog_database(db, fetch_online=True)
    log_event(db, "console", f"Windows 11 업데이트 카탈로그 동기화 완료 (신규 {added}건)")
    db.commit()
    return {"ok": True, "added": added}


@app.post("/api/agents/{machine_id}/decision", dependencies=[Depends(verify_admin)])
def decide_pending_agent(machine_id: str, req: DecisionRequest, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="대상 PC를 찾을 수 없습니다.")

    if req.approve:
        agent.status = "active"
        agent.ring = req.ring
        db.add(AgentCommand(machine_id=agent.machine_id, cmd_type="scan", payload_json="{}"))
        log_event(db, "console", f"에이전트 승인 완료: {agent.hostname} ({req.ring})")
    else:
        agent.status = "rejected"
        log_event(db, "console", f"에이전트 등록 거부됨: {agent.hostname}")

    db.commit()
    if req.approve:
        notify_agent_realtime(machine_id, "approved")
    return {"ok": True}


@app.post("/api/agents/{machine_id}/revoke", dependencies=[Depends(verify_admin)])
def revoke_agent_token(machine_id: str, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="대상 PC를 찾을 수 없습니다.")
    agent.status = "pending"
    agent.token_hash = "REVOKED"
    log_event(db, "console", f"토큰 폐기 및 재인증 대기 전환: {agent.hostname}")
    db.commit()
    return {"ok": True}


@app.delete("/api/agents/{machine_id}", dependencies=[Depends(verify_admin)])
def delete_agent(machine_id: str, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="대상 PC를 찾을 수 없습니다.")

    hostname = agent.hostname
    db.query(AgentCommand).filter(AgentCommand.machine_id == machine_id).delete()
    db.delete(agent)
    log_event(db, "console", f"관리 대상 PC 영구 삭제 완료: {hostname} ({machine_id})")
    db.commit()

    AGENT_STREAMS.pop(machine_id, None)
    return {"ok": True}


@app.post("/api/agents/{machine_id}/ring", dependencies=[Depends(verify_admin)])
def change_agent_ring(machine_id: str, req: RingChangeRequest, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="대상 PC를 찾을 수 없습니다.")
    agent.ring = req.ring
    log_event(db, "console", f"{agent.hostname} 링 변경 → {req.ring}")
    db.commit()
    notify_agent_realtime(machine_id, "policy")
    return {"ok": True}


@app.post("/api/policies", dependencies=[Depends(verify_admin)])
def save_policy(req: PolicySaveRequest, db: Session = Depends(get_db)):
    pol = db.query(Policy).filter(Policy.ring == req.ring).first()
    if not pol:
        pol = Policy(ring=req.ring)
        db.add(pol)
    pol.items_json = json.dumps(req.items, ensure_ascii=False)
    log_event(db, "console", f"{req.ring} 정책 저장 ({policy_hash(req.items)})")
    db.commit()
    notify_ring_realtime(db, req.ring, "policy")
    return {"ok": True}


@app.post("/api/rings", dependencies=[Depends(verify_admin)])
def create_ring(payload: dict, db: Session = Depends(get_db)):
    ring_name = str(payload.get("ring", "")).strip()
    if not ring_name or ring_name == "*":
        raise HTTPException(status_code=400, detail="올바른 링(그룹) 이름을 입력하세요.")
    if db.query(Policy).filter(Policy.ring == ring_name).first():
        raise HTTPException(status_code=400, detail="이미 존재하는 링 이름입니다.")

    base_ring = payload.get("copy_from", "ring1")
    base_pol = db.query(Policy).filter(Policy.ring == base_ring).first()
    items_json = base_pol.items_json if base_pol else "[]"

    db.add(Policy(ring=ring_name, items_json=items_json))
    log_event(db, "console", f"새 배포 링 생성: {ring_name}")
    db.commit()
    return {"ok": True}


@app.delete("/api/rings/{ring_name}", dependencies=[Depends(verify_admin)])
def delete_ring(ring_name: str, db: Session = Depends(get_db)):
    if ring_name in ("ring0", "ring1"):
        raise HTTPException(status_code=400, detail="기본 링(ring0, ring1)은 삭제할 수 없습니다.")

    db.query(Agent).filter(Agent.ring == ring_name).update({"ring": "ring1"})
    db.query(KbRule).filter(KbRule.ring == ring_name).delete()
    db.query(Policy).filter(Policy.ring == ring_name).delete()

    log_event(db, "console", f"배포 링 삭제 완료: {ring_name} (소속 PC → ring1 이동)")
    db.commit()
    return {"ok": True}


@app.put("/api/rings/{old_ring}", dependencies=[Depends(verify_admin)])
def rename_ring(old_ring: str, payload: dict, db: Session = Depends(get_db)):
    new_ring = str(payload.get("new_ring", "")).strip()
    if not new_ring or new_ring == "*":
        raise HTTPException(status_code=400, detail="새 그룹 이름을 올바르게 입력하세요.")
    if old_ring == new_ring:
        return {"ok": True}
    if db.query(Policy).filter(Policy.ring == new_ring).first():
        raise HTTPException(status_code=400, detail="이미 존재하는 그룹 이름입니다.")

    pol = db.query(Policy).filter(Policy.ring == old_ring).first()
    if not pol:
        raise HTTPException(status_code=404, detail="대상 그룹을 찾을 수 없습니다.")

    pol.ring = new_ring
    db.query(Agent).filter(Agent.ring == old_ring).update({"ring": new_ring})
    db.query(KbRule).filter(KbRule.ring == old_ring).update({"ring": new_ring})
    log_event(db, "console", f"배포 그룹 이름 변경: {old_ring} → {new_ring}")
    db.commit()
    return {"ok": True}


@app.post("/api/rules", dependencies=[Depends(verify_admin)])
def manage_kb_rule(req: RuleRequest, db: Session = Depends(get_db)):
    kb = req.kb.upper().strip()
    if not re.fullmatch(r"KB\d{5,8}", kb) or req.action not in ("block", "allow", "install", "none"):
        raise HTTPException(status_code=400, detail="KB 번호 또는 동작 형식이 올바르지 않습니다.")

    existing = db.query(KbRule).filter(KbRule.kb == kb, KbRule.ring == req.ring).first()
    if req.action == "none":
        if existing:
            db.delete(existing)
    else:
        if existing:
            existing.action = req.action
            existing.note = req.note
            existing.updated_at = time.time()
        else:
            db.add(KbRule(kb=kb, ring=req.ring, action=req.action, note=req.note))

    log_event(db, "console", f"KB 규칙 {kb} → {req.action} (범위: {req.ring})")
    db.commit()
    notify_ring_realtime(db, req.ring, "rules")
    return {"ok": True}


@app.post("/api/commands", dependencies=[Depends(verify_admin)])
def dispatch_commands(req: CommandRequest, db: Session = Depends(get_db)):
    valid_types = {"scan", "install_all", "install_kb", "hide_kb", "unhide_kb", "reboot"}
    if req.type not in valid_types:
        raise HTTPException(status_code=400, detail="지원하지 않는 명령 유형입니다.")

    count = 0
    dispatched_ids = []
    for mid in req.machine_ids:
        agent = db.query(Agent).filter(Agent.machine_id == mid, Agent.status == "active").first()
        if agent:
            db.add(
                AgentCommand(
                    machine_id=mid,
                    cmd_type=req.type,
                    payload_json=json.dumps(req.payload, ensure_ascii=False),
                )
            )
            count += 1
            dispatched_ids.append(mid)

    detail = f" ({req.payload.get('kb')})" if req.payload.get("kb") else ""
    log_event(db, "console", f"명령 전송 [{req.type}{detail}] → {count}대")
    db.commit()
    for mid in dispatched_ids:
        notify_agent_realtime(mid, "command")
    return {"ok": True, "dispatched": count}


# ==========================================
# 3. 빌드된 Vite 정적 웹 콘솔 서빙 (.exe 패키징 호환)
# ==========================================

def find_static_dir() -> str:
    candidates = [
        os.path.join(getattr(sys, "_MEIPASS", ""), "static"),
        os.path.join(BASE_DIR, "static"),
    ]
    for path in candidates:
        if path and os.path.exists(os.path.join(path, "index.html")):
            return path
    return ""


STATIC_DIR = find_static_dir()

if STATIC_DIR and os.path.isdir(os.path.join(STATIC_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")


@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API 경로를 찾을 수 없습니다.")
    if STATIC_DIR:
        index_file = os.path.join(STATIC_DIR, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file)
    return {
        "error": "static 폴더(index.html)를 찾지 못했습니다.",
        "meipass": getattr(sys, "_MEIPASS", None),
        "base_dir": BASE_DIR,
    }