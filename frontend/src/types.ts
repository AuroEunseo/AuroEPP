/** 에이전트가 보고하는 Windows 업데이트 항목 (대기/이력 공용) */
export interface UpdateItem {
  id?: string;
  kb: string;
  title: string;
  size?: number; // 바이트
  sev?: string;
  cat?: string;
  hid?: boolean; // 숨김(차단) 여부
  dl?: boolean;
  rb?: boolean;
  date?: string;
  rc?: number; // 결과 코드: 2 성공, 3 부분 성공, 4 실패, 5 중단
  op?: number; // 1 설치, 2 제거
}

export interface Agent {
  machine_id: string;
  hostname: string;
  ip: string;
  os_name: string;
  os_build: string;
  mac_addr?: string;
  cpu_info?: string;
  ram_gb?: string;
  token_preview: string;
  status: 'pending' | 'active' | 'rejected';
  ring: string;
  last_seen: number;
  online?: boolean;
  alive?: boolean; // 승인 대기/거부 PC가 최근 등록 요청을 보냈는지 (통신 확인)
  applied_hash: string;
  target_hash?: string;
  reboot_required: boolean;
  hotfix: string;
  agent_ver: string;
  pend: UpdateItem[];
  hist_count?: number;
  queued_count?: number; // 다음 부팅(재연결) 시 적용될 대기 명령 수
  boot_ts?: number | null;
  reconnect_waiting?: boolean; // 재부팅 명령 후 재연결 확인 중
  upd_ts?: number;
}

export interface PolicyItem {
  path: string;
  name: string;
  type: 'DWORD' | 'SZ';
  value: string | number;
  op?: 'delete';
}

export interface KbRule {
  kb: string;
  ring: string;
  action: 'block' | 'allow' | 'install';
  note?: string;
}

export interface EventLog {
  id: number;
  ts: number;
  host: string;
  msg: string;
}

export interface CatalogItem {
  kb: string;
  title: string;
  category: string;
  summary: string;
  release_date: string;
  source: string;
  installed_count: number;
  pending_count: number;
}

export interface DashboardState {
  now: number;
  agents: Agent[];
  pending_agents: Agent[];
  rejected_agents: Agent[];
  policies: Record<string, { items: PolicyItem[]; hash: string }>;
  rules: KbRule[];
  events: EventLog[];
  catalog?: CatalogItem[];
  notification_count: number;
  defaults?: { target_release: string };
  server?: { host: string; port: number };
  limits?: { online_sec: number; pending_alive_sec: number; retention_days: number; history_keep: number };
}

export interface RegistryChange {
  id: number;
  ts: number;
  source: 'policy' | 'rollback';
  policy_hash: string;
  path: string;
  name: string;
  op: 'set' | 'delete';
  old_exists: boolean;
  old_type: number | null;
  old_value: any;
  new_exists: boolean;
  new_type: number | null;
  new_value: any;
  rollback_state: '' | 'requested' | 'done' | 'failed';
  rollback_ts?: number | null;
  rollback_msg?: string;
}

export interface QueuedCommand {
  id: number;
  type: string;
  label: string;
  payload: Record<string, any>;
  created_at: number;
}

export interface AgentDetail {
  machine_id: string;
  online: boolean;
  boot_ts?: number | null;
  reconnect_waiting?: boolean;
  queued_commands: QueuedCommand[];
  hist: UpdateItem[];
  hist_ts?: number | null;
  registry_changes: RegistryChange[];
}

export interface NotificationItem {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  category: string;
  title: string;
  message: string;
  machine_id: string;
}

export interface AccessLogItem {
  id: number;
  ts: number;
  username: string;
  ip: string;
  action: string;
  ok: boolean;
  detail: string;
}

export interface SystemStatus {
  ready: boolean;
  phase: string;
  message: string;
  steps: { ts: number; phase: string; message: string }[];
  error: string;
  backup_file: string;
  rebuilt_tables: string[];
}

export interface ConsoleAccount {
  username: string;
  role: 'admin' | 'operator';
  role_label: string;
  must_change: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_active?: number | null;
}

/** 10초 주기 경량 상태 (온라인 판정 + 변경 감지) */
export interface Presence {
  now: number;
  rev: string;
  last_seen: Record<string, number>;
  notification_count: number;
  online_sec: number;
}

/** 좌측 메뉴 키 */
export type MenuKey =
  | 'dashboard'
  | 'pcs-managed'
  | 'pcs-pending'
  | 'pcs-rejected'
  | 'notifications'
  | 'policy-registry'
  | 'policy-rules'
  | 'logs'
  | 'settings';
