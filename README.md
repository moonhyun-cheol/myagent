# MY Agent

**1.0.1** · seq **4** · [`moonhyun-cheol/myagent`](https://github.com/moonhyun-cheol/myagent)

Windows 온프렘 코딩 에이전트. 화면은 `ui/workspace` 하나, 시작점은 `MYAgent.exe`.

## 직원 PC (설치)

GitHub 릴리스 **[v1.0.1](https://github.com/moonhyun-cheol/myagent/releases/tag/v1.0.1)** 의 **`MYAgent-v*-install.zip`만** 받습니다.

- zip 루트에 `install.bat` + `app\` 가 있습니다. 압축 해제 후 `install.bat`을 실행합니다 (관리자 권한 없이).
- `Code → Download ZIP` / 릴리스의 **Source code (zip)** / git clone 은 설치 패키지가 아닙니다. exe가 없고 `install.bat`도 없습니다.

설치 폴더: `%LOCALAPPDATA%\Programs\MYAgent`.

## 개발 PC (클론)

```
git clone https://github.com/moonhyun-cheol/myagent.git
cd myagent
npm start
```

또는 `tools\commands\create-dev-shortcut.bat`으로 바탕화면 **MY Agent Dev** 바로가기를 만듭니다.

| | |
|---|---|
| 창 | `shell/CqrPa.Shell/` |
| API | `core/src/` |
| UI | `ui/workspace/` |
| 조직 모듈 | [`myagent-org`](https://github.com/moonhyun-cheol/myagent-org) |

## 업데이트 (두 갈래)

**코어(이 저장소)** — 앱이 켜질 때 `manifest.json`의 피드 URL을 읽습니다.  
`https://raw.githubusercontent.com/moonhyun-cheol/myagent/main/channels/stable.json`  
서명이 맞고 `update_sequence`가 **지금보다 크면** 확인창 → `MYAgent.Updater.exe`가 델타 zip을 적용합니다. SemVer가 아니라 **seq 숫자**가 기준입니다. 지금 피드는 seq **4**입니다. 첫 설치는 릴리스의 **install zip**입니다.

**조직 모듈** — 설정 → 스킬에서 zip을 **한 번** 고릅니다. 이후 실행 때 `myagent-org` 피드를 보고 seq가 크면 대화 없이 모듈만 갈아끼웁니다. 코어 Updater와 섞이지 않습니다.
