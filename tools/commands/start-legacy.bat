@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if exist "%ROOT%\MYAgent.exe" (
  start "" "%ROOT%\MYAgent.exe"
  exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%ROOT%\tools\launch-cqr.ps1" -Root "%ROOT%"
exit /b %ERRORLEVEL%
