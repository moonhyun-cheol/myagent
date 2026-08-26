@echo off
setlocal
cd /d "%~dp0"
echo MY Agent 델타 업데이트 (data 폴더 보존)
echo.
echo 주의: 실행 중인 MYAgent.exe가 있으면 자동 종료 후 앱을 교체합니다.
echo 채팅(sessions/projects)은 data\backups\pre-update-* 로 먼저 백업됩니다.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update\apply-delta.ps1" -Root "%~dp0." %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%
