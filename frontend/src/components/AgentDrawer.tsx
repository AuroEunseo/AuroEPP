import React from 'react';
import { X, Download, EyeOff, Eye, ShieldOff, RefreshCw, Trash2 } from 'lucide-react';
import { Agent } from '../types';
import { apiFetch } from '../api';

interface Props {
  agent: Agent | null;
  onClose: () => void;
  onRefresh: () => void;
}

export const AgentDrawer: React.FC<Props> = ({ agent, onClose, onRefresh }) => {
  if (!agent) return null;

  const sendCmd = async (type: string, payload: Record<string, any> = {}) => {
    await apiFetch('/commands', { machine_ids: [agent.machine_id], type, payload });
    onRefresh();
  };

  const revokeToken = async () => {
    if (!confirm(`${agent.hostname}의 에이전트 토큰을 폐기하시겠습니까? 재인증 전까지 통신이 차단됩니다.`)) return;
    await apiFetch(`/agents/${agent.machine_id}/revoke`, {});
    onClose();
    onRefresh();
  };

  const deleteAgent = async () => {
    if (
      !confirm(
        `[${agent.hostname}] PC를 관제 목록에서 영구 삭제하시겠습니까?\n(해당 PC의 에이전트가 계속 실행 중이면 신규 승인 대기 요청으로 다시 등록됩니다.)`
      )
    ) {
      return;
    }
    await apiFetch(`/agents/${agent.machine_id}`, undefined, 'DELETE');
    onClose();
    onRefresh();
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* 상단 PC 타이틀 & 닫기 버튼 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
              {agent.hostname}
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            background: 'var(--bg-subcard)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 10,
            padding: 14,
            fontSize: 12,
          }}
        >
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
            <div className="mono" style={{ color: 'var(--text-primary)', marginTop: 3 }}>
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

        {/* 대기 중인 Windows 업데이트 목록 */}
        <div>
          <h4 style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
            대기 중인 Windows 업데이트 ({agent.pend.length}건)
          </h4>
          {agent.pend.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                background: 'var(--bg-subcard)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              현재 대기 중인 업데이트가 없습니다.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {agent.pend.map((u, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--bg-subcard)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 10,
                    padding: 13,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)', fontSize: 12 }}>
                      {u.kb || 'KB미상'}
                    </span>
                    <span className={`badge ${u.hidden ? 'badge-danger' : 'badge-ok'}`}>
                      {u.hidden ? '숨김(차단됨)' : `${u.size_mb ?? 0} MB`}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                    {u.title}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    <button
                      onClick={() => sendCmd('install_kb', { kb: u.kb })}
                      className="btn btn-primary"
                      style={{ padding: '5px 11px', fontSize: 11.5 }}
                    >
                      <Download size={12} /> 단독 설치
                    </button>
                    {!u.hidden ? (
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
      </div>
    </div>
  );
};