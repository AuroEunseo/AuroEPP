$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== 1. Vite 프론트엔드 빌드 (backend/static 출력) ===" -ForegroundColor Cyan
Set-Location "$Root\frontend"
npm install
npm run build

Write-Host "=== 2. AuroraServer.exe 패키징 ===" -ForegroundColor Cyan
Set-Location $Root
pyinstaller --noconfirm --onefile --clean `
    --name "AuroraServer" `
    --paths "$Root\backend" `
    --add-data "$Root\backend\static;static" `
    --hidden-import "uvicorn.logging" `
    --hidden-import "uvicorn.loops" `
    --hidden-import "uvicorn.loops.auto" `
    --hidden-import "uvicorn.protocols" `
    --hidden-import "uvicorn.protocols.http" `
    --hidden-import "uvicorn.protocols.http.auto" `
    --hidden-import "uvicorn.lifespan" `
    --hidden-import "uvicorn.lifespan.on" `
    "$Root\build\server_entry.py"

Write-Host "=== 3. AuroraAgent.exe 패키징 (Windows 서비스 내장) ===" -ForegroundColor Cyan
pyinstaller --noconfirm --onefile --clean `
    --name "AuroraAgent" `
    --paths "$Root\agent" `
    --hidden-import "win32timezone" `
    "$Root\agent\service.py"

Write-Host "=== 빌드 완료! dist 폴더를 확인하세요 ===" -ForegroundColor Green
Get-ChildItem "$Root\dist"