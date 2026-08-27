@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\desktop-shortcut.ps1" -Root "%ROOT%" -Dev
if errorlevel 1 pause
exit /b %ERRORLEVEL%
