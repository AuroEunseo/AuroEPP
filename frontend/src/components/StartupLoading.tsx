import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch, errorMessage } from '../api';
import { SystemStatus } from '../types';

interface Props {
  onReady: () => void;
  onUnauthorized: () => void;
}

const MIN_SHOW_MS = 1200; // 너무 빨리 지나가 화면이 깜빡이지 않도록 최소 표시 시간

/** 로그인 직후: 서버의 DB 백업/구조 갱신/PC 로딩 진행 상황을 보여주는 로딩 화면 */
export const StartupLoading: React.FC<Props> = ({ onReady, onUnauthorized }) => {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [fetchError, setFetchError] = useState('');
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const st = await apiFetch<SystemStatus>('/system/status');
        if (stop) return;
        setStatus(st);
        setFetchError('');
        if (st.ready) {
          const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - startedAt.current));
          timer = window.setTimeout(() => !stop && onReady(), wait);
          return;
        }
        if (st.phase === 'error') return; // 오류 시 폴링 중단 (화면에 안내)
      } catch (e: any) {
        if (e?.message === 'UNAUTHORIZED') return onUnauthorized();
        setFetchError(errorMessage(e));
      }
      timer = window.setTimeout(poll, 700);
    };
    poll();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [onReady, onUnauthorized]);

  const steps = status?.steps || [];
  const isError = status?.phase === 'error';

  return (
    <div className="login-wrap">
      <div className="glass-card login-card" style={{ minWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          {isError ? (
            <AlertTriangle size={20} style={{ color: '#f43f5e' }} />
          ) : status?.ready ? (
            <CheckCircle2 size={20} style={{ color: '#10b981' }} />
          ) : (
            <Loader2 size={20} className="spin" style={{ color: 'var(--accent-text)' }} />
          )}
          <strong style={{ fontSize: 15 }}>
            {isError ? 'DB 준비 중 문제가 발생했습니다' : status?.ready ? '준비 완료' : '관제 서버를 준비하고 있습니다'}
          </strong>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
          {steps.length === 0 && <div style={{ color: 'var(--text-secondary)' }}>서버 상태를 확인하는 중입니다...</div>}
          {steps.map((s, i) => {
            const last = i === steps.length - 1;
            return (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', color: last ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {last && !status?.ready && !isError ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <CheckCircle2 size={13} style={{ color: '#10b981' }} />
                )}
                <span>{s.message}</span>
              </div>
            );
          })}
        </div>
        {isError && (
          <div style={{ marginTop: 14, fontSize: 12, color: '#f43f5e', lineHeight: 1.5 }}>
            {status?.error}
            <br />
            백업 파일: <span className="mono">{status?.backup_file || '없음'}</span> (서버 데이터 폴더의 backups)
          </div>
        )}
        {fetchError && <div style={{ marginTop: 12, fontSize: 12, color: '#f59e0b' }}>{fetchError}</div>}
      </div>
    </div>
  );
};
