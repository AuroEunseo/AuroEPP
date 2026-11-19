import React, { useCallback, useEffect, useState } from 'react';
import { X, Download, EyeOff, Eye, ShieldOff, RefreshCw, Trash2, History, Undo2, Wrench, Clock } from 'lucide-react';
import { Agent, AgentDetail, QueuedCommand, RegistryChange } from '../types';
import { apiFetch, errorMessage } from '../api';
import {
  HISTORY_OP,
  HISTORY_RESULT,
  describeValue,
  registryLabel,
  rollbackPreview,
  summarizeChange,
} from '../registryLabels';

interface Props {
  agent: Agent | null;
  onClose: () => void;
  onRefresh: () => void;
}

const subCard: React.CSSProperties = {
  background: 'var(--bg-subcard)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 10,
};
const sectionTitle: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 13.5,
  fontWeight: 700,
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const ROLLBACK_STATE: Record<string, { text: string; cls: string }> = {
  requested: { text: '롤백 요청됨', cls: 'badge-warn' },
  done: { text: '롤백 완료', cls: 'badge-ok' },
  failed: { text: '롤백 실패', cls: 'badge-danger' },
};

function fmtTs(ts?: number | null) {
  return ts ? new Date(ts * 1000).toLocaleString('ko-KR') : '-';
}

export const AgentDrawer: React.FC<Props> = ({ agent, onClose, onRefresh }) => {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [historyRequested, setHistoryRequested] = useState<'idle' | 'queued' | 'offline'>('idle');
  const machineId = agent?.machine_id;

  const loadDetail = useCallback(async () => {
    if (!machineId) return;
    try {
      setDetail(await apiFetch<AgentDetail>(`/agents/${encodeURIComponent(machineId)}/detail`));
      setDetailError('');
    } catch (e) {
      setDetailError(errorMessage(e));
    }
  }, [machineId]);

  // 모달을 열 때만: 저장된 이력 조회 + 에이전트에 전체 이력 재보고 요청, 열려 있는 동안 5초마다 갱신
  useEffect(() => {
    setDetail(null);
    setHistoryRequested('idle');
    if (!machineId) return;
    loadDetail();
    apiFetch<{ queued: boolean }>(`/agents/${encodeURIComponent(machineId)}/history/refresh`, {})
      .then((r) => setHistoryRequested(r.queued ? 'queued' : 'offline'))
      .catch(() => setHistoryRequested('offline'));
    const id = window.setInterval(loadDetail, 5000);
    return () => window.clearInterval(id);
  }, [machineId, loadDetail]);

  if (!agent) return null;

  const sendCmd = async (type: string, payload: Record<string, any> = {}) => {
    try {
      const res = await apiFetch<{ dispatched: number; queued: string[]; duplicate: string[] }>('/commands', {
        machine_ids: [agent.machine_id],
        type,
        payload,
      });
      if (res.duplicate?.length) alert('같은 명령이 이미 대기 중입니다.');
      else if (res.queued?.length) alert(`${agent.hostname} PC가 오프라인이라 대기열에 보관했습니다.\n다음 부팅(재연결) 시 바로 적용됩니다.`);
      onRefresh();
      loadDetail();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const revokeToken = async () => {
    if (!confirm(`${agent.hostname}의 에이전트 토큰을 폐기하시겠습니까? 재인증 전까지 통신이 차단됩니다.`)) return;
    try {
      await apiFetch(`/agents/${encodeURIComponent(agent.machine_id)}/revoke`, {});
      onClose();
      onRefresh();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const deleteAgent = async () => {
    if (
      !confirm(
        `[${agent.hostname}] PC를 관제 목록에서 영구 삭제하시겠습니까?\n(해당 PC의 에이전트가 계속 실행 중이면 신규 승인 대기 요청으로 다시 등록됩니다.)`
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/agents/${encodeURIComponent(agent.machine_id)}`, undefined, 'DELETE');
      onClose();
      onRefresh();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const rollback = async (c: RegistryChange) => {
    const offlineNote = online ? '' : '\n※ PC가 오프라인이라 다음 부팅(재연결) 시 적용됩니다.';
    if (!confirm(`${rollbackPreview(c)}\n\n※ 이 PC의 배포 그룹 정책이 다시 변경되면 정책 값이 재적용됩니다.${offlineNote}\n진행할까요?`)) return;
    try {
      await apiFetch(`/agents/${encodeURIComponent(agent.machine_id)}/registry/${c.id}/rollback`, {});
      loadDetail();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const cancelQueued = async (q: QueuedCommand) => {
    if (!confirm(`대기 중인 [${q.label}] 명령을 취소할까요?`)) return;
    try {
      await apiFetch(`/agents/${encodeURIComponent(agent.machine_id)}/commands/${q.id}`, undefined, 'DELETE');
      loadDetail();
      onRefresh();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const online = agent.online ?? detail?.online ?? false;
  const queuedCmds = detail?.queued_commands || [];
  const hist = detail?.hist || [];
  const changes = detail?.registry_changes || [];

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* 상단 PC 타이틀 & 닫기 버튼 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
              {agent.hostname}{' '}
              <span className={`badge ${online ? 'badge-ok' : 'badge-danger'}`} style={{ verticalAlign: 'middle' }}>
                {online ? '온라인' : '오프라인'}
              </span>
            </h3>
            <div className="mono" style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
              {agent.ip} · {agent.os_name} ({agent.os_build})
            </div>
          </div>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: 6 }}>
            <X size={16} />
          </button>
        </div>

        {/* 요약 메타 카드 */}
        <div style={{ ...subCard, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 14, fontSize: 12 }}>
          <div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Machine ID</span>
            <div className="mono" style={{ color: 'var(--text-primary)', marginTop: 3, fontWeight: 600 }}>
              {agent.machine_id}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>적용 정책 해시</span>
            <div className="mono" style={{ color: 'var(--accent-text)', marginTop: 3, fontWeight: 700 }}>
              {agent.applied_hash || '미적용'}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>인증 토큰</span>
            <div className="mono" style={{ color: 'var(--accent-text)', marginTop: 3, fontWeight: 600 }}>
              {agent.token_preview}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>설치된 핫픽스</span>
            <div className="mono" style={{ color: 'var(--text-primary)', marginTop: 3, maxHeight: 60, overflow: 'auto' }}>
              {agent.hotfix || '확인 중'}
            </div>
          </div>
        </div>

        {/* 개별 PC 제어 및 삭제 버튼 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button onClick={() => sendCmd('scan')} className="btn btn-ghost">
            <RefreshCw size={13} style={{ color: 'var(--accent-text)' }} /> 즉시 스캔
          </button>
          <button onClick={() => sendCmd('install_all')} className="btn btn-emerald">
            <Download size={13} /> 대기 전체 설치
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={revokeToken} className="btn btn-amber">
              <ShieldOff size={13} /> 토큰 폐기
            </button>
            <button onClick={deleteAgent} className="btn btn-rose">
              <Trash2 size={13} /> PC 삭제
            </button>
          </div>
        </div>
        {!online && (
          <div style={{ fontSize: 12, color: '#f59e0b' }}>
            오프라인 상태입니다. 보내는 명령은 대기열에 보관했다가 PC가 켜지면(재연결 시) 바로 적용됩니다.
            {agent.boot_ts ? ` · 마지막 부팅: ${fmtTs(agent.boot_ts)}` : ''}
          </div>
        )}
        {(detail?.reconnect_waiting || agent.reconnect_waiting) && (
          <div style={{ fontSize: 12, color: '#f59e0b' }}>
            재부팅 명령을 전달했습니다. 에이전트가 다시 연결되는지 자동으로 확인 중이며, 결과는 알림 탭에 표시됩니다.
          </div>
        )}

        {/* 다음 부팅 시 적용될 대기 명령 */}
        {queuedCmds.length > 0 && (
          <div>
            <h4 style={sectionTitle}>
              <Clock size={14} /> 대기 중인 명령 ({queuedCmds.length}건 · {online ? '곧 전달' : '다음 부팅 시 적용'})
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {queuedCmds.map((q) => (
                <div key={q.id} style={{ ...subCard, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                  <strong>{q.label}</strong>
                  {q.payload?.kb && <span className="mono">{q.payload.kb}</span>}
                  <span style={{ color: 'var(--text-muted)' }}>{fmtTs(q.created_at)} 요청</span>
                  <button
                    className="btn btn-ghost"
                    style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 11.5 }}
                    onClick={() => cancelQueued(q)}
                  >
                    <X size={12} /> 취소
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 대기 중인 Windows 업데이트 목록 */}
        <div>
          <h4 style={sectionTitle}>대기 중인 Windows 업데이트 ({agent.pend.length}건)</h4>
          {agent.pend.length === 0 ? (
            <div style={{ ...subCard, padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              현재 대기 중인 업데이트가 없습니다.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {agent.pend.map((u, idx) => (
                <div key={u.id || idx} style={{ ...subCard, padding: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)', fontSize: 12 }}>
                      {u.kb || 'KB미상'}
                    </span>
                    <span className={`badge ${u.hid ? 'badge-danger' : 'badge-ok'}`}>
                      {u.hid ? '숨김(차단됨)' : `${Math.round((u.size || 0) / 1048576)} MB`}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.45 }}>{u.title}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    <button
                      onClick={() => sendCmd('install_kb', { kb: u.kb })}
                      className="btn btn-primary"
                      style={{ padding: '5px 11px', fontSize: 11.5 }}
                    >
                      <Download size={12} /> 단독 설치
                    </button>
                    {!u.hid ? (
                      <button
                        onClick={() => sendCmd('hide_kb', { kb: u.kb })}
                        className="btn btn-rose"
                        style={{ padding: '5px 11px', fontSize: 11.5 }}
                      >
                        <EyeOff size={12} /> 숨기기
                      </button>
                    ) : (
                      <button
                        onClick={() => sendCmd('unhide_kb', { kb: u.kb })}
                        className="btn btn-ghost"
                        style={{ padding: '5px 11px', fontSize: 11.5 }}
                      >
                        <Eye size={12} /> 숨김 해제
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 업데이트 설치/제거 이력 (상세 모달에서만 조회, 최대 100건) */}
        <div>
          <h4 style={sectionTitle}>
            <History size={14} /> 업데이트 설치·제거 이력 ({hist.length}건, 최대 100건)
          </h4>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            {historyRequested === 'queued' && '에이전트에 전체 이력을 요청했습니다. 수 초 후 자동으로 갱신됩니다. · '}
            {historyRequested === 'offline' && '오프라인이라 최근 보고된 이력을 표시합니다. · '}
            마지막 갱신: {fmtTs(detail?.hist_ts)}
          </div>
          {detailError && <div style={{ fontSize: 12, color: '#f43f5e' }}>{detailError}</div>}
          {hist.length === 0 ? (
            <div style={{ ...subCard, padding: 18, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              {detail ? '보고된 이력이 없습니다.' : '불러오는 중...'}
            </div>
          ) : (
            <div style={{ ...subCard, maxHeight: 280, overflow: 'auto' }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>일시</th>
                    <th>구분</th>
                    <th>KB</th>
                    <th>결과</th>
                    <th>제목</th>
                  </tr>
                </thead>
                <tbody>
                  {hist.map((h, i) => {
                    const r = HISTORY_RESULT[h.rc ?? -1] || { text: String(h.rc ?? '-'), cls: 'badge-warn' };
                    return (
                      <tr key={`${h.id}-${h.date}-${i}`}>
                        <td className="mono">{h.date ? h.date.replace('T', ' ') : '-'}</td>
                        <td>{HISTORY_OP[h.op ?? 0] || '-'}</td>
                        <td className="mono">{h.kb || '-'}</td>
                        <td>
                          <span className={`badge ${r.cls}`}>{r.text}</span>
                        </td>
                        <td style={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={h.title}>
                          {h.title}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 레지스트리 변경 이력 + 롤백 */}
        <div>
          <h4 style={sectionTitle}>
            <Wrench size={14} /> 레지스트리 변경 이력 ({changes.length}건)
          </h4>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            정책 적용으로 실제 값이 바뀐 경우만 기록됩니다. 롤백하면 변경 전 값으로 되돌리며, 롤백도 이력에 남습니다.
          </div>
          {changes.length === 0 ? (
            <div style={{ ...subCard, padding: 18, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              {detail ? '기록된 레지스트리 변경이 없습니다.' : '불러오는 중...'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflow: 'auto' }}>
              {changes.map((c) => {
                const st = ROLLBACK_STATE[c.rollback_state];
                return (
                  <div key={c.id} style={{ ...subCard, padding: 12, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5 }}>{summarizeChange(c)}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                        {c.source === 'rollback' ? '롤백으로 변경' : `정책 적용 (${c.policy_hash || '-'})`} · {fmtTs(c.ts)}
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, wordBreak: 'break-all' }}>
                        HKLM\{c.path}\{c.name} : {describeValue(c.name, c.old_exists, c.old_value)} →{' '}
                        {describeValue(c.name, c.new_exists, c.new_value)}
                      </div>
                      {c.rollback_msg && (
                        <div style={{ fontSize: 11, color: c.rollback_state === 'failed' ? '#f43f5e' : 'var(--text-muted)', marginTop: 3 }}>
                          {c.rollback_msg}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                      {st && <span className={`badge ${st.cls}`}>{st.text}</span>}
                      <button
                        className="btn btn-amber"
                        style={{ padding: '5px 10px', fontSize: 11.5 }}
                        disabled={c.rollback_state === 'requested'}
                        title={
                          online
                            ? `${registryLabel(c.name)} 변경 전 값으로 되돌리기`
                            : `${registryLabel(c.name)} 변경 전 값으로 되돌리기 (다음 부팅 시 적용)`
                        }
                        onClick={() => rollback(c)}
                      >
                        <Undo2 size={12} /> 롤백
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
