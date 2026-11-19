import React, { useEffect, useState } from 'react';
import { Bell, ChevronDown, ChevronRight, LayoutDashboard, Monitor, Settings, Shield, Terminal } from 'lucide-react';
import { useConsole } from '../context/ConsoleContext';
import { THEMES } from '../constants/themes';
import logoUrl from '../assets/ac1.png';

const PC_MENUS = ['pcs-managed', 'pcs-pending', 'pcs-rejected'];
const POLICY_MENUS = ['policy-registry', 'policy-rules'];

/** 좌측 고정 사이드바 메뉴 */
export const Sidebar: React.FC = () => {
  const { state, activeMenu, navigate, username, theme } = useConsole();
  const [pcMenuOpen, setPcMenuOpen] = useState(true);
  const [policyMenuOpen, setPolicyMenuOpen] = useState(true);

  // 다른 화면에서 하위 메뉴 페이지로 이동하면 해당 메뉴 그룹을 펼친다
  useEffect(() => {
    if (PC_MENUS.includes(activeMenu)) setPcMenuOpen(true);
    if (POLICY_MENUS.includes(activeMenu)) setPolicyMenuOpen(true);
  }, [activeMenu]);

  const agents = state.agents;
  const pending = state.pending_agents || [];
  const rejected = state.rejected_agents || [];
  const notifCount = state.notification_count || 0;
  const isPcMenuActive = PC_MENUS.includes(activeMenu);

  return (
    <aside className="sidebar">
      <div className="brand-group">
        <img src={logoUrl} className="brand-logo brand-logo-img" alt="AURORA" />
        <div>
          <h1 className="brand-title">Endpoint Control</h1>
          <p className="brand-sub">오로라 관제 콘솔</p>
        </div>
      </div>

      <nav className="nav-section">
        <button
          className={`nav-item ${activeMenu === 'dashboard' ? 'active' : ''}`}
          onClick={() => navigate('dashboard')}
        >
          <span className="nav-item-left">
            <LayoutDashboard size={16} />
            <span>대시보드 요약</span>
          </span>
        </button>

        {/* PC 관리 + 하위 메뉴 (관리중 PC / 승인 대기 PC) */}
        <div>
          <button
            className={`nav-item ${isPcMenuActive ? 'active' : ''}`}
            onClick={() => {
              setPcMenuOpen((o) => !o);
              if (!isPcMenuActive) {
                navigate(pending.length > 0 ? 'pcs-pending' : 'pcs-managed');
              }
            }}
          >
            <span className="nav-item-left">
              <Monitor size={16} />
              <span>PC 관리</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {pending.length > 0 && <span className="badge-count">+{pending.length}</span>}
              {pcMenuOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>

          {pcMenuOpen && (
            <div className="nav-sub-group">
              <button
                className={`nav-sub-item ${activeMenu === 'pcs-managed' ? 'active' : ''}`}
                onClick={() => navigate('pcs-managed')}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>관리중 PC</span>
                <span className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
                  {agents.length}
                </span>
              </button>
              <button
                className={`nav-sub-item ${activeMenu === 'pcs-pending' ? 'active' : ''}`}
                onClick={() => navigate('pcs-pending')}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>승인 대기 PC</span>
                {pending.length > 0 ? (
                  <span className="badge-count" style={{ fontSize: 10, padding: '1px 6px' }}>
                    {pending.length}
                  </span>
                ) : (
                  <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>
                    0
                  </span>
                )}
              </button>
              <button
                className={`nav-sub-item ${activeMenu === 'pcs-rejected' ? 'active' : ''}`}
                onClick={() => navigate('pcs-rejected')}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>거부 PC</span>
                <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>
                  {rejected.length}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* 레지스트리 정책 확인 + 하위 메뉴 */}
        <div>
          <button
            className={`nav-item ${
              activeMenu === 'policy-registry' || activeMenu === 'policy-rules' ? 'active' : ''
            }`}
            onClick={() => {
              setPolicyMenuOpen((o) => !o);
              if (activeMenu !== 'policy-registry' && activeMenu !== 'policy-rules') {
                navigate('policy-registry');
              }
            }}
          >
            <span className="nav-item-left">
              <Shield size={16} />
              <span>레지스트리 정책 확인</span>
            </span>
            {policyMenuOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {policyMenuOpen && (
            <div className="nav-sub-group">
              <button
                className={`nav-sub-item ${activeMenu === 'policy-registry' ? 'active' : ''}`}
                onClick={() => navigate('policy-registry')}
              >
                레지스트리 정책 관리
              </button>
              <button
                className={`nav-sub-item ${activeMenu === 'policy-rules' ? 'active' : ''}`}
                onClick={() => navigate('policy-rules')}
              >
                Windows 업데이트 규칙
              </button>
            </div>
          )}
        </div>

        <button
          className={`nav-item ${activeMenu === 'notifications' ? 'active' : ''}`}
          onClick={() => navigate('notifications')}
        >
          <span className="nav-item-left">
            <Bell size={16} />
            <span>알림</span>
          </span>
          {notifCount > 0 && <span className="badge-count">{notifCount}</span>}
        </button>

        <button
          className={`nav-item ${activeMenu === 'logs' ? 'active' : ''}`}
          onClick={() => navigate('logs')}
        >
          <span className="nav-item-left">
            <Terminal size={16} />
            <span>로그 관리</span>
          </span>
        </button>

        <button
          className={`nav-item ${activeMenu === 'settings' ? 'active' : ''}`}
          onClick={() => navigate('settings')}
        >
          <span className="nav-item-left">
            <Settings size={16} />
            <span>설정</span>
          </span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <div style={{ color: '#10b981', fontWeight: 600 }}>● 관제 서버 정상 가동 중</div>
        <div style={{ marginTop: 4, fontSize: 11 }}>
          접속 계정: {username || '-'} · 포트 {state.server?.port ?? '-'}
        </div>
        <div style={{ marginTop: 4, fontSize: 11 }}>
          테마: {THEMES.find((t) => t.key === theme)?.label}
        </div>
      </div>
    </aside>
  );
};
