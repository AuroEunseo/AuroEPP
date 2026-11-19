import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getSessionToken } from '../api';
import { Agent, DashboardState, Presence } from '../types';
import { Phase } from './useAuthFlow';

const POLL_MS = 10_000;
const FULL_REFRESH_MS = 5 * 60 * 1000;

/**
 * 콘솔 데이터 갱신
 *  - 10초마다 /presence (가벼운 응답): PC 온라인/오프라인 표시와 알림 수만 갱신
 *  - 서버 데이터가 바뀌었을 때(rev 변경) 또는 5분이 지났을 때만 전체 상태(/state)를 다시 받음
 *  - 사용자가 명령·설정을 바꾸면 각 동작에서 fetchState()로 즉시 갱신
 *  - 열려 있는 PC 상세(activeAgent)도 함께 최신 값으로 맞춘다
 */
export function useDashboardData(phase: Phase, onApiError: (e: any) => void) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const lastRevRef = useRef('');
  const lastFullFetchRef = useRef(0);

  // 로그아웃·세션 만료 시 화면 데이터 비우기
  useEffect(() => {
    if (phase === 'login') {
      setState(null);
      setActiveAgent(null);
    }
  }, [phase]);

  const fetchState = useCallback(async () => {
    if (!getSessionToken()) return;
    try {
      const data = await apiFetch<DashboardState>('/state');
      setState(data);
      setLastRefreshed(new Date());
      setActiveAgent((prev) => (prev ? data.agents.find((a) => a.machine_id === prev.machine_id) || null : null));
    } catch (e) {
      onApiError(e);
    }
  }, [onApiError]);

  const pollPresence = useCallback(async () => {
    if (!getSessionToken()) return;
    try {
      const p = await apiFetch<Presence>('/presence');
      const stale = Date.now() - lastFullFetchRef.current > FULL_REFRESH_MS;
      if (p.rev !== lastRevRef.current || stale) {
        lastRevRef.current = p.rev;
        lastFullFetchRef.current = Date.now();
        await fetchState();
        return;
      }
      const applyPresence = (a: Agent): Agent => {
        const ls = p.last_seen[a.machine_id];
        return ls === undefined ? a : { ...a, last_seen: ls, online: p.now - ls < p.online_sec };
      };
      setState((prev) => {
        if (!prev) return prev;
        const aliveSec = prev.limits?.pending_alive_sec ?? 45;
        const withAlive = (a: Agent): Agent => ({
          ...applyPresence(a),
          alive: p.now - (p.last_seen[a.machine_id] ?? 0) < aliveSec,
        });
        return {
          ...prev,
          now: p.now,
          notification_count: p.notification_count,
          agents: prev.agents.map(applyPresence),
          pending_agents: prev.pending_agents.map(withAlive),
          rejected_agents: prev.rejected_agents.map(withAlive),
        };
      });
      setActiveAgent((prev) => (prev ? applyPresence(prev) : prev));
    } catch (e) {
      onApiError(e);
    }
  }, [fetchState, onApiError]);

  useEffect(() => {
    if (phase !== 'ready') return;
    lastRevRef.current = '';
    pollPresence();
    const id = setInterval(pollPresence, POLL_MS);
    return () => clearInterval(id);
  }, [pollPresence, phase]);

  return { state, lastRefreshed, activeAgent, setActiveAgent, fetchState };
}
