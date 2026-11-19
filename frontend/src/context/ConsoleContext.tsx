import React, { createContext, useContext } from 'react';
import { Agent, DashboardState, MenuKey } from '../types';
import { ThemeKey } from '../constants/themes';
import { Role } from '../hooks/useAuthFlow';

/**
 * 여러 화면(사이드바·각 메뉴 페이지)이 함께 쓰는 값.
 * 한 화면에서만 쓰는 상태(검색어, 선택, 정책 초안 등)는 여기에 두지 않고 그 화면 안에 둔다.
 */
export interface ConsoleContextValue {
  state: DashboardState;
  fetchState: () => Promise<void>;
  lastRefreshed: Date;
  showToast: (msg: string) => void;
  openAgent: (agent: Agent | null) => void;
  activeMenu: MenuKey;
  navigate: (menu: MenuKey) => void;
  /** 화면 이탈 확인 함수 등록 (false 를 반환하면 메뉴 이동 취소). 해제는 null */
  setLeaveGuard: (guard: (() => boolean) | null) => void;
  username: string;
  role: Role;
  logout: () => Promise<void>;
  theme: ThemeKey;
  setTheme: (t: ThemeKey) => void;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export const ConsoleProvider: React.FC<{ value: ConsoleContextValue; children: React.ReactNode }> = ({
  value,
  children,
}) => <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole 은 ConsoleProvider 안에서만 사용할 수 있습니다.');
  return ctx;
}
