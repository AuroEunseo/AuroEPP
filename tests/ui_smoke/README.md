# 콘솔 화면 스모크 테스트

콘솔 화면을 고친 뒤, 의도하지 않은 화면 변화나 런타임 오류가 없는지 자동으로 확인합니다.
합성 테스트 데이터(가상 PC `PC-SAMPLE-01~05`)를 쓰며, 실사용 DB·설정은 건드리지 않습니다.

## 처음 한 번 준비
```
cd tests/ui_smoke
npm install
npx playwright install chromium
```
Python 쪽은 `backend/requirements.txt` 가 설치된 환경이면 됩니다. `frontend` 에서 `npm install` 도 되어 있어야 합니다.

## 실행 (프로젝트 루트에서)
```
python tests/ui_smoke/run_smoke.py
```
- 결과: `화면 14/14 일치, 런타임 오류 0건` 이면 정상
- 다르면 어떤 화면의 어떤 글자가 바뀌었는지 보여 주고 종료 코드 1로 끝납니다.

## 화면을 의도적으로 바꾼 경우
변경 내용을 확인한 뒤 기준을 갱신하고 `baseline.json` 을 함께 커밋하세요.
```
python tests/ui_smoke/run_smoke.py --update-baseline
```

## 점검하는 화면 (14개)
로그인, 대시보드, 관리중 PC, 승인 대기 PC, 거부 PC, 레지스트리 정책, Windows 업데이트 규칙, 알림, 로그, 설정,
PC 상세, PC 검색 결과, 정책 그룹 전환(ring0), KB 입력 상태
