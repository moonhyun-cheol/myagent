@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
title MY Agent — Activation server autostart

echo.
echo  활성화 서버를 Windows 로그인 시 자동 시작합니다.
echo  (작업 스케줄러: MY Agent-ActivationServer)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\install-activation-autostart.ps1"
echo.
pause
exit /b %ERRORLEVEL%
