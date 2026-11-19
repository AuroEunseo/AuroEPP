import React from 'react';
import { ArrowUpRight, CheckCircle2, RefreshCw, ShieldCheck, Terminal, XCircle } from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { useAgentDecision } from '../hooks/useAgentDecision';
import { isAgentOnline, isPolicyApplied } from '../utils/agent';
import { Agent } from '../types';

/** 1. 대시보드 요약 (핵심 KPI 바로가기 + 신규 승인 배너 + 최근 로그) */
export const DashboardPage: React.FC = () => {
  const { state, lastRefreshed, fetchState, navigate } = useConsole();
  const handleDecision = useAgentDecision();
  const agents = state.agents;
  const pending = state.pending_agents || [];
  const isOnline = (a: Agent) => isAgentOnline(a, state.now);
  const compliancePct = agents.length
    ? Math.round((100 * agents.filter(isPolicyApplied).length) / agents.length)
    : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">관제 요약 대시보드</h2>
          <p className="page-desc">
            전체 엔드포인트 현황 요약 및 실시간 감사 로그 (온라인 상태 10초 · 변경 시 자동 갱신 · 마지막 동기화:{' '}
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
          onClick={() => navigate('policy-registry')}
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
          onClick={() => navigate('pcs-managed')}
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
          onClick={() => navigate('pcs-pending')}
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
          onClick={() => navigate('pcs-managed')}
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
              onClick={() => navigate('pcs-pending')}
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
                    disabled={!p.alive}
                    title={p.alive ? '' : '에이전트와 통신이 확인되어야 승인할 수 있습니다'}
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
          <button onClick={() => navigate('logs')} className="btn btn-ghost">
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
  );
};
