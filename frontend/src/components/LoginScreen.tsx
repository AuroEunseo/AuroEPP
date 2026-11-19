import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { apiFetch, errorMessage, setSession } from '../api';
import { PasswordChangeForm } from './PasswordChangeForm';
import logoUrl from '../assets/ac1.png';

interface Props {
  /** 로그인(및 필요 시 최초 비밀번호 변경)까지 완료되면 호출 */
  onLoggedIn: (username: string) => void;
  /** 세션은 있으나 임시 비밀번호 상태로 돌아온 경우 바로 변경 화면 표시 */
  forcePasswordChange?: boolean;
  usernameHint?: string;
}

export const LoginScreen: React.FC<Props> = ({ onLoggedIn, forcePasswordChange, usernameHint }) => {
  const [username, setUsername] = useState(usernameHint || 'admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mustChange, setMustChange] = useState(Boolean(forcePasswordChange));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await apiFetch<{ token: string; username: string; must_change: boolean }>('/auth/login', {
        username,
        password,
      });
      setSession(res.token, res.username);
      setPassword('');
      if (res.must_change) setMustChange(true);
      else onLoggedIn(res.username);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="glass-card login-card">
        <div className="brand-group" style={{ marginBottom: 22 }}>
          <img src={logoUrl} className="brand-logo brand-logo-img" alt="AURORA" />
          <div>
            <h1 className="brand-title">AURORA Endpoint Control</h1>
            <p className="brand-sub">엔터프라이즈 패치 및 에이전트 중앙 관제</p>
          </div>
        </div>

        {mustChange ? (
          <PasswordChangeForm firstLogin onChanged={() => onLoggedIn(username)} />
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>아이디</label>
              <input
                className="input-dark"
                style={{ width: '100%' }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>비밀번호</label>
              <input
                type="password"
                className="input-dark"
                style={{ width: '100%' }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            {error && <div style={{ fontSize: 12.5, color: '#f43f5e' }}>{error}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', padding: 10 }}>
              <LogIn size={14} /> {busy ? '확인 중...' : '로그인'}
            </button>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              최초 접속 시 임시 비밀번호는 서버 PC의
              <br />
              <span className="mono">C:\ProgramData\AURORA\Server\initial_admin_password.txt</span> 에 있습니다.
              <br />
              (관리자 권한으로만 열 수 있습니다)
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
