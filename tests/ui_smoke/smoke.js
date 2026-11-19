// 콘솔 화면 스모크 테스트
//  로그인 → 모든 메뉴 순회 → PC 상세 → 검색 → 정책 그룹 전환 → KB 입력
//  각 화면의 텍스트(시간 표시는 <TS> 등으로 정규화)를 JSON으로 저장한다.
//  사용법: node smoke.js <출력파일.json> <콘솔 주소> <admin 비밀번호>
const { chromium } = require('playwright');
const fs = require('fs');

const [OUT, BASE, PW] = process.argv.slice(2);
const norm = (t) =>
  t
    .replace(/\d{4}[.-] ?\d{1,2}[.-] ?\d{1,2}\.? ?(오전|오후)? ?\d{1,2}:\d{2}(:\d{2})?/g, '<TS>')
    .replace(/(오전|오후) \d{1,2}:\d{2}:\d{2}/g, '<TS>')
    .replace(/\d+초 전/g, '<N>초 전')
    .replace(/:\d{4,5}\b/g, ':<PORT>')
    .replace(/포트 \d+/g, '포트 <PORT>')
    .replace(/[ \t]+/g, ' ')
    .trim();

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('dialog', (d) => d.accept());
  const snap = {};
  const shot = async (k) => (snap[k] = norm(await p.innerText('body')));

  await p.goto(BASE);
  await p.waitForTimeout(600);
  await shot('login');
  await p.fill('input[autocomplete=username]', 'admin');
  await p.fill('input[autocomplete=current-password]', PW);
  await p.click('button[type=submit]');
  await p.waitForTimeout(3500);
  await shot('dashboard');

  const sub = (t) => `.nav-sub-item:has-text("${t}")`;
  const top = (t) => `.nav-item:has-text("${t}")`;
  const menus = [
    [sub('관리중 PC'), 'pcs_managed'],
    [sub('승인 대기 PC'), 'pcs_pending'],
    [sub('거부 PC'), 'pcs_rejected'],
    [sub('레지스트리 정책 관리'), 'policy_registry'],
    [sub('Windows 업데이트 규칙'), 'policy_rules'],
    [top('알림'), 'notifications'],
    [top('로그 관리'), 'logs'],
    [top('설정'), 'settings'],
  ];
  for (const [sel, key] of menus) {
    await p.click(sel);
    await p.waitForTimeout(700);
    await shot(key);
  }

  await p.click(sub('관리중 PC'));
  await p.waitForTimeout(400);
  await p.click('tbody tr >> nth=0');
  await p.waitForTimeout(6000); // PC 상세의 이력 재요청이 반영될 때까지 대기
  await shot('drawer');
  await p.click('.drawer-backdrop', { position: { x: 20, y: 20 } });
  await p.waitForTimeout(300);

  await p.fill('input[placeholder*="검색"]', 'SAMPLE-02');
  await p.waitForTimeout(300);
  await shot('pcs_search');

  await p.click(sub('레지스트리 정책 관리'));
  await p.waitForTimeout(400);
  const ringSel = await p.$('select');
  if (ringSel) {
    await ringSel.selectOption('ring0');
    await p.waitForTimeout(400);
  }
  await shot('policy_ring0');

  await p.click(sub('Windows 업데이트 규칙'));
  await p.waitForTimeout(400);
  const kb = await p.$('input[placeholder*="KB"]');
  if (kb) await kb.fill('KB5022222');
  await shot('rules_input');

  fs.writeFileSync(OUT, JSON.stringify({ snap, errs }, null, 1));
  console.log(`화면 ${Object.keys(snap).length}개 기록, 런타임 오류 ${errs.length}건`);
  await b.close();
})();
