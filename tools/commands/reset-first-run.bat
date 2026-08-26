@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
title MY Agent — Reset first-run state

echo.
echo  ========================================
echo   MY Agent 첫 사용자 상태로 리셋
echo  ========================================
echo.
echo  삭제: license, API keys, 대화, 첨부, 설정, WebView 프로필
echo  유지: core / ui / runtime / models(GGUF 파일)
echo.
choice /C YN /M "계속하시겠습니까"
if errorlevel 2 (
  echo 취소됨.
  pause
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\reset-first-run.ps1" -Force
echo.
pause
exit /b %ERRORLEVEL%
