import { useCallback } from 'react';
import { apiFetch, errorMessage } from '../api';
import { useConsole } from '../context/ConsoleContext';

/** 승인 대기 PC 승인/거부 (대시보드 배너와 승인 대기 PC 화면에서 공용) */
export function useAgentDecision() {
  const { showToast, fetchState } = useConsole();
  return useCallback(
    async (machineId: string, approve: boolean, ring = 'ring1') => {
      try {
        await apiFetch(`/agents/${encodeURIComponent(machineId)}/decision`, { approve, ring });
        showToast(
          approve
            ? '✓ 에이전트 응답을 확인하고 승인했습니다. 다음 통신부터 관리 대상으로 등록됩니다.'
            : '등록을 거부했습니다. (거부 PC 메뉴에서 해제 가능)'
        );
      } catch (e) {
        alert(errorMessage(e));
      }
      fetchState();
    },
    [showToast, fetchState]
  );
}
