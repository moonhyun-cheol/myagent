# 실시간 도구 실행 로그 — 메인앱 반영 작업명세

- 작업일: 2026-09-07
- 후보: `2026-09-07-live-tool-activity`
- 상태: 소스 구현 및 아래 검증 완료. 배포 실행파일 교체/메인앱 재시작은 수행하지 않음.

## 1. 목적 및 고정 제약

기존 간략 진행 표시와 공개 reasoning 표시를 유지하고, 별도 접이식 **작업 로그**로 실제 실행 내역을 제공한다. 모델 추론을 더 노출하거나 가상 진행률을 생성하지 않는다.

- artifactKind: 기존 기능 수정 + 실행 로그 컴포넌트/검증 스크립트 추가.
- runtimeSurface: 기존 웹 UI/API. 별도 사용자용 앱/페이지를 만들지 않음.
- entry point: executeAgentTool 실행 observer → 기존 채팅 SSE → 해당 assistant turn의 로그 컴포넌트.
- data sources: 실제 도구 lifecycle, 자식 프로세스 stdout/stderr, 종료 결과, 저장된 세션 메시지.
- requiredSecrets: 신규 없음.
- do-not-touch: 추론 설정, 공급자 reasoning 요청, 승인 정책, 배포 실행파일. 기존 결과 evidence/실행 명령은 마스킹 때문에 변경하지 않음.

## 2. 사용자 동작

- 기본 접힘: 최근 작업명, 상태, 경과시간, 마지막 출력 한 줄.
- 펼치기: 작업별 대상/명령, stdout 및 `[stderr]` 출력, 완료/실패/취소 상태와 종료 코드.
- 무출력 작업: 출력 대기 및 경과시간 표시. 진행률은 추정하지 않음.
- 실행 중 1초 단위 시계 갱신. 완료한 작업의 시간은 고정.
- live가 종료됐지만 최종 이벤트가 없는 행은 `연결 종료 · 완료 상태 미수신`으로 표시하며 성공 처리하지 않음.
- 기존 진행 요약/공개 reasoning은 별도 유지.

## 3. 변경 단위와 반영 위치

### Core

| 파일 | 역할 |
|---|---|
| `core/src/agent/tool-activity.ts` (신규) | ToolActivity schema, 표시 전 마스킹, 행별 버퍼/최신 스냅샷, throttling, 종료 상태 |
| `core/src/agent/run-verification-async.ts` (신규) | 테스트/진단 실행의 비동기 출력 콜백; pytest 후보 argv 실행 유지 |
| `core/src/agent/run-terminal.ts` | stdout/stderr 발생 시 onOutput 전달, UTF-8 스트림 디코딩 |
| `core/src/agent/agent-tool-execute.ts` | 실제 도구 실행 전/후 observer; 셸/테스트/진단 출력 연결 |
| `core/src/agent/agent-tool-types.ts` | onToolActivity/onOutput context 타입 |
| `core/src/agent/agent-run-types.ts` | onToolActivity callback 타입 |
| `core/src/agent/agent-run-loop.ts` | run callback을 tool context에 전달 |
| `core/src/chat/modes/workspace-agent.ts` | 최근 40개 스냅샷 수집, SSE callback 및 최종 응답 연결 |
| `core/src/chat/chat-orchestrator.ts` | tool_activity SSE와 세션 pending 수집 연결 |
| `core/src/chat/assistant-reply.ts` | assistant 응답 저장 옵션 추가 |
| `core/src/sessions/types.ts` | optional tool_activity 필드 |
| `core/src/sessions/session-store.ts` | 세션별 pending Map, assistant append 시 영속화, 새 turn 시작 시 초기화 |

### 프런트엔드 — 다음 심볼/모듈 변경을 함께 반영

- `ToolActivityLog.tsx` 신규 컴포넌트.
- `ToolActivity` 및 assistant turn의 `toolActivity` 타입.
- API 클라이언트 `streamChat`: `tool_activity` SSE 수신과 onToolActivity callback; 메시지의 tool_activity 타입.
- 상태 저장소: 실행 job의 assistant turn에 id별 스냅샷 갱신; 저장 메시지의 tool_activity 복원.
- 기존 assistant message renderer: 해당 turn 로그가 있을 때 ToolActivityLog 렌더링; 현재 실행 turn에만 live 부여.

Core만 또는 UI만 부분 반영하지 말고 타입·전달·저장·렌더링을 함께 반영한다. 기존 세션에는 필드가 없어도 정상 동작한다.

## 4. 데이터·성능·보안 계약

SSE payload: `{ type: 'tool_activity', activity: ToolActivity }`.

ToolActivity: id, tool, target, state(running/success/failed/cancelled), startedAt, updatedAt, finishedAt?, lastOutputAt?, output, truncated, exitCode?.

- 행당 최근 12,000자, turn당 최근 40개 작업, 대상 최대 600자.
- 중간 출력 발행은 약 120ms로 묶음. 시작/종료는 즉시 발행.
- SSE는 델타가 아닌 bounded 스냅샷. 같은 id의 중복 수신이 출력 누적을 만들지 않음.
- 줄 단위 버퍼링으로 프로세스 chunk 사이에 분리된 주요 secret의 조기 노출 방지. 4,096자를 넘는 줄은 생략.
- 주요 환경 secret 값, token/password/API key 형태, Bearer/Basic, 일반 키 접두사, URL credential 및 PEM private key를 표시 전에 마스킹.
- 마스킹은 주요 패턴 방어이지 임의의 모든 민감정보 탐지 보장은 아님. 민감한 개인정보/업무내용을 출력하는 명령 사용 시 주의 필요.
- 개행 없는 진행 출력은 줄 완료 또는 도구 종료까지 보류할 수 있음. 그동안 시간/출력 시각은 표시.
- 저장은 최종 assistant append 경계에서 수행. 프로세스 강제 종료 이전의 미완료 로그를 실시간 디스크 저널로 복구하는 기능은 아님.
- 일반 읽기/검색/수정 도구는 대상과 lifecycle만 표시하고 원본 결과 전문을 추가 복제하지 않음.

## 5. 실제 검증 결과

| 검증 | 결과 |
|---|---|
| Core TypeScript 컴파일 및 별도 noEmit 진단 | PASS |
| Workspace UI TypeScript + production build | PASS (번들 500kB 초과 경고 있음) |
| `node tools/verify-tool-activity.mjs` | 9 checks PASS |
| `node tools/verify-tool-activity-ui.mjs` | 2 browser acceptance groups PASS |

### 백엔드 9개 checks

1. chunk 분리 secret, 환경 secret, Bearer, 합성 PEM, stderr 마스킹.
2. bounded 출력, 발행 횟수 제한, 비정상 종료 코드.
3. 실제 run_terminal 출력이 종료 전에 도착.
4. 실제 run_tests 출력이 종료 전에 도착.
5. 실제 run_diagnostics 출력이 종료 전에 도착.
6. 취소/timeout/job 정리 및 기존 위험 명령 차단.
7. 실제 exit 7 실패 상태.
8. npm test 자동 탐지.
9. 디스크 재로드, 세션 분리, 40행 제한, 실패 응답 저장, 다음 turn으로 로그 누수 없음.

### 브라우저 2개 groups

1. 실제 PowerShell → 격리 HTTP SSE → production streamChat parser → production ToolActivityLog: 완료 전 출력, 접기/펼치기, 무출력 시계 갱신, 마스킹, stderr, 종료 코드, 스냅샷 중복 방지.
2. 실패/취소/연결 종료 표시, 생략 안내, 완료 시간 고정, 빈 상태, 375px 화면 가로 넘침 없음.

브라우저 검증은 임의의 로컬 빈 포트에 띄운 격리 Vite harness에서 실행했다. 사용자 메인앱 API/모델을 호출한 전체 앱 E2E는 아니며, 실제 셸·제품 SSE 파서·제품 로그 컴포넌트를 사용했다. 실패/취소 등 보조 표시 조합은 명시적 fixture이다. 테스트 서버·브라우저·임시 폴더는 finally에서 정리한다.

## 6. 재검증 및 릴리스 반영

CQR_PA 루트에서 Core를 먼저 `npx tsc -p tsconfig.json`으로 컴파일하고 다음을 실행한다.

```text
node tools/verify-tool-activity.mjs
node tools/verify-tool-activity-ui.mjs
```

기존 React Workspace 패키지에서 `npm run build`로 UI 타입 검사 및 production build를 수행한다. UI acceptance에는 설치된 Vite/Tailwind/Playwright Chromium이 필요하며 신규 서비스 credential은 필요 없다.

이 명세의 구현 단위를 메인앱 반영 과정에서 함께 빌드/패키징한다. 이 작업에서는 publish, 배포 실행파일 덮어쓰기, 실행 중 메인앱 재시작, git commit/push를 수행하지 않았다.
