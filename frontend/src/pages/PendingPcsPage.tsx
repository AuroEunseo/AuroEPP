import React from 'react';
import { CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { useAgentDecision } from '../hooks/useAgentDecision';

/** 2-2. 승인 대기 PC (에이전트 통신 확인 후 배포 그룹을 지정해 승인) */
export const PendingPcsPage: React.FC = () => {
  const { state, fetchState, navigate } = useConsole();
  const handleDecision = useAgentDecision();
  const agents = state.agents;
  const pending = state.pending_agents || [];
  const pendingAliveSec = state.limits?.pending_alive_sec ?? 45;

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">승인 대기 PC ({pending.length}대)</h2>
          <p className="page-desc">
            에이전트가 설치되어 등록을 요청한 신규 PC 목록입니다. 승인 시 해당 PC 에이전트와의 통신을 먼저 확인하며, 응답이
            확인된 PC만 등록됩니다.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate('pcs-managed')} className="btn btn-ghost">
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
                  <div style={{ marginTop: 6 }}>
                    <span className={`badge ${p.alive ? 'badge-ok' : 'badge-warn'}`}>
                      {p.alive
                        ? `에이전트 응답 확인됨 (${Math.max(0, Math.round(state.now - p.last_seen))}초 전)`
                        : `에이전트 응답 대기 중 (최근 ${pendingAliveSec}초 내 통신 없음)`}
                    </span>
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
            대상 PC에서 AURORA Endpoint Agent 서비스를 시작하고 관제 서버 주소를 저장하면 이곳에 자동으로 표시됩니다.
          </div>
        </section>
      )}
    </>
  );
};
