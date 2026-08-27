# MY Agent

**1.0.0-beta.1** · seq **1** · [`moonhyun-cheol/myagent`](https://github.com/moonhyun-cheol/myagent)

Windows 온프렘 코딩 에이전트. 화면은 `ui/workspace` 하나, 시작점은 `MYAgent.exe`.

| | |
|---|---|
| 창 | `shell/CqrPa.Shell/` |
| API | `core/src/` |
| UI | `ui/workspace/` |
| 설치 | [README-설치.txt](README-설치.txt) |
| 1.4 보관본 이식 | [PORT.md](PORT.md) |
| 조직 모듈 | [`myagent-org`](https://github.com/moonhyun-cheol/myagent-org) |

설치 폴더: `%LOCALAPPDATA%\Programs\MYAgent`. 개발은 `npm install` → `npm run build` → `npm run build:exe`.

## 업데이트 (두 갈래)

**코어(이 저장소)** — 앱이 켜질 때 `manifest.json`의 피드 URL을 읽습니다.  
`https://raw.githubusercontent.com/moonhyun-cheol/myagent/main/channels/beta.json`  
서명이 맞고 `update_sequence`가 **지금보다 크면** 확인창 → `MYAgent.Updater.exe`가 델타 zip을 적용합니다. SemVer가 아니라 **seq 숫자**가 기준입니다. 지금 seq는 1이라, 이미 seq 1인 설치본은 인앱 업데이트가 없습니다. 첫 설치는 릴리스의 **install zip**입니다.

**조직 모듈** — 설정 → 스킬에서 zip을 **한 번** 고릅니다. 이후 실행 때 `myagent-org` 피드를 보고 seq가 크면 대화 없이 모듈만 갈아끼웁니다. 코어 Updater와 섞이지 않습니다.
