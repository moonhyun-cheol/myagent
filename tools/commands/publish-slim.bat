@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
title MY Agent Slim Install ZIP

echo.
echo  MY Agent SLIM DEPLOY = verify + encoding + slim install zip
echo  node/python/ffmpeg/playwright deferred (downloaded at install)
echo  Output: deploy\output\MYAgent-v*-install-slim.zip
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [SLIM-DEPLOY] Node.js not found. Install Node 22+ or use runtime\node\node.exe
  pause
  exit /b 1
)

call npm run verify
if %errorlevel% neq 0 (
  echo [SLIM-DEPLOY] verify failed
  pause
  exit /b %errorlevel%
)

node tools\normalize-encoding.mjs
if %errorlevel% neq 0 (
  echo [SLIM-DEPLOY] normalize-encoding failed
  pause
  exit /b %errorlevel%
)

node tools\publish.mjs --node-mode=deferred --venv-mode=deferred
set EXITCODE=%ERRORLEVEL%

echo.
if %EXITCODE%==0 (
  echo [SLIM-DEPLOY] DONE - slim install zip
  echo  Apply: unzip on target PC, then run install.bat
  if exist "deploy\output" start "" explorer "deploy\output"
) else (
  echo [SLIM-DEPLOY] FAILED exit=%EXITCODE%
)
pause
exit /b %EXITCODE%
