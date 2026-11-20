from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

class RegisterRequest(BaseModel):
    machine_id: str
    hostname: str
    os_name: str
    os_build: str
    agent_token: str
    agent_ver: str = "1.0"

class DecisionRequest(BaseModel):
    approve: bool
    ring: str = "ring1"

class RingChangeRequest(BaseModel):
    ring: str

class PolicySaveRequest(BaseModel):
    ring: str
    items: List[Dict[str, Any]]

class RuleRequest(BaseModel):
    kb: str
    ring: str = "*"
    action: str  # block | allow | install | none
    note: str = ""

class CommandRequest(BaseModel):
    machine_ids: List[str]
    type: str
    payload: Dict[str, Any] = Field(default_factory=dict)

class CheckinRequest(BaseModel):
    hostname: str
    os_name: Optional[str] = None
    os_build: Optional[str] = None
    mac_addr: str = ""
    cpu_info: str = ""
    ram_gb: str = ""
    applied_hash: str = ""
    reboot_required: bool = False
    hotfix: str = ""
    agent_ver: str = "1.0"
    results: List[Dict[str, Any]] = Field(default_factory=list)
    updates: Optional[List[Dict[str, Any]]] = None
    # 정기 보고: 설치/제거 이력 최근 30건
    history: Optional[List[Dict[str, Any]]] = None
    # 상세 모달에서 요청한 전체 이력 (설치/제거, 최대 100건) → 서버 보관분을 교체
    history_full: Optional[List[Dict[str, Any]]] = None
    # 에이전트가 수행한 레지스트리 변경 기록 (변경 전/후 값)
    reg_changes: List[Dict[str, Any]] = Field(default_factory=list)
    # 재연결 확인용: PC 부팅 시각, 에이전트 서비스 시작 시각, 서비스 시작 후 첫 체크인 여부
    boot_ts: Optional[float] = None
    service_started_at: Optional[float] = None
    first_checkin: bool = False
    # 설치된 프로그램 목록 (서비스 시작 후 첫 보고, 프로그램 설치/삭제 후, 검색 요청 시에만 전송)
    software: Optional[List[Dict[str, Any]]] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class AccountCreateRequest(BaseModel):
    username: str
    role: str = "operator"  # admin | operator
    password: str = ""  # 비우면 임시 비밀번호 자동 발급


class AccountRoleRequest(BaseModel):
    role: str


class ScanRequest(BaseModel):
    machine_ids: List[str] = Field(default_factory=list)  # 비우면 온라인 PC 전체

class PackageCreateRequest(BaseModel):
    upload_id: str
    name: str
    version: str = ""
    publisher: str = ""
    install_args: str = ""
    uninstall_cmd: str = ""
    detect_name: str = ""
    timeout_min: int = 30
    notes: str = ""
    description: str = ""
    self_service: bool = False
    self_approval: bool = False


class PackageUpdateRequest(BaseModel):
    name: str
    version: str = ""
    publisher: str = ""
    install_args: str = ""
    uninstall_cmd: str = ""
    detect_name: str = ""
    timeout_min: int = 30
    notes: str = ""
    description: str = ""
    self_service: bool = False
    self_approval: bool = False


class DeployRequest(BaseModel):
    machine_ids: List[str]
    action: str = "install"  # install | uninstall


class ProgressReport(BaseModel):
    deployment_id: int
    status: str
    progress: int = 0
    message: str = ""
    exit_code: Optional[int] = None


class SelfInstallRequest(BaseModel):
    user: str = ""  # 설치 센터에서 요청한 Windows 사용자 이름 (기록용)


class RejectRequest(BaseModel):
    reason: str = ""
