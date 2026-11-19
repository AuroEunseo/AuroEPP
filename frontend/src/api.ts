// 콘솔 로그인 세션 (아이디/비밀번호 로그인 후 서버가 발급한 세션 토큰)
const SESSION_KEY = 'aurora_session';
const USER_KEY = 'aurora_user';

export function getSessionToken(): string {
  return sessionStorage.getItem(SESSION_KEY) || '';
}

export function getSessionUser(): string {
  return sessionStorage.getItem(USER_KEY) || '';
}

export function setSession(token: string, username: string) {
  sessionStorage.setItem(SESSION_KEY, token);
  sessionStorage.setItem(USER_KEY, username);
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem('aurora_admin_token'); // 이전 버전 토큰 로그인 잔여값 정리
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * 오류 규칙
 *  - 401: 'UNAUTHORIZED' (세션 만료/미로그인)
 *  - 403 + PASSWORD_CHANGE_REQUIRED: 임시 비밀번호 상태
 *  - 503: 'NOT_READY' (DB 백업/마이그레이션 진행 중)
 */
export async function apiFetch<T = any>(
  path: string,
  body?: Record<string, any>,
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
): Promise<T> {
  const reqMethod = method || (body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, {
    method: reqMethod,
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': getSessionToken(),
    },
    body: reqMethod === 'POST' || reqMethod === 'PUT' ? JSON.stringify(body ?? {}) : undefined,
  });

  if (res.status === 401 && path !== '/auth/login') {
    throw new ApiError(401, 'UNAUTHORIZED');
  }
  if (res.status === 503) {
    throw new ApiError(503, 'NOT_READY');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: '요청 처리 실패' }));
    throw new ApiError(res.status, err.detail || '요청 처리 실패');
  }
  return res.json();
}

export function errorMessage(e: any): string {
  if (e?.message === 'NOT_READY') return '서버가 DB를 준비하는 중입니다. 잠시 후 다시 시도하세요.';
  if (e?.message === 'UNAUTHORIZED') return '로그인이 만료되었습니다. 다시 로그인하세요.';
  if (e?.message === 'PASSWORD_CHANGE_REQUIRED') return '비밀번호를 먼저 변경해야 합니다.';
  return e?.message || String(e);
}
