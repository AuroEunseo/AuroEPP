$ErrorActionPreference = "Stop"
$Root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }

Write-Host "=== 0. 기존 PyInstaller .spec 캐시 정리 ===" -ForegroundColor Cyan
Remove-Item "$Root\*.spec" -Force -ErrorAction SilentlyContinue

Write-Host "=== 1. Vite 프론트엔드 빌드 ===" -ForegroundColor Cyan
Set-Location "$Root\frontend"
npm install
npm run build

Write-Host "=== 2. 백엔드 엔진 빌드 (--onedir) ===" -ForegroundColor Cyan
Set-Location $Root
pyinstaller --noconfirm --onedir --clean `
    --name "AuroraServerEngine" `
    --paths "$Root\backend" `
    --collect-submodules "app" `
    --add-data "$Root\backend\static;static" `
    --distpath "$Root\electron-console\resources" `
    --hidden-import "uvicorn.logging" `
    --hidden-import "uvicorn.loops" `
    --hidden-import "uvicorn.loops.auto" `
    --hidden-import "uvicorn.protocols" `
    --hidden-import "uvicorn.protocols.http" `
    --hidden-import "uvicorn.protocols.http.auto" `
    --hidden-import "uvicorn.lifespan" `
    --hidden-import "uvicorn.lifespan.on" `
    "$Root\build\server_entry.py"

Write-Host "=== 3. 에이전트 엔진 빌드 (--onedir) ===" -ForegroundColor Cyan
pyinstaller --noconfirm --onedir --clean `
    --name "AuroraAgentEngine" `
    --paths "$Root\agent" `
    --add-data "$Root\agent\worker.py;." `
    --distpath "$Root\electron-agent\resources" `
    --hidden-import "worker" `
    --hidden-import "win32timezone" `
    "$Root\agent\service.py"

Write-Host "=== 4. NSIS 설치 마법사 빌드 (Console & Agent) ===" -ForegroundColor Cyan
Set-Location "$Root\electron-console"
npm install
npm run build:win

Set-Location "$Root\electron-agent"
npm install
npm run build:win

Write-Host "=== 완료! dist-installers 폴더를 확인하세요 ===" -ForegroundColor Green
Get-ChildItem "$Root\dist-installers\*.exe"