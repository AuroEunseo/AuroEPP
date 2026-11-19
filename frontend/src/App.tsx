import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MenuKey } from './types';
import { AgentDrawer } from './components/AgentDrawer';
import { LoginScreen } from './components/LoginScreen';
import { StartupLoading } from './components/StartupLoading';
import { DashboardPage } from './pages/DashboardPage';
import { ManagedPcsPage } from './pages/ManagedPcsPage';
import { PendingPcsPage } from './pages/PendingPcsPage';
import { RejectedPcsPage } from './pages/RejectedPcsPage';
import { PolicyRegistryPage } from './pages/PolicyRegistryPage';
import { KbRulesPage } from './pages/KbRulesPage';
import { ProgramsPage } from './pages/ProgramsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useToast } from './hooks/useToast';
import { useTheme } from './hooks/useTheme';
import { useAuthFlow } from './hooks/useAuthFlow';
import { useDashboardData } from './hooks/useDashboardData';
import { ConsoleProvider } from './context/ConsoleContext';
import { Sidebar } from './layout/Sidebar';
import { Toast } from './layout/Toast';

/** 메뉴별 화면 (새 메뉴를 추가할 때는 types.ts 의 MenuKey, layout/Sidebar.tsx 와 함께 여기에 등록) */
const PAGES: Record<MenuKey, React.ReactNode> = {
  dashboard: <DashboardPage />,
  'pcs-managed': <ManagedPcsPage />,
  'pcs-pending': <PendingPcsPage />,
  'pcs-rejected': <RejectedPcsPage />,
  'policy-registry': <PolicyRegistryPage />,
  'policy-rules': <KbRulesPage />,
  programs: <ProgramsPage />,
  notifications: <NotificationsPage />,
  logs: <LogsPage />,
  settings: <SettingsPage />,
};

/**
 * 콘솔 최상위 화면
 * - 로그인 단계 전환 (로그인 → DB 준비 로딩 → 콘솔)
 * - 공용 값(ConsoleContext) 제공, 사이드바·메뉴 화면·PC 상세 배치
 * 각 메뉴 화면의 내용과 상태는 pages/ 아래 파일에 있다.
 */
export default function App() {
  const { toastMsg, showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const auth = useAuthFlow();
  const { phase, username, role, forcePwChange, goLogin, logout } = auth;
  const { state, lastRefreshed, activeAgent, setActiveAgent, fetchState } = useDashboardData(phase, auth.handleApiError);

  // 좌측 내비게이션 (메뉴 그룹 펼침 상태는 Sidebar 가 관리)
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');

  // 화면 이탈 확인: 저장하지 않은 변경이 있는 화면(레지스트리 정책)이 등록하면, 다른 메뉴로 갈 때 먼저 확인
  const leaveGuardRef = useRef<(() => boolean) | null>(null);
  const setLeaveGuard = useCallback((guard: (() => boolean) | null) => {
    leaveGuardRef.current = guard;
  }, []);
  const navigate = useCallback(
    (menu: MenuKey) => {
      if (menu !== activeMenu && leaveGuardRef.current && !leaveGuardRef.current()) return;
      setActiveMenu(menu);
    },
    [activeMenu]
  );

  // 로그아웃·세션 만료 후 다시 로그인하면 이전 사용자가 보던 메뉴가 아니라 대시보드부터 보여준다
  useEffect(() => {
    if (phase === 'login') {
      leaveGuardRef.current = null;
      setActiveMenu('dashboard');
    }
  }, [phase]);

  if (phase === 'login') {
    return (
      <LoginScreen
        forcePasswordChange={forcePwChange}
        usernameHint={username || undefined}
        onLoggedIn={auth.onLoggedIn}
      />
    );
  }

  if (phase === 'loading') {
    return <StartupLoading onReady={auth.onStartupReady} onUnauthorized={goLogin} />;
  }

  if (!state) {
    return (
      <div className="login-wrap mono" style={{ color: 'var(--accent-text)', fontSize: 14 }}>
        PC 목록을 불러오는 중입니다...
      </div>
    );
  }

  const consoleValue = {
    state,
    fetchState,
    lastRefreshed,
    showToast,
    openAgent: setActiveAgent,
    activeMenu,
    navigate,
    setLeaveGuard,
    username,
    role,
    logout,
    theme,
    setTheme,
  };

  return (
    <ConsoleProvider value={consoleValue}>
      <div className="app-layout">
        <Toast message={toastMsg} />
        <Sidebar />

        {/* 우측 페이지 본문 */}
        <main className="content-area">{PAGES[activeMenu]}</main>

        {/* 개별 PC 상세 (드로어) */}
        <AgentDrawer agent={activeAgent} onClose={() => setActiveAgent(null)} onRefresh={fetchState} />
      </div>
    </ConsoleProvider>
  );
}
