import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { AccessLogItem } from '../types';

const ACTION_LABEL: Record<string, string> = {
  login: '로그인',
  login_fail: '로그인 실패',
  logout: '로그아웃',
  password_change: '비밀번호 변경',
};

/** 콘솔 접속 로그 (최근 200건, 7일 보관) */
export const AccessLogPanel: React.FC = () => {
  const [rows, setRows] = useState<AccessLogItem[]>([]);

  useEffect(() => {
    const load = () => apiFetch<AccessLogItem[]>('/access-logs').then(setRows).catch(() => {});
    load();
    const id = window.setInterval(load, 30000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="glass-card panel">
      <div className="panel-header">
        <h3 className="panel-title">콘솔 접속 로그 (최근 7일)</h3>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>기록이 없습니다.</div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>계정</th>
                <th>IP</th>
                <th>동작</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{new Date(r.ts * 1000).toLocaleString('ko-KR')}</td>
                  <td>{r.username}</td>
                  <td className="mono">{r.ip}</td>
                  <td>{ACTION_LABEL[r.action] || r.action}</td>
                  <td>
                    <span className={`badge ${r.ok ? 'badge-ok' : 'badge-danger'}`}>{r.ok ? '성공' : '실패'}</span>
                    {r.detail && <span style={{ marginLeft: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>{r.detail}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
