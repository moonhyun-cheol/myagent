@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Shared folders (Windows Sandbox \\tsclient, UNC, mapped network drives)
REM break CMD batch CALL ("배치 파일이 아닙니다"). Mirror to local disk first.
set "NEED_LOCAL="
echo %~dp0| findstr /B /C:"\\" >nul && set "NEED_LOCAL=1"
echo %~dp0| findstr /I /C:"\\tsclient\\" >nul && set "NEED_LOCAL=1"
for /f "tokens=2 delims==" %%A in ('wmic logicaldisk where "DeviceID='%~d0'" get DriveType /value 2^>nul') do (
  if "%%A"=="4" set "NEED_LOCAL=1"
)
REM wmic is missing on some Windows 11 PCs; catch mapped drives (Z: -> \\nas\...) anyway.
if not defined NEED_LOCAL (
  set "CQR_DP0=%~dp0"
  set "CQR_D0=%~d0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "if ($env:CQR_DP0 -like '\\*') { exit 1 }; $n = ($env:CQR_D0 + '').TrimEnd(':'); $d = Get-PSDrive -Name $n -ErrorAction SilentlyContinue; if ($d -and $d.DisplayRoot) { exit 1 }; exit 0" >nul 2>&1
  if errorlevel 1 set "NEED_LOCAL=1"
)
if not defined NEED_LOCAL goto :run_install

set "LOCAL_SRC=%LOCALAPPDATA%\MYAgent-install-src"
echo.
echo [MY Agent] Shared/network path detected:
echo   %~dp0
echo Copying package to local disk (required for Sandbox / mapped shares)...
echo   %LOCAL_SRC%
echo.

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
echo [MY Agent] ERROR: could not copy from shared path.
echo Copy the zip to C:\Temp on this PC, extract, run install.bat from that local folder.
pause
exit /b 1

:relaunch
if not exist "%LOCAL_SRC%\install.bat" (
  echo [MY Agent] ERROR: local copy missing install.bat
  pause
  exit /b 1
)
echo [MY Agent] Relaunching from local copy...
call "%LOCAL_SRC%\install.bat" %*
exit /b %ERRORLEVEL%

:run_install
if exist "%~dp0app\tools\install\install.ps1" (
  set "INSTALL_PS1=%~dp0app\tools\install\install.ps1"
  set "INSTALL_UI=%~dp0app\tools\install\install-ui.ps1"
  set "SOURCE=%~dp0app"
) else (
  set "INSTALL_PS1=%~dp0tools\install\install.ps1"
  set "INSTALL_UI=%~dp0tools\install\install-ui.ps1"
  set "SOURCE=%~dp0"
)
REM %~dp0 always ends with \ . A quoted "...\" eats the closing quote and
REM PowerShell then sees a " in the path (Illegal characters in path).
if "%SOURCE:~-1%"=="\" set "SOURCE=%SOURCE:~0,-1%"
if exist "%INSTALL_UI%" (
  powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%INSTALL_UI%" -SourceDir "%SOURCE%"
) else (
  echo MY Agent install - default folder is %LOCALAPPDATA%\Programs\MYAgent
  powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_PS1%" -SourceDir "%SOURCE%"
)
if errorlevel 1 pause
exit /b %ERRORLEVEL%
