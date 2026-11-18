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
    history: Optional[List[Dict[str, Any]]] = None