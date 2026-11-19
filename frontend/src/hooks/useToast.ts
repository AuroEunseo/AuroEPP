import { useCallback, useState } from 'react';

/** 화면 우측 상단 토스트 메시지 (3.5초 후 자동 사라짐) */
export function useToast() {
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  }, []);
  return { toastMsg, showToast };
}
