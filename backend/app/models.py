import time
from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from .database import Base

# 참고: 기존 DB에 새로 추가되는 컬럼은 반드시 server_default 또는 nullable 로 정의한다.
#       (migrations.py 가 기존 데이터를 새 테이블로 복사할 때 빈 값이 채워지도록)


class Agent(Base):
    __tablename__ = "agents"

    machine_id = Column(String(64), primary_key=True, index=True)
    hostname = Column(String(128), nullable=False)
    ip = Column(String(64), default="")
    os_name = Column(String(128), default="")
    os_build = Column(String(64), default="")
    mac_addr = Column(String, default="-", server_default="-")
    cpu_info = Column(String, default="-", server_default="-")
    ram_gb = Column(String, default="-", server_default="-")

    # 에이전트 PC에서 생성한 고유 토큰의 해시값 및 콘솔 표시용 마스킹 문자열
    token_hash = Column(String(128), nullable=False)
    token_preview = Column(String(32), default="")

    # pending(승인대기) | active(정상등록) | rejected(거부됨)
    status = Column(String(20), default="pending", index=True)
    ring = Column(String(32), default="ring1")

    last_seen = Column(Float, default=time.time)
    applied_hash = Column(String(32), default="")
    reboot_required = Column(Boolean, default=False)
    hotfix = Column(Text, default="")  # 설치 KB 목록 (길이 제한 없음)
    agent_ver = Column(String(32), default="1.0")

    pend_json = Column(Text, default="[]")
    hist_json = Column(Text, default="[]")  # 설치/제거 이력, 최대 HISTORY_KEEP 건
    upd_ts = Column(Float, nullable=True)
    hist_ts = Column(Float, nullable=True)  # 이력이 마지막으로 갱신된 시각
    boot_ts = Column(Float, nullable=True)  # PC 마지막 부팅 시각 (에이전트 보고)
    service_started_at = Column(Float, nullable=True)  # 에이전트 서비스 시작 시각
    # 재부팅 명령 전달 후 재연결 확인 (since: 명령 전달 시각, until: 확인 기한)
    reconnect_watch_since = Column(Float, nullable=True)
    reconnect_watch_until = Column(Float, nullable=True)
    # 설치된 프로그램 목록 ('프로그램 추가/제거' 기준, 설치 여부 확인용) [{name, version, publisher}]
    software_json = Column(Text, default="[]", server_default="[]")
    software_ts = Column(Float, nullable=True)

    commands = relationship("AgentCommand", back_populates="agent", cascade="all, delete-orphan")
    reg_changes = relationship("RegistryChange", back_populates="agent", cascade="all, delete-orphan")
    deployments = relationship("PackageDeployment", back_populates="agent", cascade="all, delete-orphan")


class AgentCommand(Base):
    """개별 PC 전용 명령 큐 (오프라인이면 보관 후 다음 부팅·재연결 시 전달, COMMAND_KEEP_DAYS 경과 시 만료)"""
    __tablename__ = "agent_commands"

    id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(String(64), ForeignKey("agents.machine_id", ondelete="CASCADE"), index=True)
    # scan, install_all, install_kb, hide_kb, unhide_kb, reboot, shutdown, report_history, reg_rollback
    cmd_type = Column(String(32), nullable=False)
    payload_json = Column(Text, default="{}")
    status = Column(String(20), default="queued", index=True)
    created_at = Column(Float, default=time.time, index=True)

    agent = relationship("Agent", back_populates="commands")


class RegistryChange(Base):
    """에이전트가 정책/롤백으로 변경한 레지스트리 값의 변경 전·후 기록 (롤백용)"""
    __tablename__ = "registry_changes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(String(64), ForeignKey("agents.machine_id", ondelete="CASCADE"), index=True)
    cid = Column(String(64), unique=True, index=True)  # 에이전트가 발급한 변경 고유 ID (중복 보고 방지)
    ts = Column(Float, default=time.time, index=True)
    source = Column(String(16), default="policy")  # policy | rollback
    policy_hash = Column(String(32), default="")
    path = Column(String(512), nullable=False)
    name = Column(String(256), nullable=False)
    op = Column(String(16), default="set")  # set | delete
    old_exists = Column(Boolean, default=False)
    old_type = Column(Integer, nullable=True)  # winreg 타입 코드 (REG_SZ=1, REG_DWORD=4 ...)
    old_value = Column(Text, default="null")  # JSON
    new_exists = Column(Boolean, default=True)
    new_type = Column(Integer, nullable=True)
    new_value = Column(Text, default="null")  # JSON
    rollback_state = Column(String(16), default="", server_default="")  # '' | requested | done | failed
    rollback_ts = Column(Float, nullable=True)
    rollback_msg = Column(String(256), default="", server_default="")

    agent = relationship("Agent", back_populates="reg_changes")


class SoftwarePackage(Base):
    """사내 공용 프로그램 (업로드한 설치 파일 + 무인 설치 정보)"""
    __tablename__ = "software_packages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    version = Column(String(64), default="")
    publisher = Column(String(128), default="")
    filename = Column(String(256), nullable=False)
    stored_name = Column(String(128), nullable=False)  # 서버 보관 파일명 (packages/ 아래)
    size = Column(Integer, default=0)
    sha256 = Column(String(64), nullable=False)
    kind = Column(String(8), default="exe")  # msi | exe
    install_args = Column(String(512), default="")  # MSI: 추가 속성, EXE: 무인 설치 옵션
    uninstall_cmd = Column(String(1024), default="")  # 비우면 '프로그램 추가/제거' 정보로 자동 제거
    detect_name = Column(String(256), default="")  # 설치 여부 확인용 표시 이름(부분 일치)
    timeout_min = Column(Integer, default=30)
    notes = Column(Text, default="")
    # 에이전트 '프로그램 설치 센터' (사용자 셀프 설치)
    description = Column(String(500), default="")  # 설치 센터에 보이는 설명
    self_service = Column(Boolean, default=False)  # 설치 센터에 공개
    self_approval = Column(Boolean, default=False)  # True: 관리자 승인 후 설치 / False: 누르면 바로 설치
    icon_type = Column(String(8), default="")  # png | ico ('' = 아이콘 없음)
    icon_rev = Column(Integer, default=0)  # 아이콘 교체 시 증가 (화면 캐시 갱신용)
    created_by = Column(String(64), default="")
    created_at = Column(Float, default=time.time)
    updated_at = Column(Float, default=time.time)

    deployments = relationship("PackageDeployment", back_populates="package", cascade="all, delete-orphan")


class PackageDeployment(Base):
    """프로그램 설치/삭제 요청 1건 (PC 1대 기준) 의 진행 상태"""
    __tablename__ = "package_deployments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    package_id = Column(Integer, ForeignKey("software_packages.id", ondelete="CASCADE"), index=True)
    machine_id = Column(String(64), ForeignKey("agents.machine_id", ondelete="CASCADE"), index=True)
    action = Column(String(16), default="install")  # install | uninstall
    # requested(셀프 설치 승인 대기) | queued(PC 꺼짐·대기) | sent(전달됨) | downloading | installing | uninstalling
    # | success | failed | cancelled | rejected(승인 거절)
    status = Column(String(16), default="queued", index=True)
    progress = Column(Integer, default=0)
    exit_code = Column(Integer, nullable=True)
    message = Column(String(512), default="")
    command_id = Column(Integer, nullable=True)  # 아직 전달 전이면 대기열 명령 ID (취소용)
    requested_by = Column(String(64), default="")
    created_at = Column(Float, default=time.time, index=True)
    updated_at = Column(Float, default=time.time)

    package = relationship("SoftwarePackage", back_populates="deployments")
    agent = relationship("Agent", back_populates="deployments")


class Policy(Base):
    __tablename__ = "policies"

    ring = Column(String(32), primary_key=True)
    items_json = Column(Text, default="[]")


class KbRule(Base):
    __tablename__ = "kb_rules"

    kb = Column(String(20), primary_key=True)
    ring = Column(String(32), primary_key=True)  # '*' 또는 특정 링 이름
    action = Column(String(16), nullable=False)  # block | allow | install
    note = Column(String(256), default="")
    updated_at = Column(Float, default=time.time)


class EventLog(Base):
    __tablename__ = "event_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ts = Column(Float, default=time.time, index=True)
    host = Column(String(128), nullable=False)
    msg = Column(Text, nullable=False)


class AccessLog(Base):
    """관리자 콘솔 접속 로그 (로그인 성공/실패, 로그아웃, 비밀번호 변경)"""
    __tablename__ = "access_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ts = Column(Float, default=time.time, index=True)
    username = Column(String(64), default="")
    ip = Column(String(64), default="")
    action = Column(String(32), nullable=False)  # login | login_fail | logout | password_change ...
    ok = Column(Boolean, default=True)
    detail = Column(String(256), default="")


class Notification(Base):
    """콘솔 알림 탭에 표시할 '확인 필요' 이벤트. 관리자가 확인하면 삭제된다."""
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ts = Column(Float, default=time.time, index=True)
    level = Column(String(8), default="info")  # info | warn | error
    category = Column(String(32), default="")  # register | command | policy | rollback | agent | system | security
    title = Column(String(128), nullable=False)
    message = Column(Text, default="")
    machine_id = Column(String(64), default="")


class UpdateCatalog(Base):
    __tablename__ = "update_catalog"
    kb = Column(String, primary_key=True, index=True)
    title = Column(String, default="")
    category = Column(String, default="누적/보안 업데이트")
    summary = Column(String, default="")
    release_date = Column(String, default="")
    source = Column(String, default="agent")  # 'microsoft' | 'agent'
    updated_at = Column(Float, default=0.0)
