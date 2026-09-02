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

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install\install-launcher.ps1" -SourceAppDir "%~dp0app" -Launch
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install\install-launcher.ps1" -SourceAppDir "%~dp0app" -TargetRoot "%~1" -Launch
)
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
