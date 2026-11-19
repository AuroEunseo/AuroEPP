<#
  AURORA 자동 시작 작업(작업 스케줄러) 등록/해제/조회 스크립트
  - 관리자 권한(requireAdministrator) 앱은 Run 레지스트리로는 로그인 시 실행되지 않으므로
    "가장 높은 수준의 권한으로 실행" 로그온 작업으로 등록한다.
  - Scope AllUsers  : 모든 사용자 로그온 시 실행 (에이전트 트레이)
    Scope CurrentUser: 현재 사용자 로그온 시에만 실행 (관제 콘솔)

  사용 예)
    powershell -NoProfile -ExecutionPolicy Bypass -File aurora-autostart.ps1 -Action register `
      -TaskName "AURORA Update Agent Tray" -Exe "C:\Program Files\AURORA Update Agent\AURORA Update Agent.exe" `
      -Arguments "--minimized" -Scope AllUsers
#>
param(
  [ValidateSet('register', 'unregister', 'query')][string]$Action = 'query',
  [Parameter(Mandatory = $true)][string]$TaskName,
  [string]$Exe = '',
  [string]$Arguments = '--minimized',
  [ValidateSet('AllUsers', 'CurrentUser')][string]$Scope = 'AllUsers'
)
$ErrorActionPreference = 'Stop'
$TaskPath = '\AURORA\'

function Get-AuroraTask {
  Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

try {
  switch ($Action) {
    'query' {
      if (Get-AuroraTask) { Write-Output 'REGISTERED' } else { Write-Output 'NOT_REGISTERED' }
    }
    'unregister' {
      if (Get-AuroraTask) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false }
      Write-Output 'NOT_REGISTERED'
    }
    'register' {
      if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { throw "실행 파일을 찾을 수 없습니다: $Exe" }
      $act = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory (Split-Path -Parent $Exe)
      if ($Scope -eq 'AllUsers') {
        $trg = New-ScheduledTaskTrigger -AtLogOn
        # BUILTIN\Users 그룹: 로그온한 각 사용자 세션에서 실행 (관리자 계정은 권한 상승 상태로 실행)
        $prn = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Highest
      } else {
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $trg = New-ScheduledTaskTrigger -AtLogOn -User $user
        $prn = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
      }
      $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
      $task = New-ScheduledTask -Action $act -Trigger $trg -Principal $prn -Settings $set `
        -Description 'AURORA 자동 시작 (로그온 시 트레이로 실행)'
      Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject $task -Force | Out-Null
      Write-Output 'REGISTERED'
    }
  }
  exit 0
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
