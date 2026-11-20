import asyncio
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from . import accounts, packages
from .catalog_sync import sync_catalog_database
from .database import BASE_DIR, SessionLocal, get_db, secure_data_dir
from .migrations import get_status, run_startup
from .models import (
    AccessLog,
    Agent,
    AgentCommand,
    EventLog,
    KbRule,
    Notification,
    Policy,
    RegistryChange,
    UpdateCatalog,
)
from .schemas import (
    AccountCreateRequest,
    AccountRoleRequest,
    ScanRequest,
    CheckinRequest,
    CommandRequest,
    DecisionRequest,
    LoginRequest,
    PasswordChangeRequest,
    PolicySaveRequest,
    RegisterRequest,
    RingChangeRequest,
    RuleRequest,
)
from .security import (
    check_admin_ip,
    client_ip,
    current_admin,
    hash_token,
    require_admin_role,
    require_ready,
    verify_admin,
    verify_agent,
)
from .settings import (
    COMMAND_KEEP_DAYS,
    RECONNECT_WATCH_SEC,
    HISTORY_KEEP,
    ONLINE_WINDOW_SEC,
    PENDING_ALIVE_SEC,
    REGISTRY_CHANGE_KEEP,
    RETENTION_DAYS,
    SERVER_CONFIG,
)

# 기능 업데이트 고정 버전 기본값 (서비스 종료된 버전에 고정되지 않도록 환경변수로 지정 가능)
DEFAULT_TARGET_RELEASE = os.getenv("AURORA_TARGET_RELEASE", "25H2").strip() or "25H2"
# 기존 DB에 남아 있는 지원 종료 버전 기본값 → DEFAULT_TARGET_RELEASE 로 자동 전환
LEGACY_TARGET_RELEASES = {"24H2"}

POLICY_ROOT = "SOFTWARE\\POLICIES\\"
ADMIN_DEPS = [Depends(verify_admin), Depends(require_ready)]


def policy_hash(items: list) -> str:
    return hashlib.sha1(json.dumps(items, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def log_event(db: Session, host: str, msg: str):
    db.add(EventLog(ts=time.time(), host=host, msg=msg[:500]))


def notify_console(db: Session, level: str, category: str, title: str, message: str = "", machine_id: str = ""):
    """콘솔 알림 탭에 '확인 필요' 항목 추가 (관리자가 확인하면 삭제됨)"""
    db.add(
        Notification(
            ts=time.time(), level=level, category=category,
            title=title[:128], message=message[:1000], machine_id=machine_id or "",
        )
    )


def is_online(agent: Agent, now: float | None = None) -> bool:
    return ((now or time.time()) - (agent.last_seen or 0)) < ONLINE_WINDOW_SEC


# ==========================================
# 콘솔 접속 로그 (DB 준비 전 발생분은 메모리에 잠시 보관 후 기록)
# ==========================================
_access_buffer: list[dict] = []
_access_lock = threading.Lock()


def write_access_log(username: str, ip: str, action: str, ok: bool, detail: str = ""):
    with _access_lock:
        _access_buffer.append(
            {"ts": time.time(), "username": (username or "")[:64], "ip": ip, "action": action, "ok": ok,
             "detail": detail[:256]}
        )
    if get_status()["ready"]:
        flush_access_logs()


def flush_access_logs():
    with _access_lock:
        items = list(_access_buffer)
        _access_buffer.clear()
    if not items:
        return
    try:
        with SessionLocal() as db:
            for it in items:
                db.add(AccessLog(**it))
            db.commit()
    except Exception:
        with _access_lock:
            _access_buffer[:0] = items


# ==========================================
# 시작 시 데이터 준비 / 주기 작업
# ==========================================
def init_default_data():
    db = SessionLocal()
    try:
        wu = "SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"

        def default_policy(days: int):
            return [
                {"path": wu, "name": "DeferQualityUpdates", "type": "DWORD", "value": 1 if days else 0},
                {"path": wu, "name": "DeferQualityUpdatesPeriodInDays", "type": "DWORD", "value": days},
                {"path": wu, "name": "ProductVersion", "type": "SZ", "value": "Windows 11"},
                {"path": wu, "name": "TargetReleaseVersion", "type": "DWORD", "value": 1},
                {"path": wu, "name": "TargetReleaseVersionInfo", "type": "SZ", "value": DEFAULT_TARGET_RELEASE},
                {"path": wu, "name": "ExcludeWUDriversInQualityUpdate", "type": "DWORD", "value": 1},
                {"path": wu + "\\AU", "name": "NoAutoRebootWithLoggedOnUsers", "type": "DWORD", "value": 1},
            ]

        for ring_name, defer_days in (("ring0", 0), ("ring1", 7)):
            if not db.query(Policy).filter(Policy.ring == ring_name).first():
                db.add(Policy(ring=ring_name, items_json=json.dumps(default_policy(defer_days))))

        # 지원 종료된 버전(24H2 등)에 고정된 기존 정책을 기본 대상 버전으로 이관
        # (의도적으로 유지하려면 AURORA_KEEP_TARGET_RELEASE=1 설정)
        if os.getenv("AURORA_KEEP_TARGET_RELEASE", "0") != "1":
            for pol in db.query(Policy).all():
                items = json.loads(pol.items_json or "[]")
                changed_from = None
                for it in items:
                    val = str(it.get("value", "")).upper()
                    if (
                        it.get("name") == "TargetReleaseVersionInfo"
                        and val in LEGACY_TARGET_RELEASES
                        and val != DEFAULT_TARGET_RELEASE.upper()
                    ):
                        changed_from = it.get("value")
                        it["value"] = DEFAULT_TARGET_RELEASE
                if changed_from is not None:
                    pol.items_json = json.dumps(items, ensure_ascii=False)
                    log_event(
                        db, "server",
                        f"{pol.ring} 정책의 고정 버전 {changed_from} → {DEFAULT_TARGET_RELEASE} 자동 변경 (지원 종료 버전)",
                    )
        db.commit()
    finally:
        db.close()


def cleanup_old_records():
    """보관 기간(7일)이 지난 이벤트/명령/접속/알림 로그와 만료된 명령·세션 정리"""
    now = time.time()
    cutoff = now - RETENTION_DAYS * 86400
    with SessionLocal() as db:
        db.query(EventLog).filter(EventLog.ts < cutoff).delete(synchronize_session=False)
        db.query(AccessLog).filter(AccessLog.ts < cutoff).delete(synchronize_session=False)
        db.query(Notification).filter(Notification.ts < cutoff).delete(synchronize_session=False)
        # 명령 대기열: COMMAND_KEEP_DAYS 동안 한 번도 켜지지 않은 PC의 명령은 만료 처리
        expired = (
            db.query(AgentCommand)
            .filter(AgentCommand.created_at < now - COMMAND_KEEP_DAYS * 86400)
            .all()
        )
        for c in expired:
            host = c.agent.hostname if c.agent else c.machine_id
            log_event(db, host, f"대기 명령 만료 [{c.cmd_type}] ({COMMAND_KEEP_DAYS}일 동안 PC가 켜지지 않음)")
            packages.on_command_expired(db, c)
            db.delete(c)
        packages.cleanup(db)
        db.commit()
    accounts.purge_expired_sessions()


def warm_load():
    with SessionLocal() as db:
        db.query(Agent).count()
    flush_access_logs()


def _periodic_worker():
    """준비 완료 후: 1시간마다 로그 정리, 6시간마다 업데이트 카탈로그 수집"""
    last_catalog = 0.0
    while True:
        if get_status()["ready"]:
            try:
                cleanup_old_records()
                flush_access_logs()
            except Exception:
                pass
            if time.time() - last_catalog > 6 * 3600:
                last_catalog = time.time()
                try:
                    with SessionLocal() as db:
                        sync_catalog_database(db, fetch_online=True)
                except Exception:
                    pass
            time.sleep(3600)
        else:
            time.sleep(2)


def _presence_worker():
    """재부팅 명령 후 재연결 확인: 기한 안에 다시 연결되지 않으면 콘솔 알림"""
    while True:
        time.sleep(30)
        if not get_status()["ready"]:
            continue
        try:
            now = time.time()
            with SessionLocal() as db:
                overdue = (
                    db.query(Agent)
                    .filter(Agent.reconnect_watch_until.isnot(None), Agent.reconnect_watch_until < now)
                    .all()
                )
                for a in overdue:
                    mins = int((now - (a.reconnect_watch_since or now)) // 60)
                    notify_console(
                        db, "warn", "agent", f"재부팅 후 재연결되지 않음: {a.hostname}",
                        f"재부팅 명령 전달 후 {mins}분이 지났지만 에이전트가 다시 연결되지 않았습니다. "
                        "PC 전원, 네트워크, 'AuroraUpdateAgent' 서비스 상태를 확인하세요. "
                        "(연결되면 자동으로 '재연결 완료' 알림이 표시됩니다)",
                        a.machine_id,
                    )
                    log_event(db, a.hostname, f"재부팅 후 {mins}분 동안 재연결 없음")
                    a.reconnect_watch_until = None  # 알림은 1회만, since 는 유지해 늦은 재연결도 감지
                db.commit()
        except Exception:
            pass


_DATA_DIR_WARNING = ""


def _startup_sequence():
    run_startup(
        warning=_DATA_DIR_WARNING,
        post_steps=[
            ("seed", "기본 배포 정책을 확인하는 중입니다...", init_default_data),
            ("cleanup", f"{RETENTION_DAYS}일이 지난 로그를 정리하는 중입니다...", cleanup_old_records),
            ("load", "PC 목록을 불러오는 중입니다...", warm_load),
        ]
    )
    st = get_status()
    if st["ready"]:
        with SessionLocal() as db:
            if st["rebuilt_tables"]:
                notify_console(
                    db, "info", "system", "DB 구조가 갱신되었습니다",
                    f"갱신된 테이블: {', '.join(st['rebuilt_tables'])} / 백업: {os.path.basename(st['backup_file'])}",
                )
            db.commit()


# ==========================================
# 실시간 에이전트 알림 스트림 큐 (SSE)
# ==========================================
# machine_id -> (이벤트 루프, 큐). 동기 API(스레드풀)에서도 안전하게 넣을 수 있도록 루프를 함께 보관.
# 큐의 알림은 에이전트에 1회 전달되면 즉시 사라지며, 연결 종료·토큰 폐기·삭제 시 항목 자체를 정리한다.
AGENT_STREAMS: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = {}


def _queue_put(q: asyncio.Queue, msg: dict):
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        # 에이전트는 이벤트 종류와 무관하게 '즉시 체크인'만 하므로 밀린 알림은 버려도 무방
        pass


def notify_agent_realtime(machine_id: str, event_type: str = "sync"):
    entry = AGENT_STREAMS.get(machine_id)
    if not entry:
        return
    loop, q = entry
    msg = {"type": event_type, "ts": time.time()}
    try:
        loop.call_soon_threadsafe(_queue_put, q, msg)
    except RuntimeError:
        AGENT_STREAMS.pop(machine_id, None)


def close_agent_stream(machine_id: str):
    """토큰 폐기/거부/삭제 시 열려 있는 스트림을 종료하고 메모리에서 제거"""
    entry = AGENT_STREAMS.pop(machine_id, None)
    if entry:
        loop, q = entry
        try:
            loop.call_soon_threadsafe(_queue_put, q, {"type": "close"})
        except RuntimeError:
            pass


def _verify_stream_agent(machine_id: str, raw_token: str) -> bool:
    """짧은 세션으로 검증만 하고 즉시 반환 (스트림이 DB 연결을 붙잡지 않도록)"""
    with SessionLocal() as db:
        agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
        return bool(
            agent
            and agent.status == "active"
            and raw_token
            and secrets.compare_digest(agent.token_hash, hash_token(raw_token))
        )


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
    global _DATA_DIR_WARNING
    _DATA_DIR_WARNING = secure_data_dir()
    accounts.init_accounts_db()
    threading.Thread(target=_startup_sequence, daemon=True).start()
    threading.Thread(target=_periodic_worker, daemon=True).start()
    threading.Thread(target=_presence_worker, daemon=True).start()
    print("=" * 60)
    print("  AURORA Endpoint Control Server 가동됨")
    print(f"  주소: http://{SERVER_CONFIG['host']}:{SERVER_CONFIG['port']}  (설정: server_config.json)")
    if os.path.exists(accounts.INITIAL_PASSWORD_FILE):
        print(f"  최초 관리자 계정 정보: {accounts.INITIAL_PASSWORD_FILE}")
    print("=" * 60)
    yield


app = FastAPI(title="AURORA Endpoint Control API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 프로그램 배포 API (SPA 기본 경로보다 먼저 등록해야 함)
app.include_router(packages.router)


# ==========================================
# 0. 상태 확인 (로그인 전/후 공용)
# ==========================================
@app.get("/api/health")
def health():
    st = get_status()
    return {"ok": True, "ready": st["ready"]}


# ==========================================
# 1. 에이전트 통신 API (무인 등록, 체크인, 실시간 스트림, 종료 보고)
# ==========================================

@app.post("/api/agents/register", dependencies=[Depends(require_ready)])
def register_agent(req: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    """에이전트 PC가 자체 생성한 토큰 + PC이름 + OS버전을 전송해 등록 요청 (승인 대기 중 15초마다 반복)"""
    t_hash = hash_token(req.agent_token)
    preview = f"{req.agent_token[:6]}...{req.agent_token[-4:]}" if len(req.agent_token) > 10 else "***"
    ip = client_ip(request)

    agent = db.query(Agent).filter(Agent.machine_id == req.machine_id).first()
    if agent:
        if agent.status == "rejected":
            agent.last_seen = time.time()  # 거부 목록에서도 '응답 중'인지 확인할 수 있도록 갱신
            agent.ip = ip
            db.commit()
            raise HTTPException(status_code=403, detail="관리자에 의해 등록이 거부된 PC입니다.")
        if agent.status == "active" and agent.token_hash == t_hash:
            agent.last_seen = time.time()
            agent.ip = ip
            db.commit()
            # 서버 서명 공개키: 에이전트가 처음 받은 값을 고정해 프로그램 배포 명령 검증에 사용
            return {"status": "active", "ring": agent.ring, "signing_pubkey": packages.public_key_b64()}
        if agent.status == "pending" and agent.token_hash == t_hash:
            # 승인 대기 중 주기적 재요청: 응답 시각만 갱신 (승인 시 '통신 확인'에 사용)
            agent.last_seen = time.time()
            agent.ip = ip
            agent.hostname = req.hostname
            db.commit()
            return {"status": "pending", "message": "콘솔 관리자의 승인을 기다리는 중입니다."}

        was_active = agent.status == "active"
        agent.hostname = req.hostname
        agent.os_name = req.os_name
        agent.os_build = req.os_build
        agent.ip = ip
        agent.token_hash = t_hash
        agent.token_preview = preview
        agent.agent_ver = req.agent_ver
        agent.status = "pending"
        agent.last_seen = time.time()
        log_event(db, req.hostname, f"에이전트 재등록 요청 (토큰: {preview})")
        notify_console(
            db, "warn" if was_active else "info", "register",
            f"재등록 요청: {req.hostname}",
            "등록된 PC가 새 토큰으로 재등록을 요청했습니다. 본인 PC가 맞는지 확인 후 승인하세요."
            if was_active else "승인 대기 PC 목록에서 확인하세요.",
            req.machine_id,
        )
        if was_active:
            close_agent_stream(req.machine_id)
    else:
        agent = Agent(
            machine_id=req.machine_id,
            hostname=req.hostname,
            ip=ip,
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
        notify_console(db, "info", "register", f"신규 PC 등록 요청: {req.hostname}",
                       f"{req.os_name} / {req.os_build} · {ip}", req.machine_id)

    db.commit()
    return {"status": "pending", "message": "콘솔 관리자의 승인을 기다리는 중입니다."}


def _hist_key(h: dict) -> tuple:
    return (h.get("id") or h.get("kb") or h.get("title") or "", h.get("date") or "", h.get("op"))


def _fmt_duration(sec: float) -> str:
    sec = int(max(0, sec))
    if sec < 120:
        return f"{sec}초"
    if sec < 7200:
        return f"{sec // 60}분"
    if sec < 172800:
        return f"{sec // 3600}시간"
    return f"{sec // 86400}일"


def _track_reconnect(db: Session, agent: Agent, req: CheckinRequest, now: float):
    """체크인 시 재연결/재부팅 여부를 판별해 이벤트·알림을 남긴다 (콘솔 자동 재연결 확인)"""
    prev_seen = agent.last_seen or 0
    prev_boot = agent.boot_ts
    was_offline = now - prev_seen > ONLINE_WINDOW_SEC
    rebooted = bool(req.boot_ts and prev_boot and req.boot_ts - prev_boot > 60)

    if req.boot_ts:
        agent.boot_ts = req.boot_ts
    if req.service_started_at:
        agent.service_started_at = req.service_started_at

    if agent.reconnect_watch_since and (
        (req.boot_ts and req.boot_ts > agent.reconnect_watch_since - 5) or req.first_checkin
    ):
        notify_console(
            db, "info", "agent", f"재부팅 후 재연결 완료: {agent.hostname}",
            f"재부팅 명령 후 {_fmt_duration(now - agent.reconnect_watch_since)} 만에 다시 연결되었습니다.",
            agent.machine_id,
        )
        agent.reconnect_watch_since = None
        agent.reconnect_watch_until = None

    if req.first_checkin or was_offline:
        reason = "PC 부팅 후" if rebooted else ("에이전트 서비스 재시작 후" if req.first_checkin else "네트워크 복구 후")
        gap = f" (오프라인 {_fmt_duration(now - prev_seen)})" if prev_seen and was_offline else ""
        log_event(db, req.hostname or agent.hostname, f"재연결됨: {reason}{gap}")


def _merge_history(stored: list, incoming: list, replace: bool) -> list:
    """설치(op=1)/제거(op=2) 이력만 보관, 날짜 내림차순 최대 HISTORY_KEEP 건"""
    incoming = [h for h in incoming if h.get("op") in (1, 2)]
    merged = {} if replace else {_hist_key(h): h for h in stored}
    for h in incoming:
        merged[_hist_key(h)] = h
    return sorted(merged.values(), key=lambda h: h.get("date") or "", reverse=True)[:HISTORY_KEEP]


def _store_reg_changes(db: Session, agent: Agent, changes: list[dict]):
    added = 0
    for ch in changes[:200]:
        cid = str(ch.get("cid") or "")[:64]
        path = str(ch.get("path") or "")
        if not cid or not path.upper().startswith(POLICY_ROOT):
            continue
        if db.query(RegistryChange.id).filter(RegistryChange.cid == cid).first():
            continue
        db.add(
            RegistryChange(
                machine_id=agent.machine_id,
                cid=cid,
                ts=float(ch.get("ts") or time.time()),
                source=str(ch.get("source") or "policy")[:16],
                policy_hash=str(ch.get("policy_hash") or "")[:32],
                path=path[:512],
                name=str(ch.get("name") or "")[:256],
                op=str(ch.get("op") or "set")[:16],
                old_exists=bool(ch.get("old_exists")),
                old_type=ch.get("old_type"),
                old_value=json.dumps(ch.get("old_value"), ensure_ascii=False),
                new_exists=bool(ch.get("new_exists", True)),
                new_type=ch.get("new_type"),
                new_value=json.dumps(ch.get("new_value"), ensure_ascii=False),
            )
        )
        added += 1
    if added:
        db.flush()
        keep_ids = [
            r.id
            for r in db.query(RegistryChange.id)
            .filter(RegistryChange.machine_id == agent.machine_id)
            .order_by(RegistryChange.ts.desc())
            .limit(REGISTRY_CHANGE_KEEP)
            .all()
        ]
        db.query(RegistryChange).filter(
            RegistryChange.machine_id == agent.machine_id, ~RegistryChange.id.in_(keep_ids)
        ).delete(synchronize_session=False)


RESULT_CATEGORY = {"policy": "policy", "reg_rollback": "rollback", "security_check": "security"}
RESULT_TITLE = {
    "policy": "정책 적용 실패",
    "security_check": "에이전트 보안 점검 경고",
    "reg_rollback": "레지스트리 롤백",
    "update": "업데이트 작업 실패",
    "install_all": "업데이트 설치 실패",
    "single_kb": "KB 단독 작업 실패",
    "reboot": "원격 재부팅 실패",
    "shutdown": "원격 종료 실패",
    "history_full": "전체 이력 조회 실패",
}


@app.post("/api/agents/checkin", dependencies=[Depends(require_ready)])
def agent_checkin(
    req: CheckinRequest,
    request: Request,
    agent: Agent = Depends(verify_agent),
    db: Session = Depends(get_db),
):
    """승인된 에이전트의 정기/즉시 상태 보고 및 명령/정책 수신"""
    now = time.time()
    _track_reconnect(db, agent, req, now)
    agent.hostname = req.hostname
    if req.os_name:
        agent.os_name = req.os_name
    if req.os_build:
        agent.os_build = req.os_build
    agent.ip = client_ip(request)

    agent.last_seen = now
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

    if req.reg_changes:
        _store_reg_changes(db, agent, req.reg_changes)
    if req.software is not None:
        agent.software_json = json.dumps(req.software[:3000], ensure_ascii=False)
        agent.software_ts = now

    for r in req.results:
        rtype = str(r.get("type"))
        ok = bool(r.get("ok"))
        out = str(r.get("out", ""))
        log_event(db, agent.hostname, f"{'OK' if ok else 'FAIL'} [{rtype}]: {out}")

        if rtype == "reg_rollback" and r.get("ref"):
            ch = db.query(RegistryChange).filter(
                RegistryChange.id == int(r["ref"]), RegistryChange.machine_id == agent.machine_id
            ).first()
            if ch:
                ch.rollback_state = "done" if ok else "failed"
                ch.rollback_ts = now
                ch.rollback_msg = out[:256]
            notify_console(
                db, "info" if ok else "error", "rollback",
                f"{RESULT_TITLE['reg_rollback']} {'완료' if ok else '실패'}: {agent.hostname}", out, agent.machine_id,
            )
        elif not ok:
            notify_console(
                db, "error", RESULT_CATEGORY.get(rtype, "command"),
                f"{RESULT_TITLE.get(rtype, '명령 실행 실패')}: {agent.hostname}", out, agent.machine_id,
            )

    if req.updates is not None:
        agent.pend_json = json.dumps(req.updates, ensure_ascii=False)
        agent.upd_ts = now
    if req.history_full is not None:
        agent.hist_json = json.dumps(_merge_history([], req.history_full, replace=True), ensure_ascii=False)
        agent.hist_ts = now
    elif req.history is not None:
        stored = json.loads(agent.hist_json or "[]")
        agent.hist_json = json.dumps(_merge_history(stored, req.history[:30], replace=False), ensure_ascii=False)
        agent.hist_ts = now

    # 대기열 명령 전달 (오프라인 중 쌓인 명령은 부팅 후 첫 체크인에서 바로 전달)
    queued_cmds = (
        db.query(AgentCommand)
        .filter(AgentCommand.machine_id == agent.machine_id, AgentCommand.status == "queued")
        .order_by(AgentCommand.id.asc())
        .all()
    )
    commands_out = []
    for c in queued_cmds:
        waited = now - (c.created_at or now)
        if c.cmd_type == "reboot" and agent.boot_ts and agent.boot_ts > (c.created_at or 0):
            # 명령을 보낸 뒤 PC가 이미 꺼졌다 켜졌으므로 재부팅 목적이 달성됨 → 중복 재부팅 방지
            log_event(db, agent.hostname, "대기 중이던 재부팅 명령 생략 (명령 이후 이미 부팅됨)")
            db.delete(c)
            continue
        commands_out.append({"id": c.id, "type": c.cmd_type, "payload": json.loads(c.payload_json or "{}")})
        packages.on_command_delivered(db, c)
        if waited > ONLINE_WINDOW_SEC:
            log_event(db, agent.hostname, f"대기 명령 전달 [{c.cmd_type}] (보관 {_fmt_duration(waited)} 후 적용)")
        if c.cmd_type == "reboot":
            agent.reconnect_watch_since = now
            agent.reconnect_watch_until = now + RECONNECT_WATCH_SEC
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
        "signing_pubkey": packages.public_key_b64(),
    }


@app.get("/api/agent/stream")
async def agent_realtime_stream(
    machine_id: str,
    x_agent_token: str = Header(default=""),
):
    """승인된 에이전트와 상시 연결되는 실시간 정책/명령 푸시 채널"""
    if not get_status()["ready"]:
        raise HTTPException(status_code=503, detail="서버 준비 중")
    ok = await run_in_threadpool(_verify_stream_agent, machine_id, x_agent_token)
    if not ok:
        raise HTTPException(status_code=401, detail="미승인 또는 유효하지 않은 에이전트 토큰")

    old = AGENT_STREAMS.get(machine_id)
    if old:  # 같은 PC의 이전 연결은 종료
        close_agent_stream(machine_id)
    q: asyncio.Queue = asyncio.Queue(maxsize=8)
    AGENT_STREAMS[machine_id] = (asyncio.get_running_loop(), q)

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20.0)
                    if msg.get("type") == "close":
                        break
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            entry = AGENT_STREAMS.get(machine_id)
            if entry and entry[1] is q:
                AGENT_STREAMS.pop(machine_id, None)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/agent/shutdown", dependencies=[Depends(require_ready)])
def agent_shutdown_log(
    payload: dict,
    x_agent_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """트레이 완전 종료 시 감사 로그 기록 및 오프라인 전환"""
    machine_id = payload.get("machine_id", "unknown")
    reason = payload.get("reason", "관리자/사용자 트레이 완전 종료")
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()

    if agent and secrets.compare_digest(agent.token_hash, hash_token(x_agent_token)):
        agent.last_seen = 0
        log_event(db, agent.hostname, f"에이전트 완전 종료 보고 ({reason})")
        notify_console(db, "warn", "agent", f"에이전트 종료됨: {agent.hostname}", reason, machine_id)
        db.commit()
        close_agent_stream(machine_id)
    return {"ok": True}


# ==========================================
# 2. 관리자 로그인 / 계정
# ==========================================

@app.post("/api/auth/login", dependencies=[Depends(check_admin_ip)])
def login(req: LoginRequest, request: Request):
    ip = client_ip(request)
    ok, msg, must_change = accounts.authenticate(req.username, req.password, ip)
    write_access_log(req.username, ip, "login" if ok else "login_fail", ok, "" if ok else msg)
    if not ok:
        if accounts.is_locked_out(req.username, ip) and get_status()["ready"]:
            with SessionLocal() as db:
                notify_console(db, "warn", "security", "콘솔 로그인 잠금",
                               f"계정 '{req.username[:32]}' / {ip} 에서 로그인 실패가 반복되어 5분간 잠겼습니다.")
                db.commit()
        raise HTTPException(status_code=401, detail=msg)
    username = accounts.canonical_username(req.username)
    token = accounts.create_session(username, ip)
    _trigger_initial_scan()
    user = accounts.get_session_user(token) or {}
    return {"token": token, "username": username, "must_change": must_change, "role": user.get("role", "operator")}


@app.post("/api/auth/logout")
def logout(request: Request, user: dict = Depends(current_admin)):
    accounts.delete_session(user["token"])
    write_access_log(user["username"], client_ip(request), "logout", True)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: dict = Depends(current_admin)):
    return {"username": user["username"], "must_change": user["must_change"], "role": user.get("role", "operator")}


@app.post("/api/auth/password")
def change_password(req: PasswordChangeRequest, request: Request, user: dict = Depends(current_admin)):
    ok, msg = accounts.change_password(user["username"], req.current_password, req.new_password, user["token"])
    write_access_log(user["username"], client_ip(request), "password_change", ok, "" if ok else msg)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@app.get("/api/system/status")
def system_status(_: dict = Depends(current_admin)):
    """로그인 직후 로딩 화면용: DB 백업/마이그레이션 진행 상황"""
    st = get_status()
    st["backup_file"] = os.path.basename(st.get("backup_file") or "")
    return st


@app.post("/api/system/retry")
def system_retry(_: dict = Depends(current_admin)):
    """DB 준비 실패 시 로딩 화면의 [다시 시도] 버튼: 백업/마이그레이션을 처음부터 다시 실행"""
    st = get_status()
    if st["ready"]:
        return {"ok": True, "ready": True}
    if st["phase"] != "error":
        raise HTTPException(status_code=409, detail="이미 진행 중입니다.")
    threading.Thread(target=_startup_sequence, daemon=True).start()
    return {"ok": True}


# ==========================================
# 업데이트 검색: 에이전트는 스스로 주기 검색하지 않고, 콘솔이 요청할 때만 검색한다
# ==========================================
_initial_scan_lock = threading.Lock()
_initial_scan_done = False


def _scan_online_agents(db: Session, machine_ids: list[str] | None = None) -> tuple[list[str], list[str]]:
    """온라인 PC에만 '업데이트 검색' 명령 전달 (오프라인 PC는 대기열에 넣지 않음). (전달, 제외) 호스트명 반환"""
    q = db.query(Agent).filter(Agent.status == "active")
    if machine_ids:
        q = q.filter(Agent.machine_id.in_(machine_ids))
    sent, skipped, sent_ids = [], [], []
    for a in q.all():
        if not is_online(a):
            skipped.append(a.hostname)
            continue
        if _queue_command(db, a, "scan", {}) in ("sent", "duplicate"):
            sent.append(a.hostname)
            sent_ids.append(a.machine_id)
    db.commit()
    for mid in sent_ids:
        notify_agent_realtime(mid, "command")
    return sent, skipped


def _trigger_initial_scan():
    """콘솔 실행(서버 시작) 후 첫 로그인 때 1회: 온라인 PC 전체에 업데이트 검색 요청"""
    global _initial_scan_done
    with _initial_scan_lock:
        if _initial_scan_done:
            return
        _initial_scan_done = True

    def run():
        for _ in range(120):  # DB 준비(백업/마이그레이션) 완료까지 최대 2분 대기
            if get_status()["ready"]:
                break
            time.sleep(1)
        else:
            return
        try:
            with SessionLocal() as db:
                sent, skipped = _scan_online_agents(db)
                log_event(db, "console", f"콘솔 시작 시 업데이트 검색 요청 → 온라인 {len(sent)}대 (오프라인 {len(skipped)}대 제외)")
                db.commit()
        except Exception:
            pass

    threading.Thread(target=run, daemon=True).start()


@app.post("/api/scan", dependencies=ADMIN_DEPS)
def request_scan(req: ScanRequest, db: Session = Depends(get_db)):
    """[업데이트 다시 검색] 버튼: 업데이트 검색만 수행 (설치·규칙 적용 없음). machine_ids 를 비우면 온라인 PC 전체"""
    sent, skipped = _scan_online_agents(db, req.machine_ids or None)
    log_event(db, "console", f"업데이트 검색 요청 → 온라인 {len(sent)}대" + (f" (오프라인 {len(skipped)}대 제외)" if skipped else ""))
    db.commit()
    return {"ok": True, "sent": len(sent), "skipped": skipped}


# ==========================================
# 경량 상태 조회 (10초 주기): 온라인 판정 + 변경 감지
# ==========================================
@app.get("/api/presence", dependencies=ADMIN_DEPS)
def presence(db: Session = Depends(get_db)):
    """콘솔이 10초마다 호출하는 가벼운 응답.
    - last_seen: PC별 마지막 통신 시각 → 온라인/오프라인 표시를 10초 단위로 갱신
    - rev: 데이터 변경 지표. 값이 바뀌었을 때만 콘솔이 전체 상태(/api/state)를 다시 받는다
    """
    from sqlalchemy import func

    rows = db.query(Agent.machine_id, Agent.status, Agent.last_seen, Agent.upd_ts, Agent.hist_ts,
                    Agent.applied_hash, Agent.ring, Agent.reconnect_watch_since).all()
    sig = hashlib.sha1()
    last_seen = {}
    for r in rows:
        last_seen[r.machine_id] = r.last_seen
        sig.update(f"{r.machine_id}|{r.status}|{r.upd_ts}|{r.hist_ts}|{r.applied_hash}|{r.ring}|"
                   f"{bool(r.reconnect_watch_since)}".encode())
    max_event = db.query(func.max(EventLog.id)).scalar() or 0
    cmd_count = db.query(func.count(AgentCommand.id)).scalar() or 0
    notif_count = db.query(func.count(Notification.id)).scalar() or 0
    sig.update(f"{max_event}|{cmd_count}|{notif_count}".encode())
    return {
        "now": time.time(),
        "rev": sig.hexdigest()[:16],
        "last_seen": last_seen,
        "notification_count": notif_count,
        "online_sec": ONLINE_WINDOW_SEC,
    }


# ==========================================
# 콘솔 계정 관리 (관리자 권한 전용)
# ==========================================
ACCOUNT_DEPS = [Depends(require_ready)]


def _account_audit(actor: dict, request: Request, action: str, ok: bool, detail: str):
    write_access_log(actor["username"], client_ip(request), action, ok, detail)


@app.get("/api/accounts", dependencies=ACCOUNT_DEPS)
def list_accounts(_: dict = Depends(require_admin_role)):
    return accounts.list_accounts()


@app.post("/api/accounts", dependencies=ACCOUNT_DEPS)
def create_account(req: AccountCreateRequest, request: Request, actor: dict = Depends(require_admin_role)):
    ok, msg, temp = accounts.create_account(req.username, req.role, actor["username"], req.password)
    _account_audit(actor, request, "account_create", ok, f"{req.username.strip()[:32]} ({req.role})" + ("" if ok else f": {msg}"))
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    with SessionLocal() as db:
        notify_console(db, "info", "security", f"콘솔 계정 생성: {req.username.strip()}",
                       f"{actor['username']} 님이 {accounts.ROLE_LABEL[req.role]} 계정을 만들었습니다.")
        db.commit()
    return {"ok": True, "message": msg, "temp_password": temp}


@app.delete("/api/accounts/{username}", dependencies=ACCOUNT_DEPS)
def delete_account(username: str, request: Request, actor: dict = Depends(require_admin_role)):
    ok, msg = accounts.delete_account(username, actor["username"])
    _account_audit(actor, request, "account_delete", ok, username[:32] + ("" if ok else f": {msg}"))
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    with SessionLocal() as db:
        notify_console(db, "warn", "security", f"콘솔 계정 삭제: {username}", f"{actor['username']} 님이 삭제했습니다.")
        db.commit()
    return {"ok": True, "message": msg}


@app.post("/api/accounts/{username}/reset-password", dependencies=ACCOUNT_DEPS)
def reset_account_password(username: str, request: Request, actor: dict = Depends(require_admin_role)):
    if username.strip().lower() == actor["username"].lower():
        raise HTTPException(status_code=400, detail="본인 비밀번호는 위의 '비밀번호 변경'에서 바꾸세요.")
    ok, msg, temp = accounts.admin_reset_password(username)
    _account_audit(actor, request, "account_reset", ok, username[:32] + ("" if ok else f": {msg}"))
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg, "temp_password": temp}


@app.put("/api/accounts/{username}/role", dependencies=ACCOUNT_DEPS)
def change_account_role(username: str, req: AccountRoleRequest, request: Request,
                        actor: dict = Depends(require_admin_role)):
    ok, msg = accounts.set_role(username, req.role, actor["username"])
    _account_audit(actor, request, "account_role", ok, f"{username[:32]} → {req.role}" + ("" if ok else f": {msg}"))
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@app.get("/api/access-logs", dependencies=ADMIN_DEPS)
def list_access_logs(db: Session = Depends(get_db)):
    rows = db.query(AccessLog).order_by(AccessLog.id.desc()).limit(200).all()
    return [
        {"id": r.id, "ts": r.ts, "username": r.username, "ip": r.ip, "action": r.action, "ok": r.ok,
         "detail": r.detail}
        for r in rows
    ]


# ==========================================
# 3. 관리자 콘솔 API
# ==========================================

def _serialize_agent(a: Agent, pol_dict: dict, now: float) -> dict:
    pend = json.loads(a.pend_json or "[]")
    return {
        "machine_id": a.machine_id,
        "hostname": a.hostname,
        "ip": a.ip,
        "os_name": a.os_name,
        "os_build": a.os_build,
        "mac_addr": a.mac_addr or "-",
        "cpu_info": a.cpu_info or "-",
        "ram_gb": a.ram_gb or "-",
        "token_preview": a.token_preview,
        "status": a.status,
        "ring": a.ring,
        "last_seen": a.last_seen,
        "online": is_online(a, now),
        "alive": (now - (a.last_seen or 0)) < PENDING_ALIVE_SEC,
        "applied_hash": a.applied_hash,
        "target_hash": pol_dict.get(a.ring, {}).get("hash"),
        "reboot_required": a.reboot_required,
        "hotfix": a.hotfix,
        "agent_ver": a.agent_ver,
        "pend": pend,
        "upd_ts": a.upd_ts,
        # 이력 본문은 상세 모달(/api/agents/{id}/detail)에서만 조회
        "hist_count": len(json.loads(a.hist_json or "[]")),
        "queued_count": len(a.commands),
        "boot_ts": a.boot_ts,
        "reconnect_waiting": bool(a.reconnect_watch_since),
    }


@app.get("/api/state", dependencies=ADMIN_DEPS)
def get_dashboard_state(db: Session = Depends(get_db)):
    now = time.time()
    pol_dict = {}
    for p in db.query(Policy).all():
        items = json.loads(p.items_json or "[]")
        pol_dict[p.ring] = {"items": items, "hash": policy_hash(items)}

    raw_active = db.query(Agent).filter(Agent.status == "active").order_by(Agent.hostname).all()
    active_agents = [_serialize_agent(a, pol_dict, now) for a in raw_active]
    pending_agents = [
        _serialize_agent(a, pol_dict, now)
        for a in db.query(Agent).filter(Agent.status == "pending").order_by(Agent.last_seen.desc()).all()
    ]
    rejected_agents = [
        _serialize_agent(a, pol_dict, now)
        for a in db.query(Agent).filter(Agent.status == "rejected").order_by(Agent.hostname).all()
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
    installed_sets: list[set[str]] = []
    pending_sets: list[set[str]] = []
    for a in raw_active:
        inst = {t.strip().upper() for t in (a.hotfix or "").split(",") if t.strip()}
        for h in json.loads(a.hist_json or "[]"):
            if h.get("kb") and h.get("op") == 1 and h.get("rc") in (2, 3):
                inst.add(str(h["kb"]).upper())
        installed_sets.append(inst)
        pending_sets.append(
            {str(u.get("kb") or "").upper() for u in json.loads(a.pend_json or "[]") if u.get("kb")}
        )

    catalog_list = []
    for c in catalog_rows:
        kb = (c.kb or "").upper()
        catalog_list.append({
            "kb": c.kb,
            "title": c.title,
            "category": c.category,
            "summary": c.summary,
            "release_date": c.release_date,
            "source": c.source,
            "installed_count": sum(1 for s_ in installed_sets if kb in s_),
            "pending_count": sum(1 for s_ in pending_sets if kb in s_),
        })

    return {
        "now": now,
        "agents": active_agents,
        "pending_agents": pending_agents,
        "rejected_agents": rejected_agents,
        "policies": pol_dict,
        "rules": rules,
        "events": events,
        "catalog": catalog_list,
        "notification_count": db.query(Notification).count(),
        "defaults": {"target_release": DEFAULT_TARGET_RELEASE},
        "server": {"host": SERVER_CONFIG["host"], "port": SERVER_CONFIG["port"]},
        "limits": {"online_sec": ONLINE_WINDOW_SEC, "pending_alive_sec": PENDING_ALIVE_SEC,
                   "retention_days": RETENTION_DAYS, "history_keep": HISTORY_KEEP},
    }


def _get_agent_or_404(db: Session, machine_id: str) -> Agent:
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="대상 PC를 찾을 수 없습니다.")
    return agent


@app.get("/api/agents/{machine_id}/detail", dependencies=ADMIN_DEPS)
def agent_detail(machine_id: str, db: Session = Depends(get_db)):
    """상세 모달 전용: 업데이트 이력(최대 100건) + 레지스트리 변경 이력"""
    agent = _get_agent_or_404(db, machine_id)
    changes = (
        db.query(RegistryChange)
        .filter(RegistryChange.machine_id == machine_id)
        .order_by(RegistryChange.ts.desc())
        .limit(100)
        .all()
    )
    return {
        "machine_id": agent.machine_id,
        "online": is_online(agent),
        "hist": json.loads(agent.hist_json or "[]")[:HISTORY_KEEP],
        "hist_ts": agent.hist_ts,
        "boot_ts": agent.boot_ts,
        "reconnect_waiting": bool(agent.reconnect_watch_since),
        "queued_commands": [
            {
                "id": c.id, "type": c.cmd_type, "label": CMD_LABEL.get(c.cmd_type, c.cmd_type),
                "payload": json.loads(c.payload_json or "{}"), "created_at": c.created_at,
            }
            for c in sorted(agent.commands, key=lambda x: x.id)
        ],
        "deployments": packages.agent_deployments(db, machine_id),
        "registry_changes": [
            {
                "id": c.id, "ts": c.ts, "source": c.source, "policy_hash": c.policy_hash,
                "path": c.path, "name": c.name, "op": c.op,
                "old_exists": c.old_exists, "old_type": c.old_type, "old_value": json.loads(c.old_value or "null"),
                "new_exists": c.new_exists, "new_type": c.new_type, "new_value": json.loads(c.new_value or "null"),
                "rollback_state": c.rollback_state, "rollback_ts": c.rollback_ts, "rollback_msg": c.rollback_msg,
            }
            for c in changes
        ],
    }


def _queue_command(db: Session, agent: Agent, cmd_type: str, payload: dict) -> str:
    """명령 적재. 반환값: 'sent'(온라인, 즉시 전달) | 'queued'(오프라인, 다음 부팅 시 적용) | 'duplicate' | 'inactive'

    오프라인 PC의 명령은 대기열에 보관했다가 PC가 켜져 첫 체크인할 때 바로 전달한다.
    같은 명령(종류+내용)이 이미 대기 중이면 중복으로 쌓지 않는다.
    """
    if agent.status != "active":
        return "inactive"
    payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    dup = (
        db.query(AgentCommand.id)
        .filter(
            AgentCommand.machine_id == agent.machine_id,
            AgentCommand.status == "queued",
            AgentCommand.cmd_type == cmd_type,
            AgentCommand.payload_json == payload_json,
        )
        .first()
    )
    if dup:
        return "duplicate"
    db.add(AgentCommand(machine_id=agent.machine_id, cmd_type=cmd_type, payload_json=payload_json,
                        created_at=time.time()))
    return "sent" if is_online(agent) else "queued"


@app.post("/api/agents/{machine_id}/history/refresh", dependencies=ADMIN_DEPS)
def refresh_history(machine_id: str, db: Session = Depends(get_db)):
    """상세 모달을 열 때 호출: 에이전트에 전체 설치/제거 이력(최대 100건) 재보고 요청"""
    agent = _get_agent_or_404(db, machine_id)
    # 전체 이력 요청은 지금 열어 둔 모달을 위한 것이므로 온라인일 때만 보낸다
    queued = is_online(agent) and _queue_command(db, agent, "report_history", {}) in ("sent", "duplicate")
    db.commit()
    if queued:
        notify_agent_realtime(machine_id, "command")
    return {"ok": True, "queued": queued}


@app.post("/api/agents/{machine_id}/registry/{change_id}/rollback", dependencies=ADMIN_DEPS)
def rollback_registry_change(machine_id: str, change_id: int, db: Session = Depends(get_db)):
    agent = _get_agent_or_404(db, machine_id)
    ch = db.query(RegistryChange).filter(
        RegistryChange.id == change_id, RegistryChange.machine_id == machine_id
    ).first()
    if not ch:
        raise HTTPException(status_code=404, detail="변경 이력을 찾을 수 없습니다.")
    if not ch.path.upper().startswith(POLICY_ROOT):
        raise HTTPException(status_code=400, detail="허용되지 않은 레지스트리 경로입니다.")
    if ch.rollback_state == "requested":
        raise HTTPException(status_code=409, detail="이미 롤백을 요청한 항목입니다.")
    payload = {
        "ref": ch.id,
        "path": ch.path,
        "name": ch.name,
        "restore_exists": ch.old_exists,
        "restore_type": ch.old_type,
        "restore_value": json.loads(ch.old_value or "null"),
    }
    result = _queue_command(db, agent, "reg_rollback", payload)
    if result == "inactive":
        raise HTTPException(status_code=409, detail="관리 중(승인된) PC가 아니라 롤백할 수 없습니다.")
    ch.rollback_state = "requested"
    ch.rollback_ts = time.time()
    ch.rollback_msg = "PC가 오프라인이라 다음 부팅 시 적용됩니다." if result == "queued" else ""
    log_event(db, "console", f"레지스트리 롤백 요청: {agent.hostname} {ch.path}\\{ch.name}")
    db.commit()
    notify_agent_realtime(machine_id, "command")
    return {"ok": True, "queued": result == "queued"}


CMD_LABEL = {
    "scan": "업데이트 스캔", "install_all": "차단 외 일괄 설치", "install_kb": "KB 단독 설치",
    "hide_kb": "KB 숨기기", "unhide_kb": "KB 숨김 해제", "reboot": "재부팅", "shutdown": "전원 종료",
    "report_history": "전체 이력 보고", "reg_rollback": "레지스트리 롤백",
    "pkg_install": "프로그램 설치", "pkg_uninstall": "프로그램 삭제",
}


@app.delete("/api/agents/{machine_id}/commands/{command_id}", dependencies=ADMIN_DEPS)
def cancel_queued_command(machine_id: str, command_id: int, db: Session = Depends(get_db)):
    """다음 부팅 시 적용 예정인 대기 명령 취소"""
    agent = _get_agent_or_404(db, machine_id)
    c = db.query(AgentCommand).filter(
        AgentCommand.id == command_id, AgentCommand.machine_id == machine_id
    ).first()
    if not c:
        raise HTTPException(status_code=404, detail="이미 전달되었거나 존재하지 않는 명령입니다.")
    if c.cmd_type == "reg_rollback":
        ref = json.loads(c.payload_json or "{}").get("ref")
        ch = db.query(RegistryChange).filter(RegistryChange.id == ref).first() if ref else None
        if ch and ch.rollback_state == "requested":
            ch.rollback_state = ""
            ch.rollback_msg = "롤백 요청 취소됨"
    packages.on_command_cancelled(db, c)
    db.delete(c)
    log_event(db, "console", f"대기 명령 취소 [{CMD_LABEL.get(c.cmd_type, c.cmd_type)}] → {agent.hostname}")
    db.commit()
    return {"ok": True}


@app.get("/api/notifications", dependencies=ADMIN_DEPS)
def list_notifications(db: Session = Depends(get_db)):
    rows = db.query(Notification).order_by(Notification.id.desc()).limit(300).all()
    return [
        {"id": n.id, "ts": n.ts, "level": n.level, "category": n.category, "title": n.title,
         "message": n.message, "machine_id": n.machine_id}
        for n in rows
    ]


@app.post("/api/notifications/ack", dependencies=ADMIN_DEPS)
def ack_notifications(payload: dict, db: Session = Depends(get_db)):
    """확인한 알림은 보관하지 않고 즉시 삭제 (ids 미지정 시 전체 확인)"""
    ids = payload.get("ids")
    q = db.query(Notification)
    if ids:
        q = q.filter(Notification.id.in_([int(i) for i in ids]))
    removed = q.delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "removed": removed}


@app.post("/api/catalog/sync", dependencies=ADMIN_DEPS)
def trigger_catalog_sync(db: Session = Depends(get_db)):
    added = sync_catalog_database(db, fetch_online=True)
    log_event(db, "console", f"Windows 11 업데이트 카탈로그 동기화 완료 (신규 {added}건)")
    db.commit()
    return {"ok": True, "added": added}


@app.post("/api/agents/{machine_id}/decision", dependencies=ADMIN_DEPS)
def decide_pending_agent(machine_id: str, req: DecisionRequest, db: Session = Depends(get_db)):
    agent = _get_agent_or_404(db, machine_id)

    if req.approve:
        # 승인 전 통신 확인: 승인 대기 중인 에이전트는 15초마다 등록 요청을 보내므로
        # 최근 PENDING_ALIVE_SEC 이내에 요청이 없으면 에이전트가 응답하지 않는 것으로 판단
        if time.time() - (agent.last_seen or 0) > PENDING_ALIVE_SEC:
            raise HTTPException(
                status_code=409,
                detail=f"{agent.hostname} 에이전트의 응답이 없습니다. PC 전원과 에이전트 서비스 상태를 확인한 뒤 다시 시도하세요.",
            )
        agent.status = "active"
        agent.ring = req.ring
        db.add(AgentCommand(machine_id=agent.machine_id, cmd_type="scan", payload_json="{}", created_at=time.time()))
        log_event(db, "console", f"에이전트 승인 완료: {agent.hostname} ({req.ring})")
    else:
        agent.status = "rejected"
        log_event(db, "console", f"에이전트 등록 거부됨: {agent.hostname}")

    db.commit()
    if req.approve:
        notify_agent_realtime(machine_id, "approved")
    else:
        close_agent_stream(machine_id)
    return {"ok": True}


@app.post("/api/agents/{machine_id}/unreject", dependencies=ADMIN_DEPS)
def unreject_agent(machine_id: str, db: Session = Depends(get_db)):
    """거부 PC 목록에서 제거 → 승인 대기로 되돌림 (에이전트의 다음 등록 요청부터 '응답 확인됨'으로 표시)"""
    agent = _get_agent_or_404(db, machine_id)
    if agent.status != "rejected":
        raise HTTPException(status_code=400, detail="거부 상태인 PC가 아닙니다.")
    agent.status = "pending"
    log_event(db, "console", f"거부 해제 → 승인 대기 전환: {agent.hostname}")
    db.commit()
    return {"ok": True}


@app.post("/api/agents/{machine_id}/revoke", dependencies=ADMIN_DEPS)
def revoke_agent_token(machine_id: str, db: Session = Depends(get_db)):
    agent = _get_agent_or_404(db, machine_id)
    agent.status = "pending"
    agent.token_hash = "REVOKED"
    log_event(db, "console", f"토큰 폐기 및 재인증 대기 전환: {agent.hostname}")
    db.commit()
    close_agent_stream(machine_id)
    return {"ok": True}


@app.delete("/api/agents/{machine_id}", dependencies=ADMIN_DEPS)
def delete_agent(machine_id: str, db: Session = Depends(get_db)):
    agent = _get_agent_or_404(db, machine_id)
    hostname = agent.hostname
    db.query(AgentCommand).filter(AgentCommand.machine_id == machine_id).delete()
    db.query(RegistryChange).filter(RegistryChange.machine_id == machine_id).delete()
    db.delete(agent)
    log_event(db, "console", f"관리 대상 PC 영구 삭제 완료: {hostname} ({machine_id})")
    db.commit()
    close_agent_stream(machine_id)
    return {"ok": True}


@app.post("/api/agents/{machine_id}/ring", dependencies=ADMIN_DEPS)
def change_agent_ring(machine_id: str, req: RingChangeRequest, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.machine_id == machine_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="대상 PC를 찾을 수 없습니다.")
    agent.ring = req.ring
    log_event(db, "console", f"{agent.hostname} 링 변경 → {req.ring}")
    db.commit()
    notify_agent_realtime(machine_id, "policy")
    return {"ok": True}


@app.post("/api/policies", dependencies=ADMIN_DEPS)
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


@app.post("/api/rings", dependencies=ADMIN_DEPS)
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


@app.delete("/api/rings/{ring_name}", dependencies=ADMIN_DEPS)
def delete_ring(ring_name: str, db: Session = Depends(get_db)):
    if ring_name in ("ring0", "ring1"):
        raise HTTPException(status_code=400, detail="기본 링(ring0, ring1)은 삭제할 수 없습니다.")

    db.query(Agent).filter(Agent.ring == ring_name).update({"ring": "ring1"})
    db.query(KbRule).filter(KbRule.ring == ring_name).delete()
    db.query(Policy).filter(Policy.ring == ring_name).delete()

    log_event(db, "console", f"배포 링 삭제 완료: {ring_name} (소속 PC → ring1 이동)")
    db.commit()
    return {"ok": True}


@app.put("/api/rings/{old_ring}", dependencies=ADMIN_DEPS)
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


@app.post("/api/rules", dependencies=ADMIN_DEPS)
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




VALID_COMMANDS = {"scan", "install_all", "install_kb", "hide_kb", "unhide_kb", "reboot", "shutdown"}


@app.post("/api/commands", dependencies=ADMIN_DEPS)
def dispatch_commands(req: CommandRequest, db: Session = Depends(get_db)):
    """온라인 PC는 즉시 전달, 오프라인 PC는 대기열에 보관했다가 다음 부팅(재연결) 시 바로 적용"""
    if req.type not in VALID_COMMANDS:
        raise HTTPException(status_code=400, detail="지원하지 않는 명령 유형입니다.")

    dispatched_ids, queued, duplicate = [], [], []
    for mid in req.machine_ids:
        agent = db.query(Agent).filter(Agent.machine_id == mid, Agent.status == "active").first()
        if not agent:
            continue
        result = _queue_command(db, agent, req.type, req.payload)
        if result == "sent":
            dispatched_ids.append(mid)
        elif result == "queued":
            # 재부팅을 예약한 경우: 다음 부팅으로 목적이 달성되므로 부팅 시 실제 재부팅은 생략됨
            queued.append(agent.hostname)
        elif result == "duplicate":
            duplicate.append(agent.hostname)

    detail = f" ({req.payload.get('kb')})" if req.payload.get("kb") else ""
    msg = f"명령 전송 [{req.type}{detail}] → 즉시 {len(dispatched_ids)}대"
    if queued:
        msg += f" / 다음 부팅 시 적용 {len(queued)}대: {', '.join(queued[:10])}{' 외' if len(queued) > 10 else ''}"
    if duplicate:
        msg += f" / 이미 대기 중 {len(duplicate)}대"
    log_event(db, "console", msg)
    db.commit()
    for mid in dispatched_ids:
        notify_agent_realtime(mid, "command")
    return {"ok": True, "dispatched": len(dispatched_ids), "queued": queued, "duplicate": duplicate,
            "skipped": []}



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