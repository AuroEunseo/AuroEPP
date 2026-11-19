// 이미지 import 타입 선언 (예: import logoUrl from './assets/ac1.png')
declare module '*.png' {
  const src: string;
  export default src;
}
