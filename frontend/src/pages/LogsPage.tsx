import { RefreshCw, Search } from 'lucide-react';
import React, { useState } from 'react';
import { useConsole } from '../context/ConsoleContext';
import { AccessLogPanel } from '../components/AccessLogPanel';

/** 4. 로그 관리 (이벤트 로그 검색 + 콘솔 접속 로그) */
export const LogsPage: React.FC = () => {
  const { state, fetchState } = useConsole();
  const [logSearch, setLogSearch] = useState('');
  const filteredEvents = state.events.filter((ev) => {
    if (!logSearch.trim()) return true;
    const q = logSearch.toLowerCase();
    return ev.host.toLowerCase().includes(q) || ev.msg.toLowerCase().includes(q);
  });

  return (
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

      <AccessLogPanel />
    </>
  );
};
