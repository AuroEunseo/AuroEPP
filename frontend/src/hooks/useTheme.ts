import { useEffect, useState } from 'react';
import { ThemeKey } from '../constants/themes';

/** 화면 테마 (브라우저에 저장, <html data-theme> 에 반영) */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeKey>(() => (localStorage.getItem('aurora_theme') as ThemeKey) || 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('aurora_theme', theme);
  }, [theme]);
  return { theme, setTheme };
}
