# 이식 지도 — 코어 `myagent`

작업은 **이 저장소만** 한다. 구 저장소 CQR_PA는 보관용이며 여기서 개발하지 않는다.

**이 저장소: MY Agent `1.0.0-beta.1` · `update_sequence` 2 · GitHub `moonhyun-cheol/myagent`**

CQR_PA에 남은 수정이 있으면 아래 표대로 여기 또는 `myagent-org`에 옮긴다.

## 어디로

| 구 저장소에서 고친 것 | 넣는 곳 | 이 저장소 경로 |
|---|---|---|
| 창, 설치, 업데이트, 라이선스 | **여기 (코어)** | `shell/`, `tools/install/` |
| API, 채팅, 코드 에이전트, 세션 | **여기** | `core/src/` |
| 화면 | **여기** | `ui/workspace/src/` |
| 활성화 서버 | **여기** | `activation-server/` |
| 코어 배포·검증 스크립트 | **여기** | `tools/` (모듈 패커 제외) |
| 내장 스킬 (코드/랜딩/프롬프트 마스터) | **여기** | `core/config/defaults/skills/` |
| 컨셉 RA, 시장조사, 브랜드 데이터, 조직 스킬 | **`myagent-org`** | `agent-module/` — 이 저장소에 넣지 말 것 |
| `.chroma`, Excel, NAS 추출물 | 넣지 않음 | 모듈 git 금지 |

같은 상대 경로면 구 저장소 `core/src/foo.ts` → 이 저장소 `core/src/foo.ts`.

## 지금 뭐가 다른지

CRLF만 다른 파일은 무시한다. **내용이 다른 파일만** 본다.

`apply_core`는 “구 저장소가 더 최신”이 아니다. 쪼개기 동안 **양쪽이 갈라진 파일**이다. 파일을 열고 구 저장소 쪽 의도만 골라 이 저장소에 넣는다.

```powershell
$env:MY_AGENT_LEGACY_ROOT = "C:\Users\Temp\Desktop\업무\CQR_PA"
npm run port:status
```

출력의 `apply: core` 는 이 저장소에 이식. `apply: org` 는 `myagent-org`의 `agent-module/`.

## 형제 저장소

조직 모듈 버전·시퀀스는 여기 숫자가 아니라 `MY_CUSTOM_CODEX-COMPANY/repo-target.json`을 본다.
