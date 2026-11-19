!define AURORA_TASK_SCRIPT "$INSTDIR\resources\tasks\aurora-autostart.ps1"
; 작업 스케줄러 작업 이름은 제품명이 바뀌어도 유지 (기존 설치본과 같은 이름이어야 제거·업데이트 시 정리됨)
!define AURORA_TASK_NAME "AURORA Control Console"
!define AURORA_PORT "1557"

; 설치/업데이트 시작 전에 실행 중인 콘솔과 서버 엔진을 종료 (파일 잠김·고아 엔진 방지)
!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM AuroraServerEngine.exe /T'
!macroend

!macro customInstall
  ; 관제 서버 포트(기본 1557) 인바운드 허용. 포트를 바꾸면 server_config.json과 이 규칙을 함께 수정
  DetailPrint "Windows 방화벽에 AURORA 관제 서버 포트(${AURORA_PORT}) 허용 규칙 추가 중..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Control Server"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AURORA Control Server" dir=in action=allow protocol=TCP localport=${AURORA_PORT}'
!macroend

!macro customUnInstall
  ; 업데이트 설치(이전 버전 자동 제거)나 무인 제거 때는 묻지 않고 데이터를 항상 유지
  ${ifNot} ${isUpdated}
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "관제 서버 데이터(업데이트 DB, 관리자 계정, 백업)까지 모두 삭제할까요?$\r$\n$\r$\n위치: C:\ProgramData\AURORA\Server$\r$\n[아니요]를 누르면 데이터를 남겨 두어 다시 설치했을 때 그대로 사용할 수 있습니다." IDYES aurora_console_purge IDNO aurora_console_keep
      aurora_console_purge:
        nsExec::ExecToLog 'taskkill /F /IM AuroraServerEngine.exe /T'
        ReadEnvStr $0 PROGRAMDATA
        RMDir /r "$0\AURORA\Server"
        RMDir "$0\AURORA"
      aurora_console_keep:
    ${EndIf}
  ${endIf}

  DetailPrint "방화벽 규칙 및 자동 시작 작업 제거 중..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AURORA Control Server"'
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${AURORA_TASK_SCRIPT}" -Action unregister -TaskName "${AURORA_TASK_NAME}"'
  nsExec::ExecToLog 'taskkill /F /IM AuroraServerEngine.exe /T'
!macroend
