import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, Trash2, KeyRound, Copy, Users } from 'lucide-react';
import { apiFetch, errorMessage } from '../api';
import { ConsoleAccount } from '../types';

interface Props {
  currentUser: string;
  onToast: (msg: string) => void;
}

const ROLE_OPTIONS = [
  { value: 'operator', label: '운영자', desc: 'PC 관리·정책·명령 등 모든 기능 (계정 관리 제외)' },
  { value: 'admin', label: '관리자', desc: '운영자 권한 + 콘솔 계정 생성·삭제·권한 변경' },
];

function fmt(ts?: number | null) {
  return ts ? new Date(ts * 1000).toLocaleString('ko-KR') : '-';
}

/** 설정 탭 > 콘솔 계정 관리 (관리자 권한 계정에만 표시) */
export const AccountManager: React.FC<Props> = ({ currentUser, onToast }) => {
  const [rows, setRows] = useState<ConsoleAccount[]>([]);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('operator');
  const [newPw, setNewPw] = useState('');
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await apiFetch<ConsoleAccount[]>('/accounts'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ message: string; temp_password: string }>('/accounts', {
        username: newName.trim(),
        role: newRole,
        password: newPw,
      });
      setIssued({ username: newName.trim(), password: res.temp_password || newPw });
      onToast(`✓ ${res.message}`);
      setNewName('');
      setNewPw('');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (a: ConsoleAccount) => {
    if (!confirm(`'${a.username}' 계정을 삭제할까요?\n해당 계정으로 로그인된 세션도 모두 종료됩니다.`)) return;
    try {
      const res = await apiFetch<{ message: string }>(`/accounts/${encodeURIComponent(a.username)}`, undefined, 'DELETE');
      onToast(`✓ ${res.message}`);
      load();
    } catch (err) {
      alert(errorMessage(err));
    }
  };

  const resetPw = async (a: ConsoleAccount) => {
    if (!confirm(`'${a.username}' 계정의 비밀번호를 초기화할까요?\n임시 비밀번호가 발급되고, 다음 로그인 때 새 비밀번호로 바꿔야 합니다.`)) return;
    try {
      const res = await apiFetch<{ message: string; temp_password: string }>(
        `/accounts/${encodeURIComponent(a.username)}/reset-password`,
        {}
      );
      setIssued({ username: a.username, password: res.temp_password });
      onToast(`✓ ${res.message}`);
      load();
    } catch (err) {
      alert(errorMessage(err));
    }
  };

  const changeRole = async (a: ConsoleAccount, role: string) => {
    try {
      const res = await apiFetch<{ message: string }>(`/accounts/${encodeURIComponent(a.username)}/role`, { role }, 'PUT');
      onToast(`✓ ${res.message}`);
    } catch (err) {
      alert(errorMessage(err));
    }
    load();
  };

  return (
    <section className="glass-card panel">
      <div className="panel-header">
        <h3 className="panel-title">
          <Users size={16} style={{ color: 'var(--accent-text)' }} />
          <span>콘솔 계정 관리</span>
        </h3>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
        콘솔에 접속할 수 있는 계정을 추가합니다. 새 계정은 첫 로그인 때 본인이 비밀번호를 다시 정해야 합니다. 아이디와
        비밀번호 정보는 암호화되어 서버 PC에만 저장됩니다.
      </p>

      {/* 계정 추가 */}
      <form onSubmit={create} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          className="input-dark"
          placeholder="아이디 (영문·숫자 3~32자)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ width: 200 }}
          autoComplete="off"
        />
        <select className="select-dark" value={newRole} onChange={(e) => setNewRole(e.target.value)} title={ROLE_OPTIONS.find((r) => r.value === newRole)?.desc}>
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <input
          className="input-dark"
          type="password"
          placeholder="초기 비밀번호 (비우면 자동 발급)"
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          style={{ width: 230 }}
          autoComplete="new-password"
        />
        <button type="submit" className="btn btn-primary" disabled={!newName.trim()}>
          <UserPlus size={14} /> 계정 추가
        </button>
      </form>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>
        {ROLE_OPTIONS.map((r) => (
          <div key={r.value}>
            · <strong>{r.label}</strong>: {r.desc}
          </div>
        ))}
      </div>

      {issued && (
        <div
          style={{
            padding: 12, marginBottom: 12, borderRadius: 10, fontSize: 12.5,
            background: 'var(--bg-subcard)', border: '1px solid var(--border-subtle)',
          }}
        >
          <strong>{issued.username}</strong> 계정의 초기 비밀번호:{' '}
          <span className="mono" style={{ color: 'var(--accent-text)' }}>{issued.password}</span>{' '}
          <button
            className="btn btn-ghost"
            style={{ padding: '3px 8px', fontSize: 11 }}
            onClick={() => navigator.clipboard.writeText(issued.password).then(() => onToast('✓ 복사했습니다.'))}
          >
            <Copy size={11} /> 복사
          </button>
          <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 11.5 }}>
            이 화면을 벗어나면 다시 볼 수 없습니다. 사용자에게 전달하세요. (첫 로그인 시 변경 필요)
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 6, padding: '3px 8px', fontSize: 11 }} onClick={() => setIssued(null)}>
            닫기
          </button>
        </div>
      )}

      {error && <div style={{ color: '#f43f5e', fontSize: 12.5, marginBottom: 8 }}>{error}</div>}

      {/* 계정 목록 */}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>아이디</th>
              <th>권한</th>
              <th>상태</th>
              <th>생성</th>
              <th>최근 접속</th>
              <th style={{ textAlign: 'right' }}>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const isMe = a.username.toLowerCase() === currentUser.toLowerCase();
              return (
                <tr key={a.username}>
                  <td>
                    <strong>{a.username}</strong>
                    {isMe && <span className="badge badge-ok" style={{ marginLeft: 6, fontSize: 10 }}>나</span>}
                  </td>
                  <td>
                    <select
                      className="select-dark"
                      value={a.role}
                      disabled={isMe}
                      onChange={(e) => changeRole(a, e.target.value)}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`badge ${a.must_change ? 'badge-warn' : 'badge-ok'}`}>
                      {a.must_change ? '비밀번호 변경 대기' : '사용 중'}
                    </span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {fmt(a.created_at)}
                    {a.created_by && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>by {a.created_by}</div>}
                  </td>
                  <td style={{ fontSize: 12 }}>{fmt(a.last_active)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost" style={{ padding: '4px 9px', fontSize: 11.5 }} disabled={isMe} onClick={() => resetPw(a)}>
                      <KeyRound size={12} /> 비밀번호 초기화
                    </button>{' '}
                    <button className="btn btn-rose" style={{ padding: '4px 9px', fontSize: 11.5 }} disabled={isMe} onClick={() => remove(a)}>
                      <Trash2 size={12} /> 삭제
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
