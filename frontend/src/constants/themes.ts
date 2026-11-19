export type ThemeKey = 'dark' | 'white' | 'lightblue' | 'pink' | 'ivory';

export interface ThemeDef {
  key: ThemeKey;
  label: string;
  bg: string;
  fg: string;
  accent: string;
}

/** 설정 탭의 화면 테마 5종 (실제 색상 변수는 index.css 의 [data-theme] 에 정의) */
export const THEMES: ThemeDef[] = [
  { key: 'dark', label: '다크 (Dark)', bg: '#090e1a', fg: '#f8fafc', accent: '#38bdf8' },
  { key: 'white', label: '화이트 (White)', bg: '#ffffff', fg: '#0f172a', accent: '#0284c7' },
  { key: 'lightblue', label: '라이트블루 (Sky)', bg: '#e0f0fe', fg: '#0c2442', accent: '#0284c7' },
  { key: 'pink', label: '핑크 (Blossom)', bg: '#fce7f3', fg: '#3b0d26', accent: '#db2777' },
  { key: 'ivory', label: '아이보리 (Warm)', bg: '#f4efe4', fg: '#292218', accent: '#b45309' },
];
