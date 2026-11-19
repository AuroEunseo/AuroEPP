import { useCallback, useEffect, useState } from 'react';
import { apiFetch, clearSession, getSessionToken, getSessionUser } from '../api';

export type Phase = 'login' | 'loading' | 'ready';
export type Role = 'admin' | 'operator' | '';

/**
 * 로그인 흐름: 로그인 → 로딩(DB 백업/마이그레이션 진행 표시) → 준비 완료
 * - handleApiError: API 오류 메시지에 따라 로그인 화면/비밀번호 변경/로딩 화면으로 전환
 */
export function useAuthFlow() {
  const [phase, setPhase] = useState<Phase>(() => (getSessionToken() ? 'loading' : 'login'));
  const [username, setUsername] = useState(getSessionUser());
  const [role, setRole] = useState<Role>('');
  const [forcePwChange, setForcePwChange] = useState(false);

  const goLogin = useCallback(() => {
    clearSession();
    setForcePwChange(false);
    setPhase('login');
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', {});
    } catch {
      /* 세션이 이미 만료된 경우 무시 */
    }
    goLogin();
  }, [goLogin]);

  const onLoggedIn = useCallback((u: string) => {
    setUsername(u);
    setForcePwChange(false);
    setPhase('loading');
  }, []);

  const onStartupReady = useCallback(() => setPhase('ready'), []);

  const handleApiError = useCallback(
    (e: any) => {
      if (e?.message === 'UNAUTHORIZED') goLogin();
      else if (e?.message === 'PASSWORD_CHANGE_REQUIRED') {
        setForcePwChange(true);
        setPhase('login');
      } else if (e?.message === 'NOT_READY') setPhase('loading');
    },
    [goLogin]
  );

  // 로그인 계정의 권한 (관리자만 계정 관리 메뉴 표시)
  useEffect(() => {
    if (phase !== 'ready') return;
    apiFetch<{ role: 'admin' | 'operator' }>('/auth/me')
      .then((m) => setRole(m.role))
      .catch(() => setRole(''));
  }, [phase, username]);

  return { phase, username, role, forcePwChange, goLogin, logout, onLoggedIn, onStartupReady, handleApiError };
}
