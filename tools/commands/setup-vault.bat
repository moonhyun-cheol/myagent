@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if not exist "data\vault" mkdir "data\vault"

set COPIED=0
if exist "license.ocx" (
  copy /Y "license.ocx" "data\vault\license.ocx" >nul
  echo [OK] license.ocx -^> data\vault\
  set COPIED=1
) else (
  echo [--] license.ocx 없음 — 관리자에게 PC용 license를 받으세요.
)

if exist "keys-bundle.enc" (
  copy /Y "keys-bundle.enc" "data\vault\keys-bundle.enc" >nul
  echo [OK] keys-bundle.enc -^> data\vault\
  set COPIED=1
) else (
  echo [--] keys-bundle.enc 없음 — Ollama 키는 모델 탭에서 수동 등록 가능
)

if %COPIED%==0 (
  echo.
  echo 복사할 파일이 없습니다. license.ocx / keys-bundle.enc 를 이 폴더에 두고 다시 실행하세요.
  pause
  exit /b 1
)

echo.
echo 완료. MYAgent.exe를 실행하세요. (최초 1회 vault에 반영됩니다)
pause
