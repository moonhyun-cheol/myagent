@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
title MY Agent Publish

echo.
echo  MY Agent PUBLISH = verify + encoding + install zip
echo  Includes: neutral core, configured provider defaults, desktop shell
echo  Optional NOT in zip: runtime/llama-cpp, runtime/sd-cpp
echo  Output: deploy\output\MYAgent-v*-install.zip
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [PUBLISH] Node.js not found. Install Node 22+ or use runtime\node\node.exe
  pause
  exit /b 1
)

call npm run verify
if %errorlevel% neq 0 (
  echo [PUBLISH] verify failed
  pause
  exit /b %errorlevel%
)

node tools\normalize-encoding.mjs
if %errorlevel% neq 0 (
  echo [PUBLISH] normalize-encoding failed
  pause
  exit /b %errorlevel%
)

call npm run publish
set EXITCODE=%ERRORLEVEL%

echo.
if %EXITCODE%==0 (
  echo [PUBLISH] DONE
  if exist "deploy\output" start "" explorer "deploy\output"
) else (
  echo [PUBLISH] FAILED exit=%EXITCODE%
)
pause
exit /b %EXITCODE%
