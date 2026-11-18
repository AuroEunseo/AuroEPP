@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs"

:: 1. 백엔드 구동 (로그: logs\backend.log)
start "AURORA Backend" cmd /k "cd /d C:\Users\김은서\Desktop\Project_etc\PC_Agent\backend && python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload > "%~dp0logs\backend.log" 2>&1"

:: 2. 프론트엔드(Vite) 구동 (로그: logs\frontend.log)
start "AURORA Frontend" cmd /k "cd /d C:\Users\김은서\Desktop\Project_etc\PC_Agent\frontend && npm run dev > "%~dp0logs\frontend.log" 2>&1"