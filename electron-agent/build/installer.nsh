!macro customInstall
  DetailPrint "AURORA 백그라운드 업데이트 서비스를 등록하는 중..."
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" install'
  nsExec::ExecToLog '"$INSTDIR\resources\AuroraAgentEngine\AuroraAgentEngine.exe" start'

  DetailPrint "Windows 시작 시 트레이 에이전트 자동 실행 등록 중..."
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "AURORAUpdateAgent" '"$INSTDIR\AURORA Update Agent.exe" --tray'

  DetailPrint "AURORA Update Agent 트레이 실행 중..."
  Exec '"$INSTDIR\AURORA Update Agent.exe" --tray'

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