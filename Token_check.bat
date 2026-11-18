@echo off
chcp 65001 > nul

powershell -NoProfile -Command "$log = 'C:\Users\김은서\Desktop\Project_etc\PC_Agent\logs\backend.log'; if (Test-Path $log) { $line = Get-Content $log | Select-String '토큰' | Select-Object -Last 1; if ($line) { $tok = ($line.ToString().Split(':')[-1]).Trim(); Set-Clipboard -Value $tok; Write-Host '================================================' -ForegroundColor Cyan; Write-Host ('  현재 관리자 토큰: ' + $tok) -ForegroundColor Green; Write-Host '  (클립보드에 자동 복사되었습니다. Ctrl+V로 붙여넣으세요)' -ForegroundColor Yellow; Write-Host '================================================' -ForegroundColor Cyan } else { Write-Host '로그에서 토큰을 찾지 못했습니다.' -ForegroundColor Red } } else { Write-Host 'backend.log 파일이 없습니다. 서버가 실행 중인지 확인하세요.' -ForegroundColor Red }"

echo
pause