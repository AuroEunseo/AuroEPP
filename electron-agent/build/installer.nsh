!define AURORA_TASK_SCRIPT "$INSTDIR\resources\tasks\aurora-autostart.ps1"
; 작업 스케줄러 작업 이름은 제품명이 바뀌어도 유지 (기존 설치본과 같은 이름이어야 제거·업데이트 시 정리됨)
!define AURORA_TASK_NAME "AURORA Update Agent Tray"

; 설치/업데이트 시작 전에 실행 중인 서비스·엔진 종료 (엔진 파일이 잠겨 덮어쓰지 못하는 문제 방지)
!macro customInit
  nsExec::ExecToLog 'sc stop AuroraUpdateAgent'
  Sleep 2000
  nsExec::ExecToLog 'taskkill /F /IM AuroraAgentEngine.exe /T'
!macroend

!macro customInstall
  DetailPrint "AURORA Endpoint Agent 백그라운드 서비스를 등록하는 중..."
  ; 부팅 시 자동 시작(--startup auto) + 비정상 종료 시 자동 재시작
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" --startup auto install'
  nsExec::ExecToLog 'sc config AuroraUpdateAgent start= auto'
  nsExec::ExecToLog 'sc failure AuroraUpdateAgent reset= 86400 actions= restart/5000/restart/10000/restart/30000'
  nsExec::ExecToLog 'sc failureflag AuroraUpdateAgent 1'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" start'

  DetailPrint "이전 버전의 자동 실행 레지스트리 정리 중..."
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "AURORAUpdateAgent"

  DetailPrint "작업 스케줄러에 트레이 자동 시작 등록 중 (로그온 시, 가장 높은 권한, --minimized)..."
  ; 실행 인수는 main.js의 STARTUP_ARG(--minimized)와 반드시 동일하게 유지
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${AURORA_TASK_SCRIPT}" -Action register -TaskName "${AURORA_TASK_NAME}" -Exe "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Arguments "--minimized" -Scope AllUsers'

  ; 에이전트 PC는 서버로 나가는 연결만 사용하므로 인바운드 방화벽 규칙이 필요 없음
  ; (이전 버전 설치 파일이 추가한 규칙은 제거)
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Update Control Server"'

  DetailPrint "AURORA Endpoint Agent 트레이 실행 중..."
  ; 설치 직후에는 서버 IP/포트를 입력할 수 있도록 설정 창을 띄운 상태로 실행 (인수 없음)
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro customUnInstall
  DetailPrint "자동 시작 작업 및 백그라운드 서비스 제거 중..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${AURORA_TASK_SCRIPT}" -Action unregister -TaskName "${AURORA_TASK_NAME}"'
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "AURORAUpdateAgent"
  ; 실행 파일 이름은 package.json 의 productName 을 따름 (이전 이름도 함께 종료)
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  nsExec::ExecToLog 'taskkill /F /IM "AURORA Update Agent.exe" /T'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" remove'
  ; 업데이트 설치(이전 버전 자동 제거)나 무인 제거 때는 묻지 않고 데이터를 항상 유지
  ${ifNot} ${isUpdated}
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "에이전트 데이터(인증 토큰, 서버 주소 설정, 레지스트리 변경 이력, 로그)까지 모두 삭제할까요?$\r$\n$\r$\n위치: C:\ProgramData\AURORA$\r$\n[아니요]를 누르면 다시 설치했을 때 재승인 없이 바로 연결됩니다.$\r$\n[예]를 누르면 다시 설치 시 콘솔에서 재승인이 필요합니다." IDYES aurora_agent_purge IDNO aurora_agent_keep
      aurora_agent_purge:
        ReadEnvStr $0 PROGRAMDATA
        ; 같은 PC에 관제 콘솔이 설치된 경우를 위해 Server 폴더는 건드리지 않음
        Delete "$0\AURORA\identity.json"
        Delete "$0\AURORA\identity.json.bak"
        Delete "$0\AURORA\identity.json.tmp"
        Delete "$0\AURORA\agent_config.json"
        Delete "$0\AURORA\registry_history.json"
        RMDir /r "$0\AURORA\logs"
        RMDir "$0\AURORA"
      aurora_agent_keep:
    ${EndIf}
  ${endIf}
!macroend
