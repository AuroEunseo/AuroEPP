import { Agent } from '../types';

/** 마지막 통신 후 60초 이내면 온라인 (서버 ONLINE_WINDOW_SEC 와 동일) */
export const isAgentOnline = (a: Agent, now: number) => now - a.last_seen < 60;

/** PC에 적용된 정책 해시가 배포 그룹 목표 정책과 같은지 */
export const isPolicyApplied = (a: Agent) => Boolean(a.applied_hash && a.applied_hash === a.target_hash);
