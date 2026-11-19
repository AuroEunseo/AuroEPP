!macro customInstall
  DetailPrint "AURORA 백그라운드 업데이트 서비스를 등록하는 중..."
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" install'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" start'

  DetailPrint "Windows 시작 시 트레이 에이전트 자동 실행 등록 중..."
  ; 실행 인수는 main.js의 STARTUP_ARG(--minimized)와 반드시 동일하게 유지
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "AURORAUpdateAgent" '"$INSTDIR\AURORA Update Agent.exe" --minimized'

  DetailPrint "AURORA Update Agent 트레이 실행 중..."
  ; 설치 직후에는 서버 IP/포트를 입력할 수 있도록 설정 창을 띄운 상태로 실행 (인수 없음)
  Exec '"$INSTDIR\AURORA Update Agent.exe"'

  DetailPrint "Windows 방화벽에 AURORA 서버 포트(8080) 허용 규칙 추가 중..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Update Control Server"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AURORA Update Control Server" dir=in action=allow protocol=TCP localport=8080'

!macroend

!macro customUnInstall
  DetailPrint "자동 실행 레지스트리 및 백그라운드 서비스 제거 중..."
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "AURORAUpdateAgent"
  nsExec::ExecToLog 'taskkill /F /IM "AURORA Update Agent.exe" /T'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" remove'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Update Control Server"'
!macroend