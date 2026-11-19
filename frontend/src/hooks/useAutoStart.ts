import { useCallback, useEffect, useState } from 'react';

/** 콘솔 앱 자동 시작 (Electron preload 의 consoleApi → 작업 스케줄러). 브라우저에서는 설정 불가 안내 */
export function useAutoStart(showToast: (msg: string) => void) {
  const [autoStart, setAutoStart] = useState<boolean>(() => localStorage.getItem('aurora_autostart') === 'true');

  // Electron 콘솔에서 실제 Windows 자동 시작 등록 상태를 읽어와 동기화
  useEffect(() => {
    const ipc = (window as any).consoleApi;
    if (!ipc?.getPrefs) return;
    ipc
      .getPrefs()
      .then((p: { openAtLogin: boolean }) => {
        setAutoStart(Boolean(p?.openAtLogin));
        localStorage.setItem('aurora_autostart', String(Boolean(p?.openAtLogin)));
      })
      .catch(() => {});
  }, []);

  const toggleAutoStart = useCallback(
    async (checked: boolean) => {
      const ipc = (window as any).consoleApi;
      if (!ipc?.setAutoStart) {
        setAutoStart(checked);
        localStorage.setItem('aurora_autostart', String(checked));
        showToast('브라우저에서는 자동 시작을 설정할 수 없습니다. AURORA Endpoint Control Console 앱에서 설정하세요.');
        return;
      }
      try {
        const res = await ipc.setAutoStart(checked);
        const applied = Boolean(res?.openAtLogin);
        setAutoStart(applied);
        localStorage.setItem('aurora_autostart', String(applied));
        showToast(applied ? '✓ Windows 로그인 시 자동 시작이 설정되었습니다.' : '✓ 자동 시작이 해제되었습니다.');
      } catch (e: any) {
        showToast(`자동 시작 설정 실패: ${e?.message || e}`);
      }
    },
    [showToast]
  );

  return { autoStart, toggleAutoStart };
}
