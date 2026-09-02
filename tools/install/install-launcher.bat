@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0app\WorkKitLauncher.exe" (
  echo.
  echo [WorkKitLauncher] This folder is not the launcher install package.
  echo Download WorkKitLauncher-v*-install.zip from launcher-v1.0.6 on GitHub.
  echo.
  pause
  exit /b 1
)

set "NEED_LOCAL="
echo %~dp0| findstr /B /C:"\\" >nul && set "NEED_LOCAL=1"
echo %~dp0| findstr /I /C:"\\tsclient\\" >nul && set "NEED_LOCAL=1"
for /f "tokens=2 delims==" %%A in ('wmic logicaldisk where "DeviceID='%~d0'" get DriveType /value 2^>nul') do (
  if "%%A"=="4" set "NEED_LOCAL=1"
)
if not defined NEED_LOCAL (
  set "CQR_DP0=%~dp0"
  set "CQR_D0=%~d0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "if ($env:CQR_DP0 -like '\\*') { exit 1 }; $n = ($env:CQR_D0 + '').TrimEnd(':'); $d = Get-PSDrive -Name $n -ErrorAction SilentlyContinue; if ($d -and $d.DisplayRoot) { exit 1 }; exit 0" >nul 2>&1
  if errorlevel 1 set "NEED_LOCAL=1"
)
if not defined NEED_LOCAL goto :run_install

set "LOCAL_SRC=%LOCALAPPDATA%\MYAgent-launcher-install-src"
echo.
echo [MY Agent Manager] Shared/network path detected. Copying to local disk...
echo   %LOCAL_SRC%
if exist "%LOCAL_SRC%" rd /s /q "%LOCAL_SRC%" 2>nul
mkdir "%LOCAL_SRC%" 2>nul
where robocopy >nul 2>&1
if errorlevel 1 goto :xcopy_fallback
robocopy "%~dp0." "%LOCAL_SRC%" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
if errorlevel 8 goto :copy_fail
goto :relaunch
:xcopy_fallback
xcopy "%~dp0*" "%LOCAL_SRC%\" /E /I /H /Y /Q
if errorlevel 1 goto :copy_fail
goto :relaunch
:copy_fail
echo [MY Agent Manager] ERROR: could not copy from shared path.
pause
exit /b 1
:relaunch
call "%LOCAL_SRC%\install-launcher.bat" %*
exit /b %ERRORLEVEL%

:run_install
set "INSTALL_UI=%~dp0tools\install\install-launcher-ui.ps1"
set "INSTALL_PS1=%~dp0tools\install\install-launcher.ps1"
set "SOURCE=%~dp0app"
if "%SOURCE:~-1%"=="\" set "SOURCE=%SOURCE:~0,-1%"

if exist "%INSTALL_UI%" (
  powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%INSTALL_UI%" -SourceAppDir "%SOURCE%"
) else if exist "%INSTALL_PS1%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_PS1%" -SourceAppDir "%SOURCE%" -Launch
) else (
  echo [MY Agent Manager] Installer scripts are missing.
  pause
  exit /b 1
)
exit /b %ERRORLEVEL%
