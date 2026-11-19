import React from 'react';
import { CheckCircle2, KeyRound, LogOut } from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { useAutoStart } from '../hooks/useAutoStart';
import { THEMES } from '../constants/themes';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { AccountManager } from '../components/AccountManager';

/** 5. 설정 (화면 테마 + 관리자 계정/비밀번호 + 콘솔 계정 관리 + Windows 시작 시 자동 실행) */
export const SettingsPage: React.FC = () => {
  const { theme, setTheme, username, role, logout, showToast } = useConsole();
  const { autoStart, toggleAutoStart } = useAutoStart(showToast);

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">콘솔 환경 설정</h2>
          <p className="page-desc">
            화면 색상 테마, 관리자 비밀번호, Windows 시작 시 자동 실행 옵션을 관리합니다.
          </p>
        </div>
      </div>

      <section className="glass-card panel">
        <div className="panel-header">
          <h3 className="panel-title">화면 테마 설정</h3>
        </div>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <div
              key={t.key}
              onClick={() => setTheme(t.key)}
              className={`theme-card ${theme === t.key ? 'active' : ''}`}
              style={{ background: t.bg, color: t.fg }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: t.accent,
                    display: 'inline-block',
                  }}
                />
                {theme === t.key && <CheckCircle2 size={15} style={{ color: t.accent }} />}
              </div>
              <strong style={{ fontSize: 13 }}>{t.label}</strong>
              <span style={{ fontSize: 11, opacity: 0.75 }}>가나다 ABC 123</span>
            </div>
          ))}
        </div>
      </section>

      <section className="glass-card panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <KeyRound size={16} style={{ color: 'var(--accent-text)' }} />
            <span>관리자 계정 · 비밀번호 변경</span>
          </h3>
          <button onClick={logout} className="btn btn-rose">
            <LogOut size={14} /> 로그아웃
          </button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          현재 로그인 계정: <strong>{username || '-'}</strong> ({role === 'admin' ? '관리자' : role === 'operator' ? '운영자' : '-'}) ·
          계정 정보는 서버 PC의 별도 계정 DB에 암호화되어 저장됩니다. 비밀번호를 변경하면 다른 PC의 로그인 세션은 모두 종료됩니다.
        </p>
        <div style={{ maxWidth: 360 }}>
          <PasswordChangeForm onChanged={() => showToast('✓ 비밀번호가 변경되었습니다.')} />
        </div>
      </section>

      {role === 'admin' && <AccountManager currentUser={username} onToast={showToast} />}

      <section className="glass-card panel">
        <div className="panel-header">
          <h3 className="panel-title">Windows 시작 시 실행 옵션</h3>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            cursor: 'pointer',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>
              Windows 로그인 시 AURORA Endpoint Control Console 자동 시작
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
              서버 PC가 재부팅되어도 중앙 관제 서버와 백그라운드 API 엔진이 즉시 자동으로 가동됩니다.
            </div>
          </div>
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => toggleAutoStart(e.target.checked)}
            style={{ width: 20, height: 20, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
          />
        </label>
      </section>
    </>
  );
};
