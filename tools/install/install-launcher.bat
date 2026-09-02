@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0app\WorkKitLauncher.exe" (
  echo.
  echo [WorkKitLauncher] This folder is not the launcher install package.
  echo Download WorkKitLauncher-v*-install.zip from the launcher-v* GitHub release.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install\install-launcher.ps1" -Interactive -SourceAppDir "%~dp0app"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
