!define AURORA_TASK_SCRIPT "$INSTDIR\resources\tasks\aurora-autostart.ps1"
!define AURORA_TASK_NAME "AURORA Control Console"
!define AURORA_PORT "1557"

!macro customInstall
  ; 관제 서버 포트(기본 1557) 인바운드 허용. 포트를 바꾸면 server_config.json과 이 규칙을 함께 수정
  DetailPrint "Windows 방화벽에 AURORA 관제 서버 포트(${AURORA_PORT}) 허용 규칙 추가 중..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Control Server"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AURORA Control Server" dir=in action=allow protocol=TCP localport=${AURORA_PORT}'
!macroend

!macro customUnInstall
  DetailPrint "방화벽 규칙 및 자동 시작 작업 제거 중..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Control Server"'
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${AURORA_TASK_SCRIPT}" -Action unregister -TaskName "${AURORA_TASK_NAME}"'
  nsExec::ExecToLog 'taskkill /F /IM AuroraServerEngine.exe /T'
!macroend
