# MY Agent maintenance commands

일반 사용자는 프로젝트 루트의 `MYAgent.exe`만 실행합니다. 이 폴더의 BAT 파일은
개발·배포·복구·활성화 서버 운영용입니다.

| 명령 | 용도 |
|---|---|
| `diagnostics.bat` | 관리자 진단 |
| `publish-full.bat` | 전체 설치 ZIP 생성 |
| `publish-slim.bat` | 지연 다운로드형 설치 ZIP 생성 |
| `publish-delta.bat` | 델타 ZIP 생성 |
| `activation-server.bat` | 활성화 서버 실행 |
| `activation-autostart-install.bat` | 활성화 서버 자동 시작 등록 |
| `activation-autostart-remove.bat` | 활성화 서버 자동 시작 해제 |
| `reset-first-run.bat` | 사용자 로컬 상태 초기화 |
| `setup-vault.bat` | 수동 라이선스·키 번들 복사 |
| `refresh-shortcut.bat` | 바탕화면 바로가기 재생성 |
| `dev-run.bat` | 개발 실행 (`npm start`) |
| `create-dev-shortcut.bat` | 바탕화면 MY Agent Dev 바로가기 |
| `start-legacy.bat` | 이전 BAT 실행 경로 호환 |

`install.bat`은 git 루트에 두지 않습니다. `npm run publish`가 릴리스 zip 루트에만 넣습니다. 설치된 앱의 델타 적용은 `UPDATE.bat`입니다.
