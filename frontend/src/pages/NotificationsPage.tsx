import React, { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCheck, Check, RefreshCw } from 'lucide-react';
import { apiFetch, errorMessage } from '../api';
import { NotificationItem } from '../types';
import { useConsole } from '../context/ConsoleContext';

const LEVEL_STYLE: Record<string, { label: string; cls: string }> = {
  info: { label: '안내', cls: 'badge-ok' },
  warn: { label: '주의', cls: 'badge-warn' },
  error: { label: '오류', cls: 'badge-danger' },
};

const CATEGORY_LABEL: Record<string, string> = {
  register: 'PC 등록',
  command: '원격 명령',
  policy: '정책 적용',
  rollback: '레지스트리 롤백',
  agent: '에이전트',
  system: '시스템',
  security: '보안',
  deploy: '프로그램 배포',
};

/** 확인이 필요한 이벤트 모음. '확인'을 누르면 서버에서 삭제되어 다시 표시되지 않는다. */
export const NotificationsPage: React.FC = () => {
  const { state, fetchState, openAgent, navigate, showToast } = useConsole();
  const onChanged = fetchState; // 사이드바 배지 갱신용

  // [PC 보기]: 관리중 PC면 상세 열기, 승인 대기/거부 PC면 해당 목록으로 이동
  const onOpenPc = (mid: string) => {
    const a = state.agents.find((x) => x.machine_id === mid);
    if (a) openAgent(a);
    else if ((state.pending_agents || []).some((x) => x.machine_id === mid)) navigate('pcs-pending');
    else if ((state.rejected_agents || []).some((x) => x.machine_id === mid)) navigate('pcs-rejected');
    else showToast('해당 PC는 현재 관리 목록에 없습니다.');
  };
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<NotificationItem[]>('/notifications'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, [load]);

  const ack = async (ids?: number[]) => {
    try {
      await apiFetch('/notifications/ack', ids ? { ids } : {});
      setItems((prev) => (ids ? prev.filter((n) => !ids.includes(n.id)) : []));
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">알림</h2>
          <p className="page-desc">
            확인이 필요한 이벤트(신규 등록 요청, 명령·정책 실패, 롤백 결과, 보안 경고 등)를 모아 보여줍니다. 확인한 알림은 바로
            삭제되며, 확인하지 않은 알림도 7일이 지나면 자동 정리됩니다.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} className="btn btn-ghost">
            <RefreshCw size={13} /> 새로고침
          </button>
          <button onClick={() => ack()} className="btn btn-primary" disabled={!items.length}>
            <CheckCheck size={14} /> 모두 확인
          </button>
        </div>
      </div>
      {error && <div style={{ color: '#f43f5e', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      <section className="glass-card panel">
        {items.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            <Bell size={28} style={{ marginBottom: 8 }} />
            <div>확인할 알림이 없습니다.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((n) => {
              const lv = LEVEL_STYLE[n.level] || LEVEL_STYLE.info;
              return (
                <div
                  key={n.id}
                  style={{
                    display: 'flex', gap: 12, alignItems: 'flex-start', padding: 12,
                    background: 'var(--bg-subcard)', border: '1px solid var(--border-subtle)', borderRadius: 10,
                  }}
                >
                  <span className={`badge ${lv.cls}`}>{lv.label}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{n.title}</div>
                    {n.message && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, wordBreak: 'break-all' }}>
                        {n.message}
                      </div>
                    )}
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {new Date(n.ts * 1000).toLocaleString('ko-KR')} · {CATEGORY_LABEL[n.category] || n.category}
                    </div>
                  </div>
                  {n.machine_id && (
                    <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 11.5 }} onClick={() => onOpenPc(n.machine_id)}>
                      PC 보기
                    </button>
                  )}
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 11.5 }} onClick={() => ack([n.id])}>
                    <Check size={12} /> 확인
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
};
