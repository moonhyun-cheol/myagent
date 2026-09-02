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
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [WorkKitLauncher] 설치에 실패했습니다. 위 안내를 확인하세요.
)
echo.
echo 종료하려면 아무 키나 누르세요...
pause >nul
exit /b %EXITCODE%
