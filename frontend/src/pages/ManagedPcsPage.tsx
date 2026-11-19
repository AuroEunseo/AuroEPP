import React, { useMemo, useState } from 'react';
import { ArrowUpDown, Cpu, Download, HardDrive, Network, Power, RefreshCw, RotateCcw, Search, ShieldCheck } from 'lucide-react';
import { apiFetch, errorMessage } from '../api';
import { useConsole } from '../context/ConsoleContext';
import { Agent } from '../types';
import { formatLastSeen } from '../utils/format';
import { isAgentOnline, isPolicyApplied } from '../utils/agent';

type SortField = 'hostname' | 'os_name' | 'last_seen' | 'ring' | 'pend';

/** 2-1. 관리중 PC (검색·정렬·선택, 원격 명령, 업데이트 다시 검색, 배포 그룹 변경) */
export const ManagedPcsPage: React.FC = () => {
  const { state, fetchState, showToast, navigate, openAgent: setActiveAgent } = useConsole();
  const agents = state.agents;
  const pending = state.pending_agents || [];
  const isOnline = (a: Agent) => isAgentOnline(a, state.now);
  const isApplied = isPolicyApplied;

  // 검색, 정렬, 선택 (이 화면 전용 — 다른 메뉴로 이동하면 선택은 초기화됨)
  const [pcSearch, setPcSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('hostname');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scanBusy, setScanBusy] = useState(false);

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

  // PC 목록 검색 + 정렬
  const processedAgents = useMemo(() => {
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

  return (
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
  );
};
