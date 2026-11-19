import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { apiFetch, errorMessage } from '../api';

interface Props {
  /** 최초 로그인(임시 비밀번호) 안내 문구 표시 여부 */
  firstLogin?: boolean;
  onChanged: () => void;
}

export const PasswordChangeForm: React.FC<Props> = ({ firstLogin, onChanged }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setMsg({ ok: false, text: '새 비밀번호는 8자 이상이어야 합니다.' });
    if (next !== confirm) return setMsg({ ok: false, text: '새 비밀번호 확인이 일치하지 않습니다.' });
    setBusy(true);
    try {
      const res = await apiFetch<{ message: string }>('/auth/password', {
        current_password: current,
        new_password: next,
      });
      setMsg({ ok: true, text: res.message });
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {firstLogin && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          임시 비밀번호로 로그인했습니다. 계속하려면 새 비밀번호를 설정하세요.
          <br />
          변경 후 서버 PC의 <span className="mono">initial_admin_password.txt</span> 파일은 자동 삭제됩니다.
        </div>
      )}
      <input
        type="password"
        className="input-dark"
        placeholder="현재 비밀번호"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        autoComplete="current-password"
        autoFocus
      />
      <input
        type="password"
        className="input-dark"
        placeholder="새 비밀번호 (8자 이상)"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
      />
      <input
        type="password"
        className="input-dark"
        placeholder="새 비밀번호 확인"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
      />
      {msg && (
        <div style={{ fontSize: 12.5, color: msg.ok ? '#10b981' : '#f43f5e' }}>{msg.text}</div>
      )}
      <button type="submit" className="btn btn-primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
        <KeyRound size={14} /> {busy ? '변경 중...' : '비밀번호 변경'}
      </button>
    </form>
  );
};
