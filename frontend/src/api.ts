const TOKEN_KEY = 'aurora_admin_token';

export function getAdminToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setAdminToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export async function apiFetch<T = any>(
  path: string,
  body?: Record<string, any>,
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
): Promise<T> {
  const token = getAdminToken();
  const reqMethod = method || (body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, {
    method: reqMethod,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
    },
    body: reqMethod === 'POST' || reqMethod === 'PUT' ? JSON.stringify(body ?? {}) : undefined,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: '요청 처리 실패' }));
    throw new Error(err.detail || '요청 처리 실패');
  }
  return res.json();
}