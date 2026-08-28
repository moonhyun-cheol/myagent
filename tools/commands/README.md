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
| `start-legacy.bat` | 이전 BAT 실행 경로 호환 |

설치와 업데이트 진입점은 배포 구조상 각각 루트 `install.bat`, `UPDATE.bat`로 유지합니다.
