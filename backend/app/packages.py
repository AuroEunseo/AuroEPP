"""사내 공용 프로그램 배포

흐름
 1) 관리자가 설치 파일(.msi/.exe)을 업로드 → 서버가 SHA-256 을 계산해 packages/ 에 보관
 2) 관리자·운영자가 대상 PC를 골라 설치/삭제 요청 → PC별 배포 기록(PackageDeployment) + 명령 대기열 적재
    (온라인 PC는 즉시, 꺼진 PC는 다음 부팅 시 전달 — 기존 명령 대기열과 동일)
 3) 에이전트가 명령의 '서버 서명'을 검증한 뒤 파일을 받아 해시를 확인하고 백그라운드로 무인 설치
 4) 진행 상황(다운로드 %, 설치 중, 성공/실패, 종료 코드)을 /api/agent/progress 로 즉시 보고

위변조 방지 (서버 서명 키 고정)
 - 서버는 처음 실행 시 Ed25519 서명 키(signing.key, Windows DPAPI 보호)를 만든다.
 - 에이전트는 처음 연결될 때 공개키를 받아 저장하고 이후 바꾸지 않는다(최초 신뢰).
 - 설치·삭제 명령의 내용(파일 해시·크기·실행 옵션·대상 PC)은 모두 서명되며,
   에이전트는 서명이 맞지 않거나 다른 PC 대상이면 실행하지 않는다.
 - 따라서 HTTP 평문이어도 중간에서 파일이나 명령을 바꿔치기할 수 없다.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
import urllib.parse

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .database import BASE_DIR, get_db
from .keystore import load_or_create
from .models import Agent, AgentCommand, PackageDeployment, SoftwarePackage
from .schemas import (DeployRequest, PackageCreateRequest, PackageUpdateRequest, ProgressReport, RejectRequest,
                      SelfInstallRequest)
from .security import require_admin_role, require_ready, verify_admin, verify_agent
from .settings import DEPLOY_KEEP_DAYS, PACKAGE_MAX_BYTES

PACKAGE_DIR = os.path.join(BASE_DIR, "packages")
UPLOAD_DIR = os.path.join(PACKAGE_DIR, "_uploads")
SIGNING_KEY_FILE = os.path.join(BASE_DIR, "signing.key")
ALLOWED_EXT = {".msi": "msi", ".exe": "exe"}
ICON_DIR = os.path.join(PACKAGE_DIR, "icons")
ICON_MAX_BYTES = 128 * 1024
ICON_TYPES = {b"\x89PNG\r\n\x1a\n": ("png", "image/png"), b"\x00\x00\x01\x00": ("ico", "image/x-icon")}
ACTIVE_STATES = ("queued", "sent", "downloading", "installing", "uninstalling")  # 설치 파일 다운로드 허용 상태
BUSY_STATES = ACTIVE_STATES + ("requested",)  # 같은 PC·프로그램에 새 요청을 받지 않는 상태
TERMINAL_STATES = ("success", "failed", "cancelled", "rejected")
SELF_PREFIX = "셀프 설치"
SELF_RATE_PER_HOUR = 20  # PC 1대가 1시간에 보낼 수 있는 셀프 설치 요청 수
# 설치 센터(요청한 PC 자신)에 보여줄 이름: 요청한 PC는 켜져 있으므로 'PC 꺼짐' 대신 준비 중으로 표시
SELF_LABEL = {"queued": "설치 준비 중", "sent": "설치 준비 중"}
STATUS_LABEL = {
    "requested": "승인 대기", "rejected": "거절됨",
    "queued": "대기 (PC 꺼짐)", "sent": "전달됨", "downloading": "다운로드 중", "installing": "설치 중",
    "uninstalling": "삭제 중", "success": "완료", "failed": "실패", "cancelled": "취소됨",
}

router = APIRouter()


def _main():
    """main.py 의 공용 도우미(로그·알림·실시간 푸시) 사용 (순환 import 방지를 위해 호출 시점에 가져옴)"""
    from . import main as m

    return m


# ==========================================================
# 서명 키
# ==========================================================
_signing_key: Ed25519PrivateKey | None = None
_sign_lock = threading.Lock()


def _private_key() -> Ed25519PrivateKey:
    global _signing_key
    with _sign_lock:
        if _signing_key is None:
            raw = load_or_create(SIGNING_KEY_FILE, lambda: secrets.token_bytes(32))
            _signing_key = Ed25519PrivateKey.from_private_bytes(raw)
    return _signing_key


def public_key_b64() -> str:
    pub = _private_key().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.b64encode(pub).decode("ascii")


def sign_payload(data: dict) -> dict:
    """서명 대상 JSON 바이트 자체를 함께 보내므로 에이전트는 재직렬화 없이 그대로 검증한다"""
    blob = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sig = _private_key().sign(blob)
    return {"signed": base64.b64encode(blob).decode("ascii"), "sig": base64.b64encode(sig).decode("ascii")}


# ==========================================================
# 업로드 (python-multipart 없이 파일 본문을 그대로 스트리밍 수신)
# ==========================================================
_uploads: dict[str, dict] = {}
_upload_lock = threading.Lock()


def _cleanup_uploads(max_age: float = 3600):
    now = time.time()
    with _upload_lock:
        for uid, u in list(_uploads.items()):
            if now - u["created"] > max_age:
                try:
                    os.remove(u["path"])
                except OSError:
                    pass
                _uploads.pop(uid, None)


def _safe_filename(name: str) -> str:
    name = os.path.basename(urllib.parse.unquote(name or "")).strip()
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    return name[:200]


@router.post("/api/packages/upload", dependencies=[Depends(require_ready)])
async def upload_package_file(
    request: Request,
    x_file_name: str = Header(default=""),
    _: dict = Depends(require_admin_role),
):
    """1단계: 설치 파일 업로드 → upload_id 발급 (메타 정보 등록은 POST /api/packages)"""
    filename = _safe_filename(x_file_name)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail="설치 파일은 .msi 또는 .exe 만 올릴 수 있습니다.")
    length = int(request.headers.get("content-length") or 0)
    if length > PACKAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"파일이 너무 큽니다 (최대 {PACKAGE_MAX_BYTES // 1024**3}GB).")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    if length and shutil.disk_usage(UPLOAD_DIR).free < length + 1024**3:
        raise HTTPException(status_code=507, detail="서버 디스크 여유 공간이 부족합니다.")
    _cleanup_uploads()

    uid = secrets.token_hex(12)
    path = os.path.join(UPLOAD_DIR, uid + ".part")
    h = hashlib.sha256()
    size = 0
    try:
        with open(path, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > PACKAGE_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다.")
                h.update(chunk)
                f.write(chunk)
    except BaseException:
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    if size == 0:
        os.remove(path)
        raise HTTPException(status_code=400, detail="빈 파일입니다.")
    info = {"path": path, "filename": filename, "size": size, "sha256": h.hexdigest(), "kind": ALLOWED_EXT[ext],
            "created": time.time()}
    with _upload_lock:
        _uploads[uid] = info
    return {"upload_id": uid, "filename": filename, "size": size, "sha256": info["sha256"], "kind": info["kind"]}


# ==========================================================
# 설치 여부 확인 (에이전트가 보고한 '프로그램 추가/제거' 목록과 비교)
# ==========================================================
def detect(pkg: SoftwarePackage, software: list[dict]) -> tuple[bool, str]:
    key = (pkg.detect_name or pkg.name or "").strip().lower()
    if not key:
        return False, ""
    for s in software:
        if key in str(s.get("name", "")).lower():
            return True, str(s.get("version", ""))
    return False, ""


def _software(agent: Agent) -> list[dict]:
    try:
        return json.loads(agent.software_json or "[]")
    except ValueError:
        return []


def _serialize_pkg(p: SoftwarePackage, agents: list[Agent] | None = None) -> dict:
    d = {
        "id": p.id, "name": p.name, "version": p.version, "publisher": p.publisher, "filename": p.filename,
        "size": p.size, "sha256": p.sha256, "kind": p.kind, "install_args": p.install_args,
        "uninstall_cmd": p.uninstall_cmd, "detect_name": p.detect_name, "timeout_min": p.timeout_min,
        "notes": p.notes, "created_by": p.created_by, "created_at": p.created_at, "updated_at": p.updated_at,
        "description": p.description or "", "self_service": bool(p.self_service), "self_approval": bool(p.self_approval),
        "has_icon": bool(p.icon_type), "icon_rev": p.icon_rev or 0,
    }
    if agents is not None:
        latest = _latest_deployments(p)
        d["installed_count"] = sum(1 for a in agents if detect(p, _software(a))[0])
        d["active_count"] = sum(1 for dep in latest.values() if dep.status in ACTIVE_STATES)
        d["failed_count"] = sum(1 for dep in latest.values() if dep.status == "failed")
        d["requested_count"] = sum(1 for dep in latest.values() if dep.status == "requested")
    return d


def _latest_deployments(p: SoftwarePackage) -> dict[str, PackageDeployment]:
    latest: dict[str, PackageDeployment] = {}
    for dep in sorted(p.deployments, key=lambda x: x.id):
        latest[dep.machine_id] = dep
    return latest


def _serialize_dep(d: PackageDeployment) -> dict:
    return {
        "id": d.id, "package_id": d.package_id, "machine_id": d.machine_id, "action": d.action,
        "status": d.status, "status_label": STATUS_LABEL.get(d.status, d.status), "progress": d.progress,
        "exit_code": d.exit_code, "message": d.message, "requested_by": d.requested_by,
        "created_at": d.created_at, "updated_at": d.updated_at,
        "package_name": d.package.name if d.package else "", "package_version": d.package.version if d.package else "",
        "hostname": d.agent.hostname if d.agent else "",
    }


def _get_pkg(db: Session, pid: int) -> SoftwarePackage:
    p = db.query(SoftwarePackage).filter(SoftwarePackage.id == pid).first()
    if not p:
        raise HTTPException(status_code=404, detail="프로그램을 찾을 수 없습니다.")
    return p


# ==========================================================
# 콘솔 API
# ==========================================================
ADMIN_DEPS = [Depends(verify_admin), Depends(require_ready)]


@router.get("/api/packages", dependencies=ADMIN_DEPS)
def list_packages(db: Session = Depends(get_db)):
    agents = db.query(Agent).filter(Agent.status == "active").all()
    pkgs = db.query(SoftwarePackage).order_by(SoftwarePackage.name, SoftwarePackage.id.desc()).all()
    return {"packages": [_serialize_pkg(p, agents) for p in pkgs], "signing_key": public_key_b64()[:12]}


def _validate_meta(req) -> None:
    if not (req.name or "").strip():
        raise HTTPException(status_code=400, detail="프로그램 이름을 입력하세요.")
    if not 1 <= int(req.timeout_min) <= 240:
        raise HTTPException(status_code=400, detail="설치 제한 시간은 1~240분 사이로 입력하세요.")


@router.post("/api/packages", dependencies=[Depends(require_ready)])
def create_package(req: PackageCreateRequest, db: Session = Depends(get_db),
                   actor: dict = Depends(require_admin_role)):
    """2단계: 업로드한 파일에 이름·버전·무인 설치 옵션을 붙여 프로그램으로 등록"""
    _validate_meta(req)
    with _upload_lock:
        up = _uploads.pop(req.upload_id, None)
    if not up or not os.path.exists(up["path"]):
        raise HTTPException(status_code=400, detail="업로드한 파일을 찾을 수 없습니다. 다시 올려 주세요.")
    dup = db.query(SoftwarePackage).filter(SoftwarePackage.sha256 == up["sha256"]).first()
    if dup:
        os.remove(up["path"])
        raise HTTPException(status_code=400, detail=f"같은 파일이 이미 '{dup.name} {dup.version}'(으)로 등록되어 있습니다.")
    stored = f"{up['sha256'][:16]}_{secrets.token_hex(4)}.{up['kind']}"
    os.makedirs(PACKAGE_DIR, exist_ok=True)
    os.replace(up["path"], os.path.join(PACKAGE_DIR, stored))
    now = time.time()
    p = SoftwarePackage(
        name=req.name.strip()[:128], version=req.version.strip()[:64], publisher=req.publisher.strip()[:128],
        filename=up["filename"], stored_name=stored, size=up["size"], sha256=up["sha256"], kind=up["kind"],
        install_args=req.install_args.strip()[:512], uninstall_cmd=req.uninstall_cmd.strip()[:1024],
        detect_name=(req.detect_name.strip() or req.name.strip())[:256], timeout_min=int(req.timeout_min),
        notes=req.notes[:2000], description=req.description.strip()[:500], self_service=bool(req.self_service),
        self_approval=bool(req.self_approval), created_by=actor["username"], created_at=now, updated_at=now,
    )
    db.add(p)
    _main().log_event(db, "console", f"프로그램 등록: {p.name} {p.version} ({p.filename}, {p.size:,} bytes) by {actor['username']}")
    db.commit()
    return {"ok": True, "id": p.id}


@router.put("/api/packages/{pid}", dependencies=[Depends(require_ready)])
def update_package(pid: int, req: PackageUpdateRequest, db: Session = Depends(get_db),
                   actor: dict = Depends(require_admin_role)):
    _validate_meta(req)
    p = _get_pkg(db, pid)
    p.name = req.name.strip()[:128]
    p.version = req.version.strip()[:64]
    p.publisher = req.publisher.strip()[:128]
    p.install_args = req.install_args.strip()[:512]
    p.uninstall_cmd = req.uninstall_cmd.strip()[:1024]
    p.detect_name = (req.detect_name.strip() or p.name)[:256]
    p.timeout_min = int(req.timeout_min)
    p.notes = req.notes[:2000]
    p.description = req.description.strip()[:500]
    p.self_service = bool(req.self_service)
    p.self_approval = bool(req.self_approval)
    p.updated_at = time.time()
    _main().log_event(db, "console", f"프로그램 정보 수정: {p.name} {p.version} by {actor['username']}")
    db.commit()
    return {"ok": True}


@router.delete("/api/packages/{pid}", dependencies=[Depends(require_ready)])
def delete_package(pid: int, db: Session = Depends(get_db), actor: dict = Depends(require_admin_role)):
    p = _get_pkg(db, pid)
    # 아직 전달되지 않은 설치·삭제 명령은 대기열에서 제거
    for d in p.deployments:
        if d.command_id:
            db.query(AgentCommand).filter(AgentCommand.id == d.command_id).delete()
    name = f"{p.name} {p.version}"
    path = os.path.join(PACKAGE_DIR, p.stored_name)
    db.delete(p)
    _main().log_event(db, "console", f"프로그램 삭제: {name} by {actor['username']}")
    icon = _icon_path(p)
    db.commit()
    for f in (path, icon):
        try:
            if f:
                os.remove(f)
        except OSError:
            pass
    return {"ok": True}


@router.get("/api/packages/{pid}/status", dependencies=ADMIN_DEPS)
def package_status(pid: int, db: Session = Depends(get_db)):
    """프로그램별 PC 현황: 설치 여부(프로그램 목록 기준) + 마지막 배포 요청 상태"""
    m = _main()
    p = _get_pkg(db, pid)
    latest = _latest_deployments(p)
    rows = []
    for a in db.query(Agent).filter(Agent.status == "active").order_by(Agent.hostname).all():
        installed, ver = detect(p, _software(a))
        dep = latest.get(a.machine_id)
        rows.append({
            "machine_id": a.machine_id, "hostname": a.hostname, "ip": a.ip, "ring": a.ring,
            "online": m.is_online(a), "installed": installed, "installed_version": ver,
            "software_ts": a.software_ts, "deployment": _serialize_dep(dep) if dep else None,
        })
    return {"package": _serialize_pkg(p), "rows": rows}


def _issue(db: Session, p: SoftwarePackage, dep: PackageDeployment, now: float) -> None:
    """배포 기록에 서명된 설치/삭제 명령을 붙여 대기열에 넣는다 (관리자 배포·셀프 설치·승인 공용)"""
    body = {
        "v": 1, "deployment_id": dep.id, "package_id": p.id, "machine_id": dep.machine_id, "action": dep.action,
        "name": p.name, "version": p.version, "kind": p.kind, "filename": p.filename, "sha256": p.sha256,
        "size": p.size, "install_args": p.install_args, "uninstall_cmd": p.uninstall_cmd,
        "detect_name": p.detect_name, "timeout_min": p.timeout_min, "issued_at": now,
    }
    payload = {"deployment_id": dep.id, **sign_payload(body)}
    cmd = AgentCommand(machine_id=dep.machine_id, cmd_type=f"pkg_{dep.action}",
                       payload_json=json.dumps(payload, ensure_ascii=False), created_at=now)
    db.add(cmd)
    db.flush()
    dep.status, dep.command_id, dep.updated_at = "queued", cmd.id, now


def _file_ok(p: SoftwarePackage) -> bool:
    return os.path.exists(os.path.join(PACKAGE_DIR, p.stored_name))


@router.post("/api/packages/{pid}/deploy", dependencies=ADMIN_DEPS)
def deploy_package(pid: int, req: DeployRequest, db: Session = Depends(get_db),
                   actor: dict = Depends(verify_admin)):
    """선택 PC에 설치/삭제 요청 (운영자도 가능). 온라인 PC는 즉시, 꺼진 PC는 다음 부팅 시 적용"""
    m = _main()
    if req.action not in ("install", "uninstall"):
        raise HTTPException(status_code=400, detail="지원하지 않는 작업입니다.")
    p = _get_pkg(db, pid)
    if not _file_ok(p):
        raise HTTPException(status_code=410, detail="서버에 설치 파일이 없습니다. 다시 업로드하세요.")
    sent, queued, skipped, notify_ids = [], [], [], []
    now = time.time()
    for mid in req.machine_ids:
        a = db.query(Agent).filter(Agent.machine_id == mid, Agent.status == "active").first()
        if not a:
            continue
        busy = (
            db.query(PackageDeployment)
            .filter(PackageDeployment.package_id == p.id, PackageDeployment.machine_id == mid,
                    PackageDeployment.status.in_(BUSY_STATES))
            .first()
        )
        if busy and busy.status == "requested" and req.action == "install":
            # 승인 대기 중인 셀프 설치 요청이 있으면 그 요청을 승인한 것으로 처리
            dep = busy
            dep.message = f"{actor['username']} 님이 배포하며 승인"
        elif busy:
            skipped.append(a.hostname)
            continue
        else:
            dep = PackageDeployment(package_id=p.id, machine_id=mid, action=req.action, status="queued",
                                    requested_by=actor["username"], created_at=now, updated_at=now)
            db.add(dep)
            db.flush()
        _issue(db, p, dep, now)
        if m.is_online(a):
            sent.append(a.hostname)
            notify_ids.append(mid)
        else:
            queued.append(a.hostname)
    verb = "설치" if req.action == "install" else "삭제"
    msg = f"프로그램 {verb} 요청 [{p.name} {p.version}] → 즉시 {len(sent)}대"
    if queued:
        msg += f" / 다음 부팅 시 {len(queued)}대"
    if skipped:
        msg += f" / 이미 진행 중 {len(skipped)}대"
    m.log_event(db, "console", f"{msg} (by {actor['username']})")
    db.commit()
    for mid in notify_ids:
        m.notify_agent_realtime(mid, "command")
    return {"ok": True, "sent": len(sent), "queued": queued, "skipped": skipped}


@router.post("/api/deployments/{did}/cancel", dependencies=ADMIN_DEPS)
def cancel_deployment(did: int, db: Session = Depends(get_db), actor: dict = Depends(verify_admin)):
    d = db.query(PackageDeployment).filter(PackageDeployment.id == did).first()
    if not d:
        raise HTTPException(status_code=404, detail="배포 기록을 찾을 수 없습니다.")
    if d.status != "queued" or not d.command_id:
        raise HTTPException(status_code=409, detail="이미 PC에 전달된 작업은 취소할 수 없습니다.")
    db.query(AgentCommand).filter(AgentCommand.id == d.command_id).delete()
    d.status, d.command_id, d.updated_at = "cancelled", None, time.time()
    d.message = f"{actor['username']} 님이 취소"
    db.commit()
    return {"ok": True}


# ==========================================================
# 아이콘 (PNG/ICO, 128KB 이하)
# ==========================================================
def _icon_path(p: SoftwarePackage) -> str:
    return os.path.join(ICON_DIR, f"{p.id}.{p.icon_type}") if p.icon_type else ""


def _icon_response(p: SoftwarePackage) -> FileResponse:
    path = _icon_path(p)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="아이콘이 없습니다.")
    media = "image/png" if p.icon_type == "png" else "image/x-icon"
    return FileResponse(path, media_type=media, headers={
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400",
        "Content-Security-Policy": "default-src 'none'",
    })


@router.post("/api/packages/{pid}/icon", dependencies=[Depends(require_ready)])
async def upload_icon(pid: int, request: Request, db: Session = Depends(get_db),
                      actor: dict = Depends(require_admin_role)):
    p = _get_pkg(db, pid)
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > ICON_MAX_BYTES:
            raise HTTPException(status_code=413, detail=f"아이콘은 {ICON_MAX_BYTES // 1024}KB 이하만 올릴 수 있습니다.")
    kind = next((v[0] for magic, v in ICON_TYPES.items() if data.startswith(magic)), None)
    if not kind:
        raise HTTPException(status_code=400, detail="아이콘은 PNG 또는 ICO 파일만 올릴 수 있습니다.")
    os.makedirs(ICON_DIR, exist_ok=True)
    old = _icon_path(p)
    p.icon_type = kind
    p.icon_rev = (p.icon_rev or 0) + 1
    new = _icon_path(p)
    with open(new + ".tmp", "wb") as f:
        f.write(data)
    os.replace(new + ".tmp", new)
    if old and old != new:
        try:
            os.remove(old)
        except OSError:
            pass
    p.updated_at = time.time()
    db.commit()
    return {"ok": True, "icon_rev": p.icon_rev}


@router.delete("/api/packages/{pid}/icon", dependencies=[Depends(require_ready)])
def delete_icon(pid: int, db: Session = Depends(get_db), actor: dict = Depends(require_admin_role)):
    p = _get_pkg(db, pid)
    old = _icon_path(p)
    p.icon_type, p.icon_rev = "", (p.icon_rev or 0) + 1
    db.commit()
    try:
        if old:
            os.remove(old)
    except OSError:
        pass
    return {"ok": True}


@router.get("/api/packages/{pid}/icon", dependencies=ADMIN_DEPS)
def get_icon(pid: int, db: Session = Depends(get_db)):
    return _icon_response(_get_pkg(db, pid))


# ==========================================================
# 셀프 설치 요청 승인/거절 (콘솔)
# ==========================================================
@router.get("/api/package-requests", dependencies=ADMIN_DEPS)
def list_requests(db: Session = Depends(get_db)):
    rows = (
        db.query(PackageDeployment)
        .filter(PackageDeployment.status == "requested")
        .order_by(PackageDeployment.id)
        .all()
    )
    return {"requests": [_serialize_dep(d) for d in rows]}


def _get_request(db: Session, did: int) -> PackageDeployment:
    d = db.query(PackageDeployment).filter(PackageDeployment.id == did).first()
    if not d:
        raise HTTPException(status_code=404, detail="요청을 찾을 수 없습니다.")
    if d.status != "requested":
        raise HTTPException(status_code=409, detail="이미 처리된 요청입니다.")
    return d


@router.post("/api/deployments/{did}/approve", dependencies=ADMIN_DEPS)
def approve_request(did: int, db: Session = Depends(get_db), actor: dict = Depends(verify_admin)):
    m = _main()
    d = _get_request(db, did)
    if not d.package or not _file_ok(d.package):
        raise HTTPException(status_code=410, detail="서버에 설치 파일이 없습니다.")
    now = time.time()
    _issue(db, d.package, d, now)
    d.message = f"{actor['username']} 님이 승인"
    host = d.agent.hostname if d.agent else d.machine_id
    m.log_event(db, "console", f"셀프 설치 승인: {d.package.name} {d.package.version} → {host} (by {actor['username']})")
    online = bool(d.agent and m.is_online(d.agent))
    db.commit()
    if online:
        m.notify_agent_realtime(d.machine_id, "command")
    return {"ok": True, "online": online}


@router.post("/api/deployments/{did}/reject", dependencies=ADMIN_DEPS)
def reject_request(did: int, req: RejectRequest, db: Session = Depends(get_db), actor: dict = Depends(verify_admin)):
    m = _main()
    d = _get_request(db, did)
    reason = (req.reason or "").strip()[:200]
    d.status, d.updated_at = "rejected", time.time()
    d.message = f"{actor['username']} 님이 거절" + (f": {reason}" if reason else "")
    host = d.agent.hostname if d.agent else d.machine_id
    name = f"{d.package.name} {d.package.version}" if d.package else f"#{d.package_id}"
    m.log_event(db, "console", f"셀프 설치 거절: {name} → {host} (by {actor['username']}) {reason}")
    db.commit()
    return {"ok": True}


# ==========================================================
# 에이전트 API
# ==========================================================
@router.get("/api/agent/packages/{pid}/file", dependencies=[Depends(require_ready)])
def download_package(pid: int, agent: Agent = Depends(verify_agent), db: Session = Depends(get_db)):
    """이 PC에 진행 중인 설치 요청이 있는 프로그램만 내려받을 수 있다"""
    p = _get_pkg(db, pid)
    ok = (
        db.query(PackageDeployment.id)
        .filter(PackageDeployment.package_id == pid, PackageDeployment.machine_id == agent.machine_id,
                PackageDeployment.status.in_(ACTIVE_STATES))
        .first()
    )
    if not ok:
        raise HTTPException(status_code=403, detail="이 PC에 요청된 설치 작업이 없습니다.")
    path = os.path.join(PACKAGE_DIR, p.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=410, detail="서버에 설치 파일이 없습니다.")
    return FileResponse(path, media_type="application/octet-stream", filename=p.filename)


def _ver_tuple(v: str) -> tuple:
    nums = [int(x) for x in re.findall(r"\d+", v or "")][:4]
    while nums and nums[-1] == 0:
        nums.pop()
    return tuple(nums)


def _self_pkg(db: Session, pid: int) -> SoftwarePackage:
    p = db.query(SoftwarePackage).filter(SoftwarePackage.id == pid, SoftwarePackage.self_service.is_(True)).first()
    if not p:
        raise HTTPException(status_code=404, detail="설치 센터에 공개되지 않은 프로그램입니다.")
    return p


@router.get("/api/agent/catalog", dependencies=[Depends(require_ready)])
def agent_catalog(agent: Agent = Depends(verify_agent), db: Session = Depends(get_db)):
    """에이전트 '프로그램 설치 센터' 목록: 공개된 프로그램 + 이 PC 설치 여부 + 진행 상태"""
    if agent.status != "active":
        raise HTTPException(status_code=403, detail="콘솔에서 승인된 PC만 사용할 수 있습니다.")
    software = _software(agent)
    items = []
    pkgs = (
        db.query(SoftwarePackage)
        .filter(SoftwarePackage.self_service.is_(True))
        .order_by(SoftwarePackage.name, SoftwarePackage.id.desc())
        .all()
    )
    for p in pkgs:
        installed, ver = detect(p, software)
        state = "none"
        if installed:
            state = "update" if ver and p.version and _ver_tuple(ver) < _ver_tuple(p.version) else "installed"
        dep = (
            db.query(PackageDeployment)
            .filter(PackageDeployment.package_id == p.id, PackageDeployment.machine_id == agent.machine_id)
            .order_by(PackageDeployment.id.desc())
            .first()
        )
        items.append({
            "id": p.id, "name": p.name, "version": p.version, "publisher": p.publisher,
            "description": p.description or "", "size": p.size, "kind": p.kind,
            "approval": bool(p.self_approval), "has_icon": bool(p.icon_type), "icon_rev": p.icon_rev or 0,
            "state": state, "installed_version": ver,
            "request": {
                "id": dep.id, "action": dep.action, "status": dep.status,
                "status_label": SELF_LABEL.get(dep.status) or STATUS_LABEL.get(dep.status, dep.status),
                "progress": dep.progress, "message": dep.message, "updated_at": dep.updated_at,
            } if dep else None,
        })
    return {"items": items, "software_ts": agent.software_ts}


@router.get("/api/agent/catalog/{pid}/icon", dependencies=[Depends(require_ready)])
def agent_catalog_icon(pid: int, agent: Agent = Depends(verify_agent), db: Session = Depends(get_db)):
    return _icon_response(_self_pkg(db, pid))


@router.post("/api/agent/catalog/{pid}/request", dependencies=[Depends(require_ready)])
def agent_self_request(pid: int, req: SelfInstallRequest, agent: Agent = Depends(verify_agent),
                       db: Session = Depends(get_db)):
    """설치 센터의 [설치] 버튼. 명령은 항상 서버가 서명해서 만든다 (에이전트가 직접 설치를 결정하지 않음)"""
    m = _main()
    if agent.status != "active":
        raise HTTPException(status_code=403, detail="콘솔에서 승인된 PC만 사용할 수 있습니다.")
    p = _self_pkg(db, pid)
    if not _file_ok(p):
        raise HTTPException(status_code=410, detail="서버에 설치 파일이 없습니다. 관리자에게 문의하세요.")
    busy = (
        db.query(PackageDeployment)
        .filter(PackageDeployment.package_id == p.id, PackageDeployment.machine_id == agent.machine_id,
                PackageDeployment.status.in_(BUSY_STATES))
        .first()
    )
    if busy:
        return {"ok": True, "already": True, "status": busy.status, "status_label": STATUS_LABEL.get(busy.status, busy.status)}
    now = time.time()
    recent = (
        db.query(PackageDeployment.id)
        .filter(PackageDeployment.machine_id == agent.machine_id, PackageDeployment.created_at > now - 3600,
                PackageDeployment.requested_by.like(f"{SELF_PREFIX}%"))
        .count()
    )
    if recent >= SELF_RATE_PER_HOUR:
        raise HTTPException(status_code=429, detail="요청이 너무 많습니다. 잠시 후 다시 시도하세요.")
    user = re.sub(r"[^\w.\-\\@ ]", "", req.user or "")[:40]
    who = f"{SELF_PREFIX}" + (f" ({user})" if user else "")
    dep = PackageDeployment(package_id=p.id, machine_id=agent.machine_id, action="install", status="requested",
                            requested_by=who[:64], created_at=now, updated_at=now)
    db.add(dep)
    db.flush()
    name = f"{p.name} {p.version}".strip()
    if p.self_approval:
        dep.message = "관리자 승인을 기다리는 중"
        m.notify_console(db, "warn", "deploy", f"셀프 설치 승인 요청: {agent.hostname}",
                         f"{name} — {user or '사용자'} 님이 설치를 요청했습니다. [프로그램 관리]에서 승인하거나 거절하세요.",
                         agent.machine_id)
        m.log_event(db, agent.hostname, f"셀프 설치 요청 (승인 대기): {name} by {user or '-'}")
        db.commit()
        return {"ok": True, "status": "requested", "status_label": STATUS_LABEL["requested"]}
    _issue(db, p, dep, now)
    m.log_event(db, agent.hostname, f"셀프 설치 시작: {name} by {user or '-'}")
    db.commit()
    m.notify_agent_realtime(agent.machine_id, "command")
    return {"ok": True, "status": "queued", "status_label": SELF_LABEL["queued"]}


@router.post("/api/agent/progress", dependencies=[Depends(require_ready)])
def report_progress(req: ProgressReport, agent: Agent = Depends(verify_agent), db: Session = Depends(get_db)):
    m = _main()
    d = db.query(PackageDeployment).filter(
        PackageDeployment.id == req.deployment_id, PackageDeployment.machine_id == agent.machine_id
    ).first()
    if not d:
        return {"ok": False}  # 콘솔에서 프로그램을 삭제한 경우 등
    if d.status in TERMINAL_STATES:
        return {"ok": True}
    if req.status not in ("downloading", "installing", "uninstalling", "success", "failed"):
        raise HTTPException(status_code=400, detail="알 수 없는 상태값")
    d.status = req.status
    d.progress = max(0, min(100, int(req.progress)))
    d.message = (req.message or "")[:512]
    d.exit_code = req.exit_code
    d.command_id = None
    d.updated_at = time.time()
    if req.status in ("success", "failed"):
        name = f"{d.package.name} {d.package.version}" if d.package else f"#{d.package_id}"
        verb = "설치" if d.action == "install" else "삭제"
        result = "완료" if req.status == "success" else "실패"
        m.log_event(db, agent.hostname, f"프로그램 {verb} {result}: {name} (종료 코드 {req.exit_code}) {d.message}")
        if req.status == "failed":
            m.notify_console(db, "error", "deploy", f"프로그램 {verb} 실패: {agent.hostname}",
                             f"{name} — {d.message} (종료 코드 {req.exit_code})", agent.machine_id)
    db.commit()
    return {"ok": True}


# ==========================================================
# 체크인·정리 연동 (main.py 에서 호출)
# ==========================================================
def on_command_delivered(db: Session, cmd: AgentCommand) -> None:
    """대기열 명령이 에이전트에 전달되면 배포 상태를 '전달됨'으로"""
    if cmd.cmd_type not in ("pkg_install", "pkg_uninstall"):
        return
    try:
        did = json.loads(cmd.payload_json or "{}").get("deployment_id")
    except ValueError:
        return
    d = db.query(PackageDeployment).filter(PackageDeployment.id == did).first() if did else None
    if d and d.status == "queued":
        d.status, d.command_id, d.updated_at = "sent", None, time.time()


def on_command_cancelled(db: Session, cmd: AgentCommand, actor: str = "") -> None:
    """PC 상세의 '대기 중인 명령'에서 설치 명령을 취소한 경우"""
    if cmd.cmd_type not in ("pkg_install", "pkg_uninstall"):
        return
    try:
        did = json.loads(cmd.payload_json or "{}").get("deployment_id")
    except ValueError:
        return
    d = db.query(PackageDeployment).filter(PackageDeployment.id == did).first() if did else None
    if d and d.status == "queued":
        d.status, d.command_id, d.updated_at = "cancelled", None, time.time()
        d.message = "대기 중 취소"


def on_command_expired(db: Session, cmd: AgentCommand) -> None:
    """대기 기간이 지나 만료된 설치 명령은 배포 기록도 실패 처리"""
    if cmd.cmd_type not in ("pkg_install", "pkg_uninstall"):
        return
    try:
        did = json.loads(cmd.payload_json or "{}").get("deployment_id")
    except ValueError:
        return
    d = db.query(PackageDeployment).filter(PackageDeployment.id == did).first() if did else None
    if d and d.status == "queued":
        d.status, d.command_id, d.updated_at = "failed", None, time.time()
        d.message = "PC가 대기 기간 동안 켜지지 않아 만료됨"


def cleanup(db: Session) -> None:
    cutoff = time.time() - DEPLOY_KEEP_DAYS * 86400
    # 보관 기간 동안 처리되지 않은 셀프 설치 요청은 자동 거절
    for d in db.query(PackageDeployment).filter(PackageDeployment.status == "requested",
                                                  PackageDeployment.created_at < cutoff).all():
        d.status, d.updated_at, d.message = "rejected", time.time(), "승인 대기 기간이 지나 자동으로 닫힘"
    db.query(PackageDeployment).filter(
        PackageDeployment.updated_at < cutoff, PackageDeployment.status.in_(TERMINAL_STATES)
    ).delete(synchronize_session=False)
    _cleanup_uploads()


def agent_deployments(db: Session, machine_id: str, limit: int = 20) -> list[dict]:
    rows = (
        db.query(PackageDeployment)
        .filter(PackageDeployment.machine_id == machine_id)
        .order_by(PackageDeployment.id.desc())
        .limit(limit)
        .all()
    )
    return [_serialize_dep(d) for d in rows]
