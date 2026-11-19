import time
from sqlalchemy import Column, Integer, String, Float, Boolean, Text, ForeignKey
from sqlalchemy.orm import relationship
from .database import Base

class Agent(Base):
    __tablename__ = "agents"

    machine_id = Column(String(64), primary_key=True, index=True)
    hostname = Column(String(128), nullable=False)
    ip = Column(String(64), default="")
    os_name = Column(String(128), default="")
    os_build = Column(String(64), default="")
    mac_addr = Column(String, default="-")
    cpu_info = Column(String, default="-")
    ram_gb = Column(String, default="-")
    
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
    hist_json = Column(Text, default="[]")
    upd_ts = Column(Float, nullable=True)

    commands = relationship("AgentCommand", back_populates="agent", cascade="all, delete-orphan")


class AgentCommand(Base):
    """개별 PC 전용 명령 큐 (전체 방송이 아닌 특정 PC 핀포인트 제어 지원)"""
    __tablename__ = "agent_commands"

    id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(String(64), ForeignKey("agents.machine_id", ondelete="CASCADE"), index=True)
    cmd_type = Column(String(32), nullable=False)  # scan, install_all, install_kb, hide_kb, unhide_kb, reboot, shutdown
    mac_addr = Column(String, default="")
    cpu_info = Column(String, default="")
    ram_gb = Column(String, default="")
    payload_json = Column(Text, default="{}")
    status = Column(String(20), default="queued", index=True)  # queued | dispatched
    created_at = Column(Float, default=time.time)


    agent = relationship("Agent", back_populates="commands")


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

class UpdateCatalog(Base):
    __tablename__ = "update_catalog"
    kb = Column(String, primary_key=True, index=True)
    title = Column(String, default="")
    category = Column(String, default="누적/보안 업데이트")
    summary = Column(String, default="")
    release_date = Column(String, default="")
    source = Column(String, default="agent")  # 'microsoft' | 'agent'
    updated_at = Column(Float, default=0.0)