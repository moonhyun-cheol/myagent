@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
title MY Agent Delta Update ZIP

echo.
echo  MY Agent SLIM UPDATE = delta zip (core/dist, UI, shell, rulebook ...)
echo  Apply keeps data/ logs/ runtime/
echo  Output: deploy\output\MYAgent-v*-delta.zip
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [SLIM-UPDATE] Node.js not found. Install Node 22+ or use runtime\node\node.exe
  pause
  exit /b 1
)

call npm run publish:delta
set EXITCODE=%ERRORLEVEL%

echo.
if %EXITCODE%==0 (
  echo [SLIM-UPDATE] DONE - delta zip
  echo  Apply: copy zip into install folder, then run UPDATE.bat
  if exist "deploy\output" start "" explorer "deploy\output"
) else (
  echo [SLIM-UPDATE] FAILED exit=%EXITCODE%
)
pause
exit /b %EXITCODE%
