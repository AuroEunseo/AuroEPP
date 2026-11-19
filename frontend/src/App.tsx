import React, { useEffect, useState, useMemo } from 'react';
import {
  ShieldCheck,
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
  Power,
} from 'lucide-react';
import { Agent, MenuKey } from './types';
import { apiFetch, errorMessage } from './api';
import { AgentDrawer } from './components/AgentDrawer';
import { LoginScreen } from './components/LoginScreen';
import { StartupLoading } from './components/StartupLoading';
import { DashboardPage } from './pages/DashboardPage';
import { PendingPcsPage } from './pages/PendingPcsPage';
import { RejectedPcsPage } from './pages/RejectedPcsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { REGISTRY_BLOCKS, PolicyBlockDef } from './constants/registryBlocks';
import { formatLastSeen } from './utils/format';
import { isAgentOnline, isPolicyApplied } from './utils/agent';
import { useToast } from './hooks/useToast';
import { useTheme } from './hooks/useTheme';
import { useAuthFlow } from './hooks/useAuthFlow';
import { useDashboardData } from './hooks/useDashboardData';
import { ConsoleProvider } from './context/ConsoleContext';
import { Sidebar } from './layout/Sidebar';
import { Toast } from './layout/Toast';

type SortField = 'hostname' | 'os_name' | 'last_seen' | 'ring' | 'pend';

export default function App() {
  const { toastMsg, showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const auth = useAuthFlow();
  const { phase, username, role, forcePwChange, goLogin, logout } = auth;
  const { state, lastRefreshed, activeAgent, setActiveAgent, fetchState } = useDashboardData(phase, auth.handleApiError);
  const [scanBusy, setScanBusy] = useState(false);

  // 좌측 내비게이션 (메뉴 그룹 펼침 상태는 Sidebar 가 관리)
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');
  const navigate = setActiveMenu;

  // 로그아웃·세션 만료 후 다시 로그인하면 이전 사용자가 보던 메뉴가 아니라 대시보드부터 보여준다
  useEffect(() => {
    if (phase === 'login') {
      setActiveMenu('dashboard');
      setSelectedIds(new Set());
    }
  }, [phase]);

  // PC 관리 (검색, 정렬, 선택, 드로어)
  const [pcSearch, setPcSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('hostname');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  // [업데이트 다시 검색]: 업데이트 검색만 요청 (설치·규칙 적용 없음). 선택한 PC가 없으면 온라인 PC 전체
  const requestScan = async () => {
    const ids = Array.from(selectedIds);
    setScanBusy(true);
    try {
      const res = await apiFetch<{ sent: number; skipped: string[] }>('/scan', { machine_ids: ids });
      showToast(
        `✓ ${ids.length ? '선택한' : '온라인'} PC ${res.sent}대에 업데이트 검색을 요청했습니다.` +
          (res.skipped.length ? ` (오프라인 ${res.skipped.length}대 제외)` : '') +
          ' 결과는 검색이 끝나는 대로 자동 반영됩니다.'
      );
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setScanBusy(false);
    }
  };

  useEffect(() => {
    if (state && state.policies[ringTab] && loadedRing !== ringTab) {
      setDraftItems(JSON.parse(JSON.stringify(state.policies[ringTab].items || [])));
      setLoadedRing(ringTab);
    }
  }, [state, ringTab, loadedRing]);

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

  if (phase === 'login') {
    return (
      <LoginScreen
        forcePasswordChange={forcePwChange}
        usernameHint={username || undefined}
        onLoggedIn={auth.onLoggedIn}
      />
    );
  }

  if (phase === 'loading') {
    return <StartupLoading onReady={auth.onStartupReady} onUnauthorized={goLogin} />;
  }

  if (!state) {
    return (
      <div className="login-wrap mono" style={{ color: 'var(--accent-text)', fontSize: 14 }}>
        PC 목록을 불러오는 중입니다...
      </div>
    );
  }

  const agents = state.agents;
  const pending = state.pending_agents || [];
  const isOnline = (a: Agent) => isAgentOnline(a, state.now);
  const isApplied = isPolicyApplied;

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
    reboot: '원격 재부팅',
    shutdown: '원격 전원 종료',
  };
  const label = actionLabels[type] || type;

  const offlineCount = agents.filter((a) => selectedIds.has(a.machine_id) && !isOnline(a)).length;
  const offlineNote = offlineCount
    ? `\n\n※ 오프라인 ${offlineCount}대는 대기열에 보관했다가 다음 부팅(재연결) 시 바로 적용됩니다.` +
      (type === 'reboot' ? '\n   (재부팅은 그 사이 PC가 이미 켜졌다 꺼졌으므로 부팅 시 생략됩니다)' : '') +
      (type === 'shutdown' ? '\n   (해당 PC는 켜지자마자 30초 후 종료됩니다)' : '')
    : '';
  if (
    !window.confirm(
      `선택한 ${selectedIds.size}대 PC (${previewNames})에 [${label}] 명령을 전송하시겠습니까?${offlineNote}`
    )
  ) {
    return;
  }

  try {
    const res = await apiFetch<{ dispatched: number; queued: string[]; duplicate: string[] }>('/commands', {
      machine_ids: Array.from(selectedIds),
      type,
    });
    const parts = [`즉시 ${res.dispatched}대`];
    if (res.queued?.length) parts.push(`다음 부팅 시 적용 ${res.queued.length}대`);
    if (res.duplicate?.length) parts.push(`이미 대기 중 ${res.duplicate.length}대`);
    showToast(`✓ [${label}] 명령 전송: ${parts.join(' · ')}`);
  } catch (e) {
    alert(errorMessage(e));
  }
  fetchState();
};

  const addGlobalRule = async (action: 'block' | 'allow' | 'none', targetKb?: string) => {
    const kb = (targetKb || kbInput).trim().toUpperCase();
    if (!/^KB\d{5,8}$/.test(kb)) return alert('KB 번호 형식이 올바르지 않습니다 (예: KB5050009)');
    await apiFetch('/rules', { kb, ring: ruleScope, action });
    if (!targetKb) setKbInput('');
    fetchState();
  };

  const consoleValue = {
    state,
    fetchState,
    lastRefreshed,
    showToast,
    openAgent: setActiveAgent,
    activeMenu,
    navigate,
    username,
    role,
    logout,
    theme,
    setTheme,
  };

  return (
    <ConsoleProvider value={consoleValue}>
    <div className="app-layout">
      <Toast message={toastMsg} />
      <Sidebar />

      {/* 우측 페이지 본문 */}
      <main className="content-area">
        {activeMenu === 'dashboard' && <DashboardPage />}


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
                    onClick={() => navigate('pcs-pending')}
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
                <button
                  onClick={requestScan}
                  className="btn btn-ghost"
                  disabled={scanBusy}
                  title="Windows 업데이트 목록만 다시 검색합니다 (설치하지 않음). 선택한 PC가 없으면 온라인 PC 전체"
                >
                  <RefreshCw size={13} style={{ color: 'var(--accent-text)' }} />{' '}
                  {selectedIds.size ? `선택 PC 업데이트 다시 검색 (${selectedIds.size})` : '업데이트 다시 검색'}
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
                            {a.reconnect_waiting && (
                              <span className="badge badge-warn" style={{ marginLeft: 6, fontSize: 10 }}>
                                재부팅 후 재연결 확인 중
                              </span>
                            )}
                            {!!a.queued_count && (
                              <span
                                className="badge badge-warn"
                                style={{ marginLeft: 6, fontSize: 10 }}
                                title="PC가 켜지면(재연결 시) 바로 적용됩니다"
                              >
                                대기 명령 {a.queued_count}건
                              </span>
                            )}
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

        {activeMenu === 'pcs-pending' && <PendingPcsPage />}


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

        {activeMenu === 'logs' && <LogsPage />}


        {activeMenu === 'notifications' && <NotificationsPage />}

        {activeMenu === 'pcs-rejected' && <RejectedPcsPage />}

        {activeMenu === 'settings' && <SettingsPage />}
      </main>

      {/* 개별 PC 제어 드로어 */}
      <AgentDrawer
        agent={activeAgent}
        onClose={() => setActiveAgent(null)}
        onRefresh={fetchState}
      />
    </div>
    </ConsoleProvider>
  );
}
