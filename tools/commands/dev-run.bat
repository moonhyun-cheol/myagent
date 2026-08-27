@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
title MY Agent Dev Run
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [DEV] Node.js not found. Install Node 22+ first.
  pause
  exit /b 1
)
node "%ROOT%\tools\dev-run.mjs"
if errorlevel 1 (
  echo.
  echo [DEV] launch failed
  pause
  exit /b 1
)
exit /b 0
