import React from 'react';
import { RefreshCw, Undo2, ShieldX } from 'lucide-react';
import { apiFetch, errorMessage } from '../api';
import { Agent } from '../types';

interface Props {
  rejected: Agent[];
  onRefresh: () => void;
  onToast: (msg: string) => void;
}

/** 승인 거부된 PC 목록. '거부 해제' 시 승인 대기 목록으로 이동하고, 에이전트 응답이 확인되면 승인할 수 있다. */
export const RejectedPcs: React.FC<Props> = ({ rejected, onRefresh, onToast }) => {
  const unreject = async (a: Agent) => {
    if (!confirm(`[${a.hostname}] PC를 거부 목록에서 제거하고 승인 대기로 되돌릴까요?`)) return;
    try {
      await apiFetch(`/agents/${encodeURIComponent(a.machine_id)}/unreject`, {});
      onToast(`✓ ${a.hostname}: 승인 대기로 이동했습니다. 에이전트 응답이 확인되면 승인할 수 있습니다.`);
      onRefresh();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">거부 PC</h2>
          <p className="page-desc">
            등록이 거부된 PC 목록입니다. 거부된 PC의 에이전트는 30초마다 등록을 재시도하며, 목록에서 제거하면 승인 대기로
            돌아갑니다.
          </p>
        </div>
        <button onClick={onRefresh} className="btn btn-ghost">
          <RefreshCw size={13} /> 새로고침
        </button>
      </div>
      <section className="glass-card panel">
        {rejected.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            <ShieldX size={28} style={{ marginBottom: 8 }} />
            <div>거부된 PC가 없습니다.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>PC 이름</th>
                  <th>IP</th>
                  <th>OS</th>
                  <th>에이전트 응답</th>
                  <th style={{ textAlign: 'right' }}>관리</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((a) => (
                  <tr key={a.machine_id}>
                    <td>
                      <strong>{a.hostname}</strong>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.machine_id}</div>
                    </td>
                    <td className="mono">{a.ip}</td>
                    <td>{a.os_name}</td>
                    <td>
                      <span className={`badge ${a.alive ? 'badge-ok' : 'badge-warn'}`}>
                        {a.alive ? '재등록 시도 중' : '응답 없음'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost" onClick={() => unreject(a)}>
                        <Undo2 size={13} /> 거부 해제 (승인 대기로)
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
