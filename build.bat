@echo off
title AURORA NSIS Installer Build
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build\build_nsis.ps1"
pause