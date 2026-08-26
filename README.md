# MY Agent

Windows 온프렘 **코딩 에이전트 워크벤치**. Cursor 대체 IDE가 아니라, 라이선스·델타 배포가 붙은 납품형 앱입니다.

## 처음 볼 곳 (3줄)

1. **제품:** `shell/` → `core/` → `ui/workspace/` (화면은 workspace 하나)
2. **실행:** 설치본은 `MYAgent.exe` 하나, 소스 개발은 `npm run build` → `npm run build:exe`
3. **지도:** [rulebook/docs/ops/STRUCTURE.md](rulebook/docs/ops/STRUCTURE.md)
4. **진행상황:** [rulebook/docs/ops/진행상황.md](rulebook/docs/ops/진행상황.md)

| 폴더 | 역할 |
|------|------|
| `shell/CqrPa.Shell/` | WebView2 데스크톱 창 |
| `core/src/` | Node API · 채팅 · 코드 에이전트 (`:10200`) |
| `ui/workspace/` | 유일한 제품 UI |
| `tools/` | 빌드·배포·검증 ([tools/README.md](tools/README.md)) |
| `rulebook/docs/` | 명세·배포 가이드 |
| `data/` | 사용자 데이터 (업데이트 시 보존) |

코딩 에이전트용 메모는 [AGENTS.md](AGENTS.md)입니다. 사람 인수인계는 이 README와 STRUCTURE를 먼저 보세요.

## 운영 위치

이 저장소가 중립 코어의 작업·배포 기준입니다. 조직 모듈은 별도 저장소에서 독립 서명·업데이트합니다.

| 역할 | 위치 |
|------|------|
| 코어 소스·코어 업데이트 | 이 저장소 (`MY_CUSTOM_CODEX`) |
| 조직 모듈 계약·모듈 업데이트 | `MY_CUSTOM_CODEX-COMPANY` |
| 사용자 설치 폴더 | `%LOCALAPPDATA%\Programs\MY Agent` |
| 사용자 시작점 | `MYAgent.exe` |

## 로컬 실행

필요: Node 22+, Windows, WebView2. 클론만으로는 라이선스·빌드 산출물이 없습니다.

```powershell
npm install
npm run build
npm run build:exe
copy data\vault\license.ocx.example data\vault\license.ocx
MYAgent.exe
```

브라우저만 (셸 없이 API):

```powershell
$env:MY_AGENT_ROOT = (Get-Location).Path
node core\dist\main.js
# http://127.0.0.1:10200
```

설치 zip은 [README-설치.txt](README-설치.txt) · [명령어-모음](rulebook/docs/ops/명령어-모음.md) · [deploy-guide](rulebook/docs/ops/deploy-guide.md).

## 자주 쓰는 명령

| 목적 | 명령 |
|------|------|
| 검증 | `npm run verify` |
| 전체 설치 zip | `npm run publish` |
| 서명 코어 업데이트 zip | `npm run publish:update` |
| GitHub 코어 업데이트 게시 | `npm run publish:update:github -- --confirm` |
| 델타 적용 | `UPDATE.bat` |
| 진단 | `tools\commands\diagnostics.bat` |
| 유지보수 BAT | `tools\commands\` |
| 활성화 서버 | `npm run server:activation` |

## 제약

- 데이터는 `MY_AGENT_ROOT` 아래만 (`data/`). NAS 경로에 쓰지 않음.
- 서명 없는 license → read-only.
- 조직 전용 기능은 별도 서명 모듈로 설치하며 neutral core 저장소에 포함하지 않습니다.

## 기능 이력 (참고)

포지셔닝: Cline급 툴 루프 + 라이선스/델타 배포 + 한글 도메인 스킬·거짓완료 거버넌스.

- **활성화** — LAN 서버 `:10201`, 첫 발급 후 오프라인 동작 (`npm run server:activation`)
- **배포** — 사용자 시작점은 `MYAgent.exe`; `npm run publish` / `publish:delta` + `UPDATE.bat`는 관리자 작업 (`data/`·`runtime/` 보존)
- **모델** — NAS Ollama, API 프로바이더(vault 암호화), 선택적 로컬 GGUF
- **채팅** — SSE, 세션, 첨부(PDF/DOCX/영상), 이미지 생성·리서치
- **셸** — `shell/CqrPa.Shell`, 프로필 `data/webview-user-data/`

라이선스 관리: `npm run admin:keygen` · `npm run admin:issue` · `node tools/cqr-admin.mjs verify data\vault\license.ocx`
