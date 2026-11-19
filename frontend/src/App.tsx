import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  LayoutDashboard,
  Monitor,
  Shield,
  Terminal,
  Settings,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  KeyRound,
  Copy,
  Check,
  RefreshCw,
  Download,
  RotateCcw,
  Code2,
  Search,
  Plus,
  Trash2,
  Edit3,
  ArrowUpDown,
  Cpu,
  HardDrive,
  Network,
  LogOut,
  ArrowUpRight,
  Power,
} from 'lucide-react';
import { DashboardState, Agent } from './types';
import { apiFetch, getAdminToken, setAdminToken } from './api';
import { AgentDrawer } from './components/AgentDrawer';

type MenuKey =
  | 'dashboard'
  | 'pcs-managed'
  | 'pcs-pending'
  | 'policy-registry'
  | 'policy-rules'
  | 'logs'
  | 'settings';
type ThemeKey = 'dark' | 'white' | 'lightblue' | 'pink' | 'ivory';
type SortField = 'hostname' | 'os_name' | 'last_seen' | 'ring' | 'pend';

const THEMES: { key: ThemeKey; label: string; bg: string; fg: string; accent: string }[] = [
  { key: 'dark', label: '다크 (Dark)', bg: '#090e1a', fg: '#f8fafc', accent: '#38bdf8' },
  { key: 'white', label: '화이트 (White)', bg: '#ffffff', fg: '#0f172a', accent: '#0284c7' },
  { key: 'lightblue', label: '라이트블루 (Sky)', bg: '#e0f0fe', fg: '#0c2442', accent: '#0284c7' },
  { key: 'pink', label: '핑크 (Blossom)', bg: '#fce7f3', fg: '#3b0d26', accent: '#db2777' },
  { key: 'ivory', label: '아이보리 (Warm)', bg: '#f4efe4', fg: '#292218', accent: '#b45309' },
];

const WU = 'SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';

interface PolicyBlockDef {
  id: string;
  title: string;
  desc: string;
  path: string;
  name: string;
  type: 'DWORD' | 'SZ';
  enabledValue: number | string;
  disabledValue: number | string;
  hasParam?: 'days' | 'version';
  paramName?: string;
}

const REGISTRY_BLOCKS: PolicyBlockDef[] = [
  {
    id: 'defer_quality',
    title: '품질(보안) 업데이트 설치 지연',
    desc: '정기 보안 패치 배포 시 지정한 일수만큼 설치를 유예하여 초기 패치 오류로부터 사내 PC를 보호합니다.',
    path: WU,
    name: 'DeferQualityUpdates',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
    hasParam: 'days',
    paramName: 'DeferQualityUpdatesPeriodInDays',
  },
  {
    id: 'target_version',
    title: 'Windows 기능 업데이트 버전 고정',
    desc: '상위 메이저 OS 버전으로 자동 업그레이드되는 것을 차단하고 지정된 빌드(예: 25H2)로 고정합니다. 지원 종료된 버전에 고정하면 보안 업데이트를 받지 못합니다.',
    path: WU,
    name: 'TargetReleaseVersion',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
    hasParam: 'version',
    paramName: 'TargetReleaseVersionInfo',
  },
  {
    id: 'exclude_drivers',
    title: 'Windows 업데이트를 통한 드라이버 자동 설치 차단',
    desc: '그래픽·네트워크 등 하드웨어 드라이버가 임의로 덮어씌워져 장비 호환성 문제가 생기는 것을 방지합니다.',
    path: WU,
    name: 'ExcludeWUDriversInQualityUpdate',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
  {
    id: 'no_auto_reboot',
    title: '사용자 로그인 중 강제 자동 재부팅 방지',
    desc: '업데이트 설치가 완료되더라도 사용자가 작업 중일 때는 PC가 임의로 재부팅되지 않도록 보호합니다.',
    path: WU + '\\AU',
    name: 'NoAutoRebootWithLoggedOnUsers',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
  {
    id: 'disable_os_upgrade',
    title: 'Windows 11 업그레이드 제안 및 자동 전환 차단',
    desc: 'Windows 10 환경에서 상위 OS 업그레이드 안내 및 자동 전환 프로세스를 차단합니다.',
    path: WU,
    name: 'DisableOSUpgrade',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
  {
    id: 'no_auto_update',
    title: 'Windows 기본 자동 업데이트 스케줄러 비활성화',
    desc: 'OS 자체 스케줄러 대신 중앙 관제 콘솔의 명령과 배포 그룹 일정에 의해서만 업데이트가 수행되도록 통제합니다.',
    path: WU + '\\AU',
    name: 'NoAutoUpdate',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
];

function formatLastSeen(ts: number): string {
  if (!ts || ts <= 0) return '접속 기록 없음';
  const d = new Date(ts * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export default function App() {
  const [token, setTokenState] = useState(getAdminToken());
  const [tokenInput, setTokenInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<DashboardState | null>(null);

  // 테마 상태
  const [theme, setTheme] = useState<ThemeKey>(
    () => (localStorage.getItem('aurora_theme') as ThemeKey) || 'dark'
  );

  // 시작프로그램 옵션 상태
  const [autoStart, setAutoStart] = useState<boolean>(
    () => localStorage.getItem('aurora_autostart') === 'true'
  );

  // 좌측 내비게이션
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');
  const [pcMenuOpen, setPcMenuOpen] = useState(true);
  const [policyMenuOpen, setPolicyMenuOpen] = useState(true);

  // PC 관리 (검색, 정렬, 선택, 드로어)
  const [pcSearch, setPcSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('hostname');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);

  // 레지스트리 정책 및 배포 그룹(링) 상태
  const [ringTab, setRingTab] = useState('ring0');
  const [draftItems, setDraftItems] = useState<any[]>([]);
  const [loadedRing, setLoadedRing] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);
  const [ringModalMode, setRingModalMode] = useState<'none' | 'create' | 'rename'>('none');
  const [ringNameInput, setRingNameInput] = useState('');

  // KB 규칙 상태
  const [kbInput, setKbInput] = useState('');
  const [ruleScope, setRuleScope] = useState('*');

  // 로그 검색 상태
  const [logSearch, setLogSearch] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [toastMsg, setToastMsg] = useState<string | null>(null);

const showToast = (msg: string) => {
  setToastMsg(msg);
  setTimeout(() => setToastMsg(null), 3500);
};

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('aurora_theme', theme);
  }, [theme]);

  const fetchState = useCallback(async () => {
    if (!getAdminToken()) return;
    try {
      const data = await apiFetch<DashboardState>('/state');
      setState(data);
      setLastRefreshed(new Date());
      setActiveAgent((prev) =>
        prev ? data.agents.find((a) => a.machine_id === prev.machine_id) || null : null
      );
    } catch (e: any) {
      if (e.message === 'UNAUTHORIZED') setTokenState('');
    }
  }, []);

  useEffect(() => {
    fetchState();
    const intervalMs = activeMenu === 'dashboard' ? 30000 : 10000;
    const id = setInterval(fetchState, intervalMs);
    return () => clearInterval(id);
  }, [fetchState, token, activeMenu]);

  useEffect(() => {
    if (state && state.policies[ringTab] && loadedRing !== ringTab) {
      setDraftItems(JSON.parse(JSON.stringify(state.policies[ringTab].items || [])));
      setLoadedRing(ringTab);
    }
  }, [state, ringTab, loadedRing]);

  const navigateToMenu = (menu: MenuKey) => {
    if (menu === 'pcs-managed' || menu === 'pcs-pending') {
      setPcMenuOpen(true);
    }
    if (menu === 'policy-registry' || menu === 'policy-rules') {
      setPolicyMenuOpen(true);
    }
    setActiveMenu(menu);
  };

  // PC 목록 검색 + 정렬
  const processedAgents = useMemo(() => {
    if (!state) return [];
    const q = pcSearch.trim().toLowerCase();
    const filtered = state.agents.filter((a) => {
      if (!q) return true;
      return (
        a.hostname.toLowerCase().includes(q) ||
        a.ip.toLowerCase().includes(q) ||
        (a.mac_addr || '').toLowerCase().includes(q) ||
        a.os_name.toLowerCase().includes(q) ||
        a.ring.toLowerCase().includes(q)
      );
    });

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'hostname') cmp = a.hostname.localeCompare(b.hostname);
      else if (sortField === 'os_name') cmp = a.os_name.localeCompare(b.os_name);
      else if (sortField === 'last_seen') cmp = a.last_seen - b.last_seen;
      else if (sortField === 'ring') cmp = a.ring.localeCompare(b.ring);
      else if (sortField === 'pend') cmp = a.pend.length - b.pend.length;
      return sortAsc ? cmp : -cmp;
    });
  }, [state, pcSearch, sortField, sortAsc]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const copyToken = () => {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Electron 콘솔(preload의 consoleApi)에서 실제 Windows 로그인 항목 상태를 읽어와 동기화
  useEffect(() => {
    const ipc = (window as any).consoleApi;
    if (!ipc?.getPrefs) return;
    ipc
      .getPrefs()
      .then((p: { openAtLogin: boolean }) => {
        setAutoStart(Boolean(p?.openAtLogin));
        localStorage.setItem('aurora_autostart', String(Boolean(p?.openAtLogin)));
      })
      .catch(() => {});
  }, []);

  const toggleAutoStart = async (checked: boolean) => {
    const ipc = (window as any).consoleApi;
    if (!ipc?.setAutoStart) {
      setAutoStart(checked);
      localStorage.setItem('aurora_autostart', String(checked));
      showToast('브라우저에서는 자동 시작을 설정할 수 없습니다. AURORA Control Console 앱에서 설정하세요.');
      return;
    }
    try {
      const res = await ipc.setAutoStart(checked);
      const applied = Boolean(res?.openAtLogin);
      setAutoStart(applied);
      localStorage.setItem('aurora_autostart', String(applied));
      showToast(applied ? '✓ Windows 로그인 시 자동 시작이 설정되었습니다.' : '✓ 자동 시작이 해제되었습니다.');
    } catch (e: any) {
      showToast(`자동 시작 설정 실패: ${e?.message || e}`);
    }
  };

  if (!token) {
    return (
      <div className="login-wrap">
        <div className="glass-card login-card">
          <div className="brand-group" style={{ marginBottom: 22 }}>
            <div className="brand-logo mono">AU</div>
            <div>
              <h1 className="brand-title">AURORA Update Control</h1>
              <p className="brand-sub">엔터프라이즈 패치 및 에이전트 중앙 관제</p>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setAdminToken(tokenInput);
              setTokenState(tokenInput);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
                관리자 인증 토큰
              </label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="C:\ProgramData\AURORA\Server\admin_token.json"
                className="input-dark mono"
                style={{ width: '100%' }}
                autoFocus
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '10px' }}>
              콘솔 접속하기
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="login-wrap mono" style={{ color: 'var(--accent-text)', fontSize: 14 }}>
        서버 상태 동기화 중...
      </div>
    );
  }

  const agents = state.agents;
  const pending = state.pending_agents || [];
  const isOnline = (a: Agent) => state.now - a.last_seen < 60;
  const isApplied = (a: Agent) => a.applied_hash && a.applied_hash === a.target_hash;
  const compliancePct = agents.length
    ? Math.round((100 * agents.filter(isApplied).length) / agents.length)
    : 0;

  // 레지스트리 블록 조작 헬퍼
  const getItemValue = (path: string, name: string) =>
    draftItems.find((x) => x.path === path && x.name === name)?.value;

  const setItemValue = (path: string, name: string, type: 'DWORD' | 'SZ', value: number | string) => {
    setDraftItems((prev) => {
      const next = [...prev];
      const idx = next.findIndex((x) => x.path === path && x.name === name);
      if (idx >= 0) {
        next[idx] = { ...next[idx], type, value };
      } else {
        next.push({ path, name, type, value });
      }
      return next;
    });
  };

  // 서버가 내려주는 기능 업데이트 고정 버전 기본값 (AURORA_TARGET_RELEASE)
  const defaultTargetRelease = state?.defaults?.target_release || '25H2';

  const toggleBlock = (blk: PolicyBlockDef, enable: boolean) => {
    setItemValue(blk.path, blk.name, blk.type, enable ? blk.enabledValue : blk.disabledValue);
    if (enable && blk.hasParam === 'days' && getItemValue(blk.path, blk.paramName!) === undefined) {
      setItemValue(blk.path, blk.paramName!, 'DWORD', 7);
    }
    if (enable && blk.hasParam === 'version') {
      setItemValue(blk.path, 'ProductVersion', 'SZ', 'Windows 11');
      if (!getItemValue(blk.path, blk.paramName!)) {
        setItemValue(blk.path, blk.paramName!, 'SZ', defaultTargetRelease);
      }
    }
  };

  const savePolicyBlocks = async () => {
    await apiFetch('/policies', { ring: ringTab, items: draftItems });
    setLoadedRing('');
    fetchState();
  };

  const handleRingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = ringNameInput.trim();
    if (!trimmed) return;
    try {
      if (ringModalMode === 'create') {
        await apiFetch('/rings', { ring: trimmed, copy_from: ringTab });
      } else if (ringModalMode === 'rename') {
        await apiFetch(`/rings/${encodeURIComponent(ringTab)}`, { new_ring: trimmed }, 'PUT');
      }
      setRingTab(trimmed);
      setLoadedRing('');
      setRingNameInput('');
      setRingModalMode('none');
      fetchState();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteRing = async () => {
    if (ringTab === 'ring0' || ringTab === 'ring1') {
      return alert('기본 배포 그룹(ring0, ring1)은 삭제할 수 없습니다.');
    }
    if (
      !confirm(
        `[${ringTab}] 배포 그룹을 삭제하시겠습니까?\n이 그룹에 배정되어 있던 PC는 자동으로 ring1으로 이동됩니다.`
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/rings/${encodeURIComponent(ringTab)}`, undefined, 'DELETE');
      setRingTab('ring1');
      setLoadedRing('');
      fetchState();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDecision = async (machineId: string, approve: boolean, ring = 'ring1') => {
    await apiFetch(`/agents/${machineId}/decision`, { approve, ring });
    fetchState();
  };

 const sendBatchCmd = async (type: string) => {
  if (!selectedIds.size) {
    alert('명령을 보낼 대상 PC를 먼저 체크하세요.');
    return;
  }

  const targetNames = agents
    .filter((a) => selectedIds.has(a.machine_id))
    .map((a) => a.hostname);
  const previewNames =
    targetNames.length <= 3
      ? targetNames.join(', ')
      : `${targetNames.slice(0, 3).join(', ')} 외 ${targetNames.length - 3}대`;

  const actionLabels: Record<string, string> = {
    scan: '업데이트 스캔',
    install_all: '차단 외 업데이트 일괄 설치',
    reboot: '원격 재부팅 (30초 후 재시작)',
    shutdown: '원격 전원 종료 (30초 후 종료)',
  };
  const label = actionLabels[type] || type;

  if (
    !window.confirm(
      `선택한 ${selectedIds.size}대 PC (${previewNames})에 [${label}] 명령을 전송하시겠습니까?`
    )
  ) {
    return;
  }

  await apiFetch('/commands', { machine_ids: Array.from(selectedIds), type });
  showToast(`✓ ${selectedIds.size}대 PC에 [${label}] 명령을 전송했습니다.`);
  fetchState();
};

  const addGlobalRule = async (action: 'block' | 'allow' | 'none', targetKb?: string) => {
    const kb = (targetKb || kbInput).trim().toUpperCase();
    if (!/^KB\d{5,8}$/.test(kb)) return alert('KB 번호 형식이 올바르지 않습니다 (예: KB5050009)');
    await apiFetch('/rules', { kb, ring: ruleScope, action });
    if (!targetKb) setKbInput('');
    fetchState();
  };

  const filteredEvents = state.events.filter((ev) => {
    if (!logSearch.trim()) return true;
    const q = logSearch.toLowerCase();
    return ev.host.toLowerCase().includes(q) || ev.msg.toLowerCase().includes(q);
  });

  const isPcMenuActive = activeMenu === 'pcs-managed' || activeMenu === 'pcs-pending';

  return (
    <div className="app-layout">
      {toastMsg && (
  <div
    style={{
      position: 'fixed',
      top: 18,
      right: 24,
      zIndex: 9999,
      background: 'var(--accent-primary, #0284c7)',
      color: '#ffffff',
      padding: '10px 18px',
      borderRadius: 8,
      fontWeight: 600,
      fontSize: 13,
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    }}
  >
    {toastMsg}
  </div>
)}
      {/* 좌측 고정 사이드바 메뉴 */}
      <aside className="sidebar">
        <div className="brand-group">
          <div className="brand-logo mono">AU</div>
          <div>
            <h1 className="brand-title">AURORA Control</h1>
            <p className="brand-sub">중앙 업데이트 관제</p>
          </div>
        </div>

        <nav className="nav-section">
          <button
            className={`nav-item ${activeMenu === 'dashboard' ? 'active' : ''}`}
            onClick={() => navigateToMenu('dashboard')}
          >
            <span className="nav-item-left">
              <LayoutDashboard size={16} />
              <span>대시보드 요약</span>
            </span>
          </button>

          {/* PC 관리 + 하위 메뉴 (관리중 PC / 승인 대기 PC) */}
          <div>
            <button
              className={`nav-item ${isPcMenuActive ? 'active' : ''}`}
              onClick={() => {
                setPcMenuOpen((o) => !o);
                if (!isPcMenuActive) {
                  setActiveMenu(pending.length > 0 ? 'pcs-pending' : 'pcs-managed');
                }
              }}
            >
              <span className="nav-item-left">
                <Monitor size={16} />
                <span>PC 관리</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {pending.length > 0 && <span className="badge-count">+{pending.length}</span>}
                {pcMenuOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </button>

            {pcMenuOpen && (
              <div className="nav-sub-group">
                <button
                  className={`nav-sub-item ${activeMenu === 'pcs-managed' ? 'active' : ''}`}
                  onClick={() => setActiveMenu('pcs-managed')}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span>관리중 PC</span>
                  <span className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
                    {agents.length}
                  </span>
                </button>
                <button
                  className={`nav-sub-item ${activeMenu === 'pcs-pending' ? 'active' : ''}`}
                  onClick={() => setActiveMenu('pcs-pending')}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span>승인 대기 PC</span>
                  {pending.length > 0 ? (
                    <span className="badge-count" style={{ fontSize: 10, padding: '1px 6px' }}>
                      {pending.length}
                    </span>
                  ) : (
                    <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>
                      0
                    </span>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* 레지스트리 정책 확인 + 하위 메뉴 */}
          <div>
            <button
              className={`nav-item ${
                activeMenu === 'policy-registry' || activeMenu === 'policy-rules' ? 'active' : ''
              }`}
              onClick={() => {
                setPolicyMenuOpen((o) => !o);
                if (activeMenu !== 'policy-registry' && activeMenu !== 'policy-rules') {
                  setActiveMenu('policy-registry');
                }
              }}
            >
              <span className="nav-item-left">
                <Shield size={16} />
                <span>레지스트리 정책 확인</span>
              </span>
              {policyMenuOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>

            {policyMenuOpen && (
              <div className="nav-sub-group">
                <button
                  className={`nav-sub-item ${activeMenu === 'policy-registry' ? 'active' : ''}`}
                  onClick={() => setActiveMenu('policy-registry')}
                >
                  레지스트리 정책 관리
                </button>
                <button
                  className={`nav-sub-item ${activeMenu === 'policy-rules' ? 'active' : ''}`}
                  onClick={() => setActiveMenu('policy-rules')}
                >
                  Windows 업데이트 규칙
                </button>
              </div>
            )}
          </div>

          <button
            className={`nav-item ${activeMenu === 'logs' ? 'active' : ''}`}
            onClick={() => navigateToMenu('logs')}
          >
            <span className="nav-item-left">
              <Terminal size={16} />
              <span>로그 관리</span>
            </span>
          </button>

          <button
            className={`nav-item ${activeMenu === 'settings' ? 'active' : ''}`}
            onClick={() => navigateToMenu('settings')}
          >
            <span className="nav-item-left">
              <Settings size={16} />
              <span>설정</span>
            </span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div style={{ color: '#10b981', fontWeight: 600 }}>● 관제 서버 정상 가동 중</div>
          <div style={{ marginTop: 4, fontSize: 11 }}>
            테마: {THEMES.find((t) => t.key === theme)?.label}
          </div>
        </div>
      </aside>

      {/* 우측 페이지 본문 */}
      <main className="content-area">
        {/* ============================================================
            1. 대시보드 요약 (핵심 KPI 바로가기 + 신규 승인 배너 + 30초 자동갱신 로그)
           ============================================================ */}
        {activeMenu === 'dashboard' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">관제 요약 대시보드</h2>
                <p className="page-desc">
                  전체 엔드포인트 현황 요약 및 실시간 감사 로그 (30초마다 자동 갱신 · 마지막 동기화:{' '}
                  {lastRefreshed.toLocaleTimeString('ko-KR')})
                </p>
              </div>
              <button onClick={fetchState} className="btn btn-ghost">
                <RefreshCw size={13} style={{ color: 'var(--accent-text)' }} /> 지금 새로고침
              </button>
            </div>

            <div className="kpi-grid">
              <div
                className="glass-card kpi-card"
                onClick={() => navigateToMenu('policy-registry')}
                style={{ cursor: 'pointer' }}
                title="레지스트리 정책 관리로 이동"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="kpi-label">정책 준수율</span>
                  <ArrowUpRight size={14} style={{ color: 'var(--text-muted)' }} />
                </div>
                <span className="kpi-value mono" style={{ color: 'var(--accent-text)' }}>
                  {agents.length ? `${compliancePct}%` : '–'}
                </span>
                <span className="kpi-sub">목표 배포 그룹 정책 해시 일치 비율</span>
              </div>

              <div
                className="glass-card kpi-card"
                onClick={() => navigateToMenu('pcs-managed')}
                style={{ cursor: 'pointer' }}
                title="관리중 PC 목록으로 바로가기"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="kpi-label">온라인 에이전트</span>
                  <ArrowUpRight size={14} style={{ color: '#10b981' }} />
                </div>
                <span className="kpi-value mono" style={{ color: '#10b981' }}>
                  {agents.filter(isOnline).length}
                  <span style={{ fontSize: 15, color: 'var(--text-muted)' }}> / {agents.length}대</span>
                </span>
                <span className="kpi-sub">클릭하여 관리중 PC 목록 바로가기 →</span>
              </div>

              <div
                className="glass-card kpi-card"
                onClick={() => navigateToMenu('pcs-pending')}
                style={{ cursor: 'pointer' }}
                title="승인 대기 PC 목록으로 바로가기"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="kpi-label">신규 승인 대기</span>
                  <ArrowUpRight size={14} style={{ color: '#d97706' }} />
                </div>
                <span className="kpi-value mono" style={{ color: '#d97706' }}>
                  {pending.length}대
                </span>
                <span className="kpi-sub">클릭하여 승인 대기 PC 바로가기 →</span>
              </div>

              <div
                className="glass-card kpi-card"
                onClick={() => navigateToMenu('pcs-managed')}
                style={{ cursor: 'pointer' }}
                title="관리중 PC 목록으로 이동"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="kpi-label">재부팅 대기 PC</span>
                  <ArrowUpRight size={14} style={{ color: '#e11d48' }} />
                </div>
                <span className="kpi-value mono" style={{ color: '#e11d48' }}>
                  {agents.filter((a) => a.reboot_required).length}대
                </span>
                <span className="kpi-sub">패치 완료 후 재시작 필요</span>
              </div>
            </div>

            {pending.length > 0 && (
              <section className="pending-banner">
                <div className="pending-header" style={{ justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ShieldCheck size={18} />
                    <span>신규 에이전트 등록 요청 ({pending.length}대) — 즉시 승인 가능</span>
                  </div>
                  <button
                    onClick={() => navigateToMenu('pcs-pending')}
                    className="btn btn-ghost"
                    style={{ fontSize: 12 }}
                  >
                    승인 대기 PC 전체 보기 →
                  </button>
                </div>
                <div className="pending-grid">
                  {pending.map((p) => (
                    <div key={p.machine_id} className="pending-card">
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong>{p.hostname}</strong>
                          <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            {p.ip}
                          </span>
                        </div>
                        <div className="mono" style={{ marginTop: 4, fontSize: 11, color: 'var(--accent-text)' }}>
                          토큰: {p.token_preview}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select id={`dash-ring-${p.machine_id}`} defaultValue="ring1" className="select-dark mono">
                          {Object.keys(state.policies).map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            const sel = document.getElementById(`dash-ring-${p.machine_id}`) as HTMLSelectElement;
                            handleDecision(p.machine_id, true, sel.value);
                          }}
                          className="btn btn-approve"
                        >
                          <CheckCircle2 size={14} /> 승인
                        </button>
                        <button onClick={() => handleDecision(p.machine_id, false)} className="btn btn-rose">
                          <XCircle size={14} /> 거부
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="glass-card panel">
              <div className="panel-header">
                <h3 className="panel-title">
                  <Terminal size={16} style={{ color: 'var(--accent-text)' }} />
                  <span>실시간 관제 요약 로그 (최근 80건 · 30초 자동 갱신)</span>
                </h3>
                <button onClick={() => navigateToMenu('logs')} className="btn btn-ghost">
                  전체 로그 검색 보기 →
                </button>
              </div>
              <div className="log-box mono" style={{ height: 420 }}>
                {state.events.map((ev) => (
                  <div key={ev.id} className="log-line">
                    <span style={{ color: 'var(--text-muted)' }}>
                      {new Date(ev.ts * 1000).toLocaleTimeString('ko-KR')}
                    </span>{' '}
                    <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>[{ev.host}]</span>{' '}
                    <span>{ev.msg}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {/* ============================================================
            2-1. 관리중 PC (승인 완료 엔드포인트 목록 + 검색 + 정렬 + 원격 제어)
           ============================================================ */}
        {activeMenu === 'pcs-managed' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">관리중 PC ({processedAgents.length} / {agents.length}대)</h2>
                <p className="page-desc">
                  승인 완료된 관리 대상 PC입니다. 이름·IP·MAC·OS로 검색하거나 컬럼 헤더를 클릭해 정렬할 수 있습니다.
                </p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {pending.length > 0 && (
                  <button
                    onClick={() => navigateToMenu('pcs-pending')}
                    className="btn btn-amber"
                  >
                    <ShieldCheck size={13} /> 승인 대기 PC ({pending.length}대)
                  </button>
                )}
                <div style={{ position: 'relative' }}>
                  <input
                    value={pcSearch}
                    onChange={(e) => setPcSearch(e.target.value)}
                    placeholder="PC 이름, IP, MAC, OS 검색..."
                    className="input-dark"
                    style={{ width: 240, paddingLeft: 32 }}
                  />
                  <Search
                    size={14}
                    style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }}
                  />
                </div>
                <button onClick={() => sendBatchCmd('scan')} className="btn btn-ghost">
                  <RefreshCw size={13} style={{ color: 'var(--accent-text)' }} /> 선택 스캔
                </button>
                <button onClick={() => sendBatchCmd('install_all')} className="btn btn-emerald">
                  <Download size={13} /> 차단 외 일괄 설치
                </button>
                <button onClick={() => sendBatchCmd('reboot')} className="btn btn-amber">
                  <RotateCcw size={13} /> 선택 재부팅 (30초)
                </button>
                <button onClick={() => sendBatchCmd('shutdown')} className="btn btn-amber">
                  <Power size={13} /> 선택 전원 종료 (30초)
                </button>
              </div>
            </div>

            <section className="glass-card panel">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          checked={
                            processedAgents.length > 0 &&
                            processedAgents.every((a) => selectedIds.has(a.machine_id))
                          }
                          onChange={(e) =>
                            setSelectedIds(
                              e.target.checked
                                ? new Set(processedAgents.map((a) => a.machine_id))
                                : new Set()
                            )
                          }
                        />
                      </th>
                      <th className="sortable" onClick={() => toggleSort('hostname')}>
                        컴퓨터 이름 / 네트워크 <ArrowUpDown size={11} style={{ verticalAlign: 'middle' }} />
                      </th>
                      <th className="sortable" onClick={() => toggleSort('os_name')}>
                        운영체제 / 빌드 <ArrowUpDown size={11} style={{ verticalAlign: 'middle' }} />
                      </th>
                      <th>하드웨어 사양 (CPU / RAM)</th>
                      <th className="sortable" onClick={() => toggleSort('last_seen')}>
                        마지막 접속 확인 <ArrowUpDown size={11} style={{ verticalAlign: 'middle' }} />
                      </th>
                      <th className="sortable" onClick={() => toggleSort('ring')}>
                        배포 그룹 <ArrowUpDown size={11} style={{ verticalAlign: 'middle' }} />
                      </th>
                      <th>정책</th>
                      <th className="sortable" onClick={() => toggleSort('pend')}>
                        대기 KB <ArrowUpDown size={11} style={{ verticalAlign: 'middle' }} />
                      </th>
                      <th>재부팅</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processedAgents.map((a) => (
                      <tr key={a.machine_id} onClick={() => setActiveAgent(a)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(a.machine_id)}
                            onChange={(e) => {
                              const next = new Set(selectedIds);
                              e.target.checked ? next.add(a.machine_id) : next.delete(a.machine_id);
                              setSelectedIds(next);
                            }}
                          />
                        </td>
                        <td>
                          <div style={{ fontWeight: 700 }}>
                            <span className={`dot ${isOnline(a) ? 'dot-online' : 'dot-offline'}`} />
                            {a.hostname}
                          </div>
                          <div className="hw-spec-cell" style={{ paddingLeft: 15, marginTop: 4 }}>
                            <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                              IP: {a.ip}
                            </span>
                            <span className="hw-chip mono">
                              <Network size={10} /> {a.mac_addr || '-'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{a.os_name}</div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            Build {a.os_build}
                          </div>
                        </td>
                        <td>
                          <div className="hw-spec-cell">
                            <span className="hw-chip" title={a.cpu_info}>
                              <Cpu size={11} />
                              <span style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {a.cpu_info || '-'}
                              </span>
                            </span>
                            <span className="hw-chip mono">
                              <HardDrive size={11} /> RAM: {a.ram_gb || '-'}
                            </span>
                          </div>
                        </td>
                        <td className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                          {formatLastSeen(a.last_seen)}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <select
                            value={a.ring}
                            onChange={async (e) => {
                              await apiFetch(`/agents/${a.machine_id}/ring`, { ring: e.target.value });
                              fetchState();
                            }}
                            className="select-dark mono"
                          >
                            {Object.keys(state.policies).map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span className={`badge ${isApplied(a) ? 'badge-ok' : 'badge-warn'}`}>
                            {isApplied(a) ? '적용됨' : '대기'}
                          </span>
                        </td>
                        <td className="mono" style={{ fontWeight: 700 }}>{a.pend.length}건</td>
                        <td>
                          {a.reboot_required ? (
                            <span className="badge badge-danger">필요</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>–</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {processedAgents.length === 0 && (
                      <tr>
                        <td colSpan={9} style={{ padding: 44, textAlign: 'center', color: 'var(--text-secondary)' }}>
                          {agents.length === 0
                            ? '현재 승인된 관리중 PC가 없습니다. [승인 대기 PC] 탭에서 신규 에이전트를 승인해 주세요.'
                            : '검색 조건에 일치하는 PC가 없습니다.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ============================================================
            2-2. 승인 대기 PC (신규 에이전트 토큰 대조 및 배포 그룹 배정 승인)
           ============================================================ */}
        {activeMenu === 'pcs-pending' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">승인 대기 PC ({pending.length}대)</h2>
                <p className="page-desc">
                  에이전트가 설치되어 등록을 요청한 신규 PC 목록입니다. 인증 토큰을 확인하고 배포 그룹을 지정해 승인하세요.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => navigateToMenu('pcs-managed')} className="btn btn-ghost">
                  관리중 PC ({agents.length}대) 보기 →
                </button>
                <button onClick={fetchState} className="btn btn-ghost">
                  <RefreshCw size={13} style={{ color: 'var(--accent-text)' }} /> 새로고침
                </button>
              </div>
            </div>

            {pending.length > 0 ? (
              <section className="glass-card panel">
                <div className="pending-grid">
                  {pending.map((p) => (
                    <div key={p.machine_id} className="pending-card">
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong style={{ fontSize: 15 }}>{p.hostname}</strong>
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                            {p.ip}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                          {p.os_name} ({p.os_build})
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          Machine ID: {p.machine_id}
                        </div>
                        <div className="mono" style={{ fontSize: 11.5, color: 'var(--accent-text)', marginTop: 4 }}>
                          인증 토큰: {p.token_preview}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        <select id={`pending-ring-${p.machine_id}`} defaultValue="ring1" className="select-dark mono">
                          {Object.keys(state.policies).map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            const sel = document.getElementById(`pending-ring-${p.machine_id}`) as HTMLSelectElement;
                            handleDecision(p.machine_id, true, sel.value);
                          }}
                          className="btn btn-approve"
                        >
                          <CheckCircle2 size={14} /> 승인 등록
                        </button>
                        <button onClick={() => handleDecision(p.machine_id, false)} className="btn btn-rose">
                          <XCircle size={14} /> 거부
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <section className="glass-card panel" style={{ padding: 56, textAlign: 'center' }}>
                <ShieldCheck size={32} style={{ color: 'var(--text-muted)', marginBottom: 10 }} />
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                  현재 승인 대기 중인 PC가 없습니다.
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  대상 PC에서 AURORA Update Agent 서비스를 시작하고 관제 서버 주소를 저장하면 이곳에 자동으로 표시됩니다.
                </div>
              </section>
            )}
          </>
        )}

        {/* ============================================================
            3-1. 레지스트리 정책 관리 (드롭다운 그룹 선택 + 이름 변경 + 추가/삭제)
           ============================================================ */}
        {activeMenu === 'policy-registry' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">레지스트리 정책 관리</h2>
                <p className="page-desc">
                  드롭다운에서 배포 그룹(Ring)을 선택하거나 이름 변경·신규 생성 후 각 정책 블록을 활성화하세요.
                </p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <select
                  value={ringTab}
                  onChange={(e) => {
                    setRingTab(e.target.value);
                    setLoadedRing('');
                    setRingModalMode('none');
                  }}
                  className="select-dark mono"
                  style={{ minWidth: 160, fontWeight: 700 }}
                >
                  {Object.keys(state.policies).map((r) => (
                    <option key={r} value={r}>
                      배포 그룹: {r}
                    </option>
                  ))}
                </select>

                {ringModalMode === 'none' ? (
                  <>
                    <button
                      onClick={() => {
                        setRingNameInput(ringTab);
                        setRingModalMode('rename');
                      }}
                      className="btn btn-ghost"
                    >
                      <Edit3 size={13} /> 이름 변경
                    </button>
                    <button
                      onClick={() => {
                        setRingNameInput('');
                        setRingModalMode('create');
                      }}
                      className="btn btn-ghost"
                    >
                      <Plus size={14} style={{ color: 'var(--accent-text)' }} /> 그룹 추가
                    </button>
                    {ringTab !== 'ring0' && ringTab !== 'ring1' && (
                      <button onClick={handleDeleteRing} className="btn btn-rose">
                        <Trash2 size={13} /> 삭제
                      </button>
                    )}
                  </>
                ) : (
                  <form onSubmit={handleRingSubmit} style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={ringNameInput}
                      onChange={(e) => setRingNameInput(e.target.value)}
                      placeholder={ringModalMode === 'create' ? '새 그룹 이름 입력' : '변경할 이름 입력'}
                      className="input-dark"
                      style={{ width: 160 }}
                      autoFocus
                    />
                    <button type="submit" className="btn btn-emerald">
                      {ringModalMode === 'create' ? '생성' : '변경 저장'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRingModalMode('none')}
                      className="btn btn-ghost"
                    >
                      취소
                    </button>
                  </form>
                )}

                <button onClick={() => setShowRawJson((v) => !v)} className="btn btn-ghost">
                  <Code2 size={14} /> {showRawJson ? '기능 블록 보기' : '원본 JSON'}
                </button>
                <button onClick={savePolicyBlocks} className="btn btn-primary">
                  정책 저장 및 즉시 배포
                </button>
              </div>
            </div>

            {!showRawJson ? (
              <div className="policy-blocks-grid">
                {REGISTRY_BLOCKS.map((blk) => {
                  const curVal = getItemValue(blk.path, blk.name);
                  const isEnabled = curVal === blk.enabledValue;

                  return (
                    <div key={blk.id} className={`policy-block ${isEnabled ? 'enabled' : ''}`}>
                      <div>
                        <div className="policy-block-top">
                          <h3 className="policy-block-title">{blk.title}</h3>
                          <div className="toggle-pill">
                            <button
                              type="button"
                              className={`toggle-opt ${isEnabled ? 'on' : ''}`}
                              onClick={() => toggleBlock(blk, true)}
                            >
                              활성화
                            </button>
                            <button
                              type="button"
                              className={`toggle-opt ${!isEnabled ? 'off' : ''}`}
                              onClick={() => toggleBlock(blk, false)}
                            >
                              비활성화
                            </button>
                          </div>
                        </div>
                        <p className="policy-block-desc">{blk.desc}</p>
                      </div>

                      {isEnabled && blk.hasParam === 'days' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span>지연 기간(일):</span>
                          <input
                            type="number"
                            min={0}
                            max={365}
                            value={Number(getItemValue(blk.path, blk.paramName!) ?? 7)}
                            onChange={(e) =>
                              setItemValue(blk.path, blk.paramName!, 'DWORD', parseInt(e.target.value, 10) || 0)
                            }
                            className="input-dark mono"
                            style={{ width: 84 }}
                          />
                          <span style={{ color: 'var(--text-secondary)' }}>일 후 설치 허용</span>
                        </div>
                      )}

                      {isEnabled && blk.hasParam === 'version' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span>목표 빌드 버전:</span>
                          <input
                            type="text"
                            value={String(getItemValue(blk.path, blk.paramName!) ?? defaultTargetRelease)}
                            onChange={(e) => {
                              setItemValue(blk.path, 'ProductVersion', 'SZ', 'Windows 11');
                              setItemValue(blk.path, blk.paramName!, 'SZ', e.target.value.trim());
                            }}
                            placeholder={`예: ${defaultTargetRelease}`}
                            className="input-dark mono"
                            style={{ width: 110 }}
                          />
                        </div>
                      )}

                      <div className="policy-block-meta mono">
                        HKLM\{blk.path}\{blk.name} = {curVal !== undefined ? String(curVal) : '미설정(0)'}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <section className="glass-card panel">
                <textarea
                  value={JSON.stringify(draftItems, null, 2)}
                  onChange={(e) => {
                    try {
                      setDraftItems(JSON.parse(e.target.value));
                    } catch {}
                  }}
                  spellCheck={false}
                  className="textarea-dark mono"
                  style={{ minHeight: 360 }}
                />
              </section>
            )}
          </>
        )}

        {/* ============================================================
            3-2. Windows 업데이트 규칙 (상단: Win11 수집/요약 목록 + 하단: 차단·허용 규칙)
           ============================================================ */}
        {activeMenu === 'policy-rules' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">Windows 업데이트 규칙 (KB 차단 / 허용)</h2>
                <p className="page-desc">
                  수집된 Windows 11 업데이트 요약 내역을 검토하고 문제가 우려되는 패치를 선택해 즉시 차단할 수 있습니다.
                </p>
              </div>
              <button
                onClick={async () => {
                  await apiFetch('/catalog/sync', {});
                  fetchState();
                }}
                className="btn btn-primary"
              >
                <RefreshCw size={13} /> 지금 업데이트 목록 수집
              </button>
            </div>

            <section className="glass-card panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">
                    수집된 Windows 11 업데이트 및 내용 요약 ({(state.catalog || []).length}건)
                  </h3>
                  <p className="page-desc">
                    사내 PC에 이미 설치되었거나 대기 중인 업데이트, 그리고 Microsoft 최신 배포 패치 내역입니다.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>차단 적용 대상:</span>
                  <select
                    value={ruleScope}
                    onChange={(e) => setRuleScope(e.target.value)}
                    className="select-dark mono"
                  >
                    <option value="*">전체 그룹 (*)</option>
                    {Object.keys(state.policies).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>KB 번호</th>
                      <th style={{ width: 135 }}>분류 / 릴리스</th>
                      <th>업데이트 명칭 및 핵심 내용 요약</th>
                      <th style={{ width: 130 }}>사내 현황</th>
                      <th style={{ width: 110, textAlign: 'right' }}>빠른 조치</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(state.catalog || []).map((item) => {
                      const isBlocked = state.rules.some(
                        (r) => r.kb === item.kb && r.action === 'block' && (r.ring === '*' || r.ring === ruleScope)
                      );
                      return (
                        <tr key={item.kb} style={{ cursor: 'default' }}>
                          <td className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)' }}>
                            {item.kb}
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: 11.5 }}>{item.category}</div>
                            <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {item.release_date}
                            </div>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, marginBottom: 3 }}>{item.title}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                              {item.summary}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <span className="badge badge-ok">설치됨 {item.installed_count}대</span>
                              {item.pending_count > 0 && (
                                <span className="badge badge-warn">대기중 {item.pending_count}대</span>
                              )}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {isBlocked ? (
                              <span className="badge badge-danger">차단 등록됨</span>
                            ) : (
                              <button
                                onClick={() => addGlobalRule('block', item.kb)}
                                className="btn btn-rose"
                                style={{ padding: '5px 10px', fontSize: 11.5 }}
                              >
                                선택 차단
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {(state.catalog || []).length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                          아직 수집된 업데이트가 없습니다. 우측 상단의 [지금 업데이트 목록 수집] 버튼을 눌러주세요.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="glass-card panel">
              <div className="panel-header">
                <h3 className="panel-title">적용 중인 KB 차단 / 허용 규칙 ({state.rules.length}건)</h3>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
                <select
                  value={ruleScope}
                  onChange={(e) => setRuleScope(e.target.value)}
                  className="select-dark mono"
                >
                  <option value="*">전체 그룹 (*)</option>
                  {Object.keys(state.policies).map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <input
                  value={kbInput}
                  onChange={(e) => setKbInput(e.target.value)}
                  placeholder="KB 번호 직접 입력 (예: KB5050009)"
                  className="input-dark mono"
                  style={{ flex: 1, minWidth: 220 }}
                />
                <button onClick={() => addGlobalRule('block')} className="btn btn-rose">
                  차단(자동 숨김) 등록
                </button>
                <button onClick={() => addGlobalRule('allow')} className="btn btn-emerald">
                  허용 등록
                </button>
              </div>

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>KB 번호</th>
                      <th>적용 범위</th>
                      <th>동작 정책</th>
                      <th style={{ textAlign: 'right' }}>규칙 해제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rules.map((r, idx) => (
                      <tr key={idx} style={{ cursor: 'default' }}>
                        <td className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)' }}>{r.kb}</td>
                        <td className="mono">{r.ring === '*' ? '전체 그룹 (*)' : r.ring}</td>
                        <td>
                          <span className={`badge ${r.action === 'block' ? 'badge-danger' : 'badge-ok'}`}>
                            {r.action === 'block' ? '차단 (숨김 처리)' : '허용'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            onClick={() =>
                              apiFetch('/rules', { kb: r.kb, ring: r.ring, action: 'none' }).then(fetchState)
                            }
                            className="btn btn-ghost"
                            style={{ padding: '4px 10px', fontSize: 11.5 }}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                    {state.rules.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                          등록된 KB 차단·허용 규칙이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ============================================================
            4. 로그 관리
           ============================================================ */}
        {activeMenu === 'logs' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">감사 및 에이전트 로그 관리</h2>
                <p className="page-desc">
                  콘솔 정책 배포 이력, 에이전트 승인·종료 보고, 패치 설치 결과를 검색하고 추적합니다.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ position: 'relative' }}>
                  <input
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder="PC 이름 또는 로그 내용 검색..."
                    className="input-dark"
                    style={{ width: 260, paddingLeft: 32 }}
                  />
                  <Search
                    size={14}
                    style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }}
                  />
                </div>
                <button onClick={fetchState} className="btn btn-ghost">
                  <RefreshCw size={13} style={{ color: 'var(--accent-text)' }} /> 새로고침
                </button>
              </div>
            </div>

            <section className="glass-card panel">
              <div className="log-box mono" style={{ height: 560 }}>
                {filteredEvents.map((ev) => (
                  <div key={ev.id} className="log-line">
                    <span style={{ color: 'var(--text-muted)' }}>
                      {new Date(ev.ts * 1000).toLocaleString('ko-KR')}
                    </span>{' '}
                    <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>[{ev.host}]</span>{' '}
                    <span>{ev.msg}</span>
                  </div>
                ))}
                {filteredEvents.length === 0 && (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                    일치하는 로그 기록이 없습니다.
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {/* ============================================================
            5. 설정 탭 (관리자 토큰 관리 + Windows 시작 시 옵션 + 5종 테마)
           ============================================================ */}
        {activeMenu === 'settings' && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">콘솔 환경 설정</h2>
                <p className="page-desc">
                  화면 색상 테마, 관리자 인증 토큰, Windows 시작 시 자동 실행 옵션을 관리합니다.
                </p>
              </div>
            </div>

            <section className="glass-card panel">
              <div className="panel-header">
                <h3 className="panel-title">화면 테마 설정</h3>
              </div>
              <div className="theme-grid">
                {THEMES.map((t) => (
                  <div
                    key={t.key}
                    onClick={() => setTheme(t.key)}
                    className={`theme-card ${theme === t.key ? 'active' : ''}`}
                    style={{ background: t.bg, color: t.fg }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          background: t.accent,
                          display: 'inline-block',
                        }}
                      />
                      {theme === t.key && <CheckCircle2 size={15} style={{ color: t.accent }} />}
                    </div>
                    <strong style={{ fontSize: 13 }}>{t.label}</strong>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>가나다 ABC 123</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-card panel">
              <div className="panel-header">
                <h3 className="panel-title">
                  <KeyRound size={16} style={{ color: 'var(--accent-text)' }} />
                  <span>관리자 인증 토큰 관리</span>
                </h3>
              </div>
              <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                외부 웹 브라우저에서 관제 서버(`http://서버IP:8080`)에 접속할 때 사용하는 마스터 관리자 토큰입니다.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <input
                  type="text"
                  readOnly
                  value={token}
                  className="input-dark mono"
                  style={{ flex: 1, minWidth: 260 }}
                />
                <button onClick={copyToken} className="btn btn-primary">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? '복사 완료' : '토큰 복사'}</span>
                </button>
                <button
                  onClick={() => {
                    if (confirm('현재 세션의 관리자 토큰을 해제하고 로그인 화면으로 이동할까요?')) {
                      setAdminToken('');
                      setTokenState('');
                    }
                  }}
                  className="btn btn-rose"
                >
                  <LogOut size={14} /> 토큰 로그아웃
                </button>
              </div>
            </section>

            <section className="glass-card panel">
              <div className="panel-header">
                <h3 className="panel-title">Windows 시작 시 실행 옵션</h3>
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                  cursor: 'pointer',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    Windows 로그인 시 AURORA Control Console 자동 시작
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                    서버 PC가 재부팅되어도 중앙 관제 서버와 백그라운드 API 엔진이 즉시 자동으로 가동됩니다.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => toggleAutoStart(e.target.checked)}
                  style={{ width: 20, height: 20, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                />
              </label>
            </section>
          </>
        )}
      </main>

      {/* 개별 PC 제어 드로어 */}
      <AgentDrawer
        agent={activeAgent}
        onClose={() => setActiveAgent(null)}
        onRefresh={fetchState}
      />
    </div>
  );
}