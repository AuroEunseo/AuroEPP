export interface UpdateItem {
  id?: string;
  kb: string;
  title: string;
  size?: number;
  sev?: string;
  cat?: string;
  hid?: boolean;
  dl?: boolean;
  rb?: boolean;
  date?: string;
  rc?: number;
  op?: number;
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
  applied_hash: string;
  target_hash?: string;
  reboot_required: boolean;
  hotfix: string;
  agent_ver: string;
  pend: UpdateItem[];
  hist: UpdateItem[];
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

export interface DashboardState {
  now: number;
  agents: Agent[];
  pending_agents: Agent[];
  policies: Record<string, { items: PolicyItem[]; hash: string }>;
  rules: KbRule[];
  events: EventLog[];
}

export interface UpdateItem {
  kb: string;
  title: string;
  hidden?: boolean;
  size_mb?: number;
  status?: string;
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
  // ... 기존 필드들 (agents, policies, kb_rules, events 등) 유지 ...
  catalog?: CatalogItem[];
  defaults?: { target_release: string };
}