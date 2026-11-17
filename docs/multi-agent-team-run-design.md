# 다중 에이전트 팀 실행 설계 (초안)

- 상태: 초안. 단계 0, 0-2, 0-3(변경 거부 버그)과 0-4(에이전트 도구 `workspace_rollback` 보완)만 코드로 고쳤다(2.7, 2.10, 2.12, 2.16). **되돌리기는 에이전트 도구에 맡기는 것으로 확정했다(2.16).** 팀 실행 자체는 코드가 없다. 실행으로 확인한 것은 변경 거부 쪽뿐이고, 실행 루프를 거친 확인은 2.13, HTTP 라우트와 모델 대신 승인 경로를 거친 확인은 2.14다. **변경 검토 창은 지금 화면에 연결돼 있지 않다(2.14).** 그래서 화면을 거친 확인은 없고, 2.6·2.9·2.11에서 "지금 제품에 있는 손실"이라고 적은 것은 화면에서는 일어나지 않는다.
- 작성 기준: 2026-11-17 코드 읽기 결과.
- 2차 갱신: `sessionId` 사용처 조사(2.2), 보이는 브라우저 점유 판정, 사용량 저장소 열 구성을 읽고 3.5와 5를 고쳤다. 여전히 실행으로 검증한 것은 없다.
- 3차 갱신: 사용량 집계, 되돌리기·취소 라우트, 승인 자동 검토, 메시지 고정·턴 문맥·작업 장부를 읽고 2.3을 추가했다. 2.1 비용의 결론과 3.5의 비용·되돌리기 항목을 고쳤다. 여전히 실행으로 검증한 것은 없다.
- 4차 갱신: 승인 요청 `id` 생성, 되돌리기 지점 `id` 전달 경로, 완료 이벤트, 사용량 화면의 용도 표시, 작업 장부 쓰기 호출부를 읽고 2.4를 추가했다. 3.5의 되돌리기·비용 항목과 3.7을 고쳤다. 디렉터리 검색이 일부 줄을 놓친다는 것을 확인해, "찾지 못했다"고 적은 항목을 전체 파일 대조로 다시 확인했다(2.4). 여전히 실행으로 검증한 것은 없다.
- 5차 갱신: 되돌리기 지점 내부(`agent-checkpoint.ts`), `lastPerf`를 적는 쪽, 승인 대기 시간의 서버·화면 처리를 읽고 2.5를 추가했다. 3.5의 되돌리기·결과 합치기 항목과 3.7의 승인 항목을 고쳤다. 여전히 실행으로 검증한 것은 없다.
- 6차 갱신: 변경 거부의 삭제 동작을 함수 수준에서 실행해 재현했다(2.6). 이 문서에서 실행으로 확인한 것은 이 항목 하나다. `lastPerf`를 읽는 곳과 `AgentPerfSnapshot` 타입, 승인 대기 시간이 걸음 수·경과 시간 검토에 잡히는 방식을 읽고 3.5, 3.7, 4, 5를 고쳤다.
- 7차 갱신: 단계 0을 고쳤다. 지점에 파일을 더 넣는 함수를 만들고, 되돌리기가 "그때 없던 경로"로 기록된 것만 지우게 했다. 2.7을 추가하고 3.5, 4, 5를 고쳤다.
- 8차 갱신: 걸음 수·시간 검토의 실제 값, 걸음 수 상한에서 끝날 때의 실행 결과 모양, 변경 파일 목록에 들어가는 도구, 변경 검토 창의 미리보기 처리를 읽고 2.8을 추가했다. 3.5, 3.7, 5를 고쳤다. 코드 변경과 실행 확인은 없다.
- 9차 갱신: `rename_file` 뒤 변경 거부로 파일이 사라지는 것을 함수 수준에서 재현했다(2.9).
- 10차 갱신: 단계 0-2를 고쳤다. `rename_file`과 `apply_patch` 이동이 옛 경로와 새 경로를 변경 파일 목록과 지점 대상에 넣는다(2.10).
- 11차 갱신: 실패한 이름 바꾸기의 성공 판정, 변경 검토 창이 이름 바꾸기의 두 경로를 그리는 방식, 폴더 이름 바꾸기, `apply_patch`가 도중에 실패한 경우를 읽고, 부분 거부와 폴더 이름 바꾸기를 함수 수준에서 실행했다(2.11). 3.5, 4, 5를 고쳤다. 코드 변경은 없다.
- 12차 갱신: 단계 0-3을 고쳤다. 이름 바꾸기·이동의 두 경로를 지점에 쌍으로 적고, 되돌리기가 한쪽을 받으면 다른 쪽도 함께 처리한다(2.12). 3.5, 4, 5를 고쳤다. 확인은 함수 수준 검사와 타입 검사까지다.
- 13차 갱신: 단계 0, 0-2, 0-3을 실제 실행 루프(`runCodeAgent`)를 거쳐 확인했다(2.13). 가짜 모델 서버가 도구 호출을 내보내고, 실행 결과의 지점 `id`와 변경 파일 목록으로 되돌리기를 불렀다. 검사 `tools/verify-mutate-reject-e2e.mjs`를 추가했다. 제품 코드는 고치지 않았다.
- 14차 갱신: 화면 쪽을 전체 파일 대조로 읽어 변경 검토 창이 연결돼 있지 않다는 것을 확인했다. HTTP 라우트와 모델 대신 승인 경로를 검사에 넣어 실행했다(2.14). 이전 차수의 "변경 검토 창에서 …" 서술은 구성 요소 파일만 읽고 적은 것이어서 2.14로 바로잡는다. 4, 5를 고쳤다. 제품 코드는 고치지 않았다.
- 15차 갱신: 변경 검토 창이 빠진 경위를 git 기록과 룰북으로 읽었다(2.15). 창을 띄우지 않는 것은 기록된 설계 결정이고(ADR-RE-002 규칙 3), 창을 여는 코드는 첫 공개 커밋부터 저장소 파일에 없었다. 5, 6을 고쳤다. 코드 변경과 실행 확인은 없다.
- 16차 갱신: 되돌리기를 에이전트 도구에 맡기는 안으로 확정했다. 단계 0-4로 `workspace_rollback`을 고쳤고(새로 생긴 파일 삭제, 경로 지정, 지점 목록 안내), 12차의 화면 코드 수정 중 짝 줄 처리를 되돌렸다(2.16). 3.5, 3.7, 4, 5, 6을 고쳤다. 확인은 실행 루프로 만든 지점에 도구 실행 함수를 직접 부른 것까지다.
- 17차 갱신: 7차에 넣은 화면 코드(`skipped_paths` 상태 글)도 되돌렸다. 이제 화면 파일 두 개(`myAgentClient.ts`, `workspaceStore.ts`)는 이 작업 전과 같다. 2.7, 2.16, 6을 고쳤다.
- 목표: 한 프로젝트 작업 하나에 에이전트 여러 개가 동시에 붙어 같이 진행한다. 지금처럼 한 에이전트가 단계를 순서대로 밟는 구조를 대체하는 선택 모드다.

## 1. 범위

### 하는 것
- 요청 하나 아래에서 조율 에이전트 1개와 작업 에이전트 여러 개가 동시에 돈다.
- 진행은 단계 순서가 아니라 공유 작업판의 상태가 결정한다.
- 작업 항목마다 모델을 다르게 배정할 수 있다.
- 시작점은 플랜 모드에 묶이지 않는다. 작업판에 항목이 들어오는 경로는 플랜 결과, 사용자 입력, 작업 중 추가 모두 같다.

### 하지 않는 것 (첫 버전)
- 작업 에이전트별 git worktree 격리.
- 프로세스가 죽은 뒤의 자동 복구. 중단되면 작업판의 상태에서 다시 시작한다.
- 사용자가 대화를 여러 개 열어 나눠 갖는 방식.

### 참고한 외부 설계
- `oh-my-openagent`: 의존 그래프 실행, 카테고리 기반 모델 배분, 실패 시 후속 항목만 건너뛰기, 조율자만 합치기. 라이선스가 Sustainable Use License라 코드는 옮기지 않고 설계만 참고한다.
- `openai/symphony`: 작업별 폴더 격리 개념. Apache 2.0.

## 2. 현재 구조에서 확인된 사실

### 그대로 쓸 수 있는 것
| 항목 | 근거 |
|---|---|
| 작업 에이전트 하나는 `runCodeAgent` 한 번으로 만들 수 있다. 모델, 작업 폴더, 중단 신호, 승인 콜백, 진행 콜백을 호출마다 따로 받는다. | `core/src/agent/agent-run-types.ts` |
| `runCodeAgent` 호출부는 `runMarOrCodeAgent` 한 곳이고, `runMarOrCodeAgent` 호출부도 한 곳이다. | `core/src/agent/agent-mar-runtime.ts:10`, `core/src/chat/modes/workspace-agent.ts`의 `runMarOrCodeAgent` 호출 |
| 대화 기록 저장(`appendAssistantReply`)은 실행 루프 밖, 호출부에서 한다. 작업 에이전트를 `runCodeAgent`로 직접 띄우면 대화 기록에 쓰지 않는다. | `core/src/chat/modes/workspace-agent.ts` |
| 실행은 `AsyncLocalStorage`로 묶여 있어, 부모 실행 안에서 띄운 작업 에이전트는 사용자 중지 시 함께 멈춘다. | `core/src/chat/chat-runs.ts` |
| 세션당 실행 1개 제한은 HTTP 진입점에서만 걸린다. 팀 실행을 그 실행 하나의 내부에서 돌리면 제한을 건드리지 않는다. | `core/src/routes/dispatch.ts:3376` `beginChatRun` |
| 모델 대화 상태는 `lane` 인자로 분리 저장된다. | `responsesStateFactory` |
| 다중 역할용 필드(`AgentRoleContribution`, `parentRunId`, `agentId`)가 남아 있다. `AgentRoleContribution`은 이 파일 안에서만 쓰인다. `parentRunId`는 감사 기록 이벤트와 훅 타입(`role_start`, `role_end`, `handoff`)에도 있다(4차에서 정정). | `core/src/agent/agent-run-meta.ts`, `agent-audit-ledger.ts:57`, `agent-hooks.ts:50-52` |
| `agent-mar-runtime.ts`는 단일 루프를 그대로 통과시키는 짧은 파일이다. | `core/src/agent/agent-mar-runtime.ts` |

### 그대로 쓰면 깨지는 것
| 문제 | 근거 | 조치 |
|---|---|---|
| 실행 메타가 세션당 JSON 파일 하나이고, 읽고 고쳐 통째로 다시 쓴다. 동시에 쓰면 서로 덮어쓴다. TODO, 증거 기록, 이어하기 스냅샷, 읽은 파일 목록이 모두 여기 있다. | `agent-run-meta.ts` `loadAgentRunMeta`/`saveAgentRunMeta` | 작업 에이전트별 메타 키 분리 |
| 실행 종료 시 `agent_{sessionId}` 접두사로 터미널 작업을 전부 취소한다. 작업 에이전트가 같은 `sessionId`를 쓰면 한 에이전트가 끝날 때 다른 에이전트의 명령이 죽는다. | `agent-run-loop.ts:1068-1073`, `run-terminal.ts:86-97` | 작업 에이전트별 내부 식별자로 해결 (2.1 참고) |
| 승인 요청에 보낸 에이전트를 담는 필드가 없다. | `core/src/agent/tool-approval.ts` | 요청에 에이전트 식별자 추가 |
| 진행 이벤트(`tool_activity`, `status`, `answer`)에 보낸 주체 구분이 없다. | `ui/workspace/src/api/myAgentClient.ts` | 이벤트에 에이전트 식별자 추가 |
| 같은 폴더 동시 수정을 막는 장치가 없다. `WorkspaceLock`은 작업 폴더를 고정하는 장치이지 동시 접근 잠금이 아니다. | `core/src/agent/agent-workspace-lock.ts` | 파일 점유 장치 신설 |
| 계획이 구조화돼 저장되지 않는다. `PLAN:` 블록을 정규식으로 잘라 넘긴다. 항목 간 의존 관계가 없다. | `core/src/sessions/plan-build-handoff.ts` | 작업판 형식 신설 |

### 2.1 추가로 읽어 확인한 것 (터미널, 브라우저, 비용, 화면)

**터미널**
- 작업 ID는 `agent_{sessionId}_{toolCallId}`다 (`agent-tool-execute.ts:879`).
- 취소는 ID가 `agent_{sessionId}`와 같거나 `agent_{sessionId}_`로 시작하는 것을 모두 잡는다 (`run-terminal.ts:86-97`).
- 따라서 작업 에이전트 식별자를 `{sessionId}__w1` 형태로 두면 코드 수정 없이 다음처럼 동작한다(코드를 읽고 추론한 것이며 실행해 보지 않았다).
  - 작업 에이전트 `w1`이 끝나면 `w1`의 명령만 취소된다. `w10`은 접두사가 달라 영향이 없다.
  - 조율 에이전트가 끝나면 모든 작업 에이전트의 명령이 함께 취소된다.
- 화면의 명령 취소 버튼은 `cancelSessionId`와 행 `id`를 보낸다 (`ToolActivityLog.tsx:109`). 작업 에이전트의 명령을 취소하려면 이 값에 내부 식별자가 실려야 한다.

**브라우저**
- 격리 브라우저(Playwright)는 실행 루프 안의 지역 변수로, 실행마다 따로 뜬다 (`agent-run-loop.ts:375-387`). 작업 에이전트끼리 페이지가 섞이지 않는다. 대신 에이전트 수만큼 Chromium이 뜬다.
- 사용자에게 보이는 브라우저는 탭당 점유권이 하나다 (`visible-browser-bridge.ts:37`).
- 점유 주인은 `sessionId` 문자열이다. 다른 주인이 점유 중이면 `VISIBLE_BROWSER_LOCKED`로 거부하고, 점유는 시간이 지나면 만료된다 (`visible-browser-bridge.ts` `lockFor`/`assertLockedBy`). 작업 에이전트가 내부 식별자를 쓰면 조율 에이전트가 점유한 탭을 건드리지 못한다.
- 브라우저 도구는 `browserRouting`이 `background`가 아니고 보이는 브라우저가 연결돼 있으면 보이는 쪽을 고른다 (`agent-tool-execute.ts:154`). 작업 에이전트에는 `browserRouting: 'background'`를 넘겨야 격리 브라우저로 고정된다.
- 브라우저 산출물은 `data/outputs/browser/{sessionId}` 아래에 저장된다. 내부 식별자를 쓰면 폴더가 갈린다.

**비용**
- 사용량 기록의 문맥은 `sessionId`, `turnId`, `runId`, `purpose`를 갖고 `AsyncLocalStorage`로 전달된다. 안쪽 문맥은 바깥 값을 물려받는다 (`llm-usage-log.ts:15-51`).
- 에이전트를 구분하는 전용 필드는 없다.
- 실행 루프가 자기 `sessionId`와 `runId`를 문맥에 덮어쓴다 (`agent-run-step-loop.ts:203-211`). 따라서 작업 에이전트의 호출은 `session_id`가 내부 식별자로, `turn_id`는 부모 것으로 기록된다.
- 저장소 열은 `session_id`, `turn_id`, `run_id`, `purpose`, `model` 등이고 `session_id`와 `turn_id`에 색인이 있다 (`llm-usage-store.ts:63-87`).
- 결과(3차에서 정정): 에이전트별 구분은 `session_id`로 되지만, 질문 단위 합계와 대화 단위 합계 양쪽에서 모두 빠진다. 집계가 질문을 `session_id`와 `turn_id`를 합친 키로 묶기 때문이다. 자세한 내용은 2.3.

**화면**
- 진행 표시는 `ToolActivityLog.tsx`가 그리고, `ChatPane.tsx:1833`에서 답변 말풍선마다 하나씩 붙는다.
- 응답 글과 도구 실행을 시간순 한 줄로 늘어놓고 `activityGroupId`로 묶는다 (`ToolActivityLog.tsx:49-83`). 에이전트별로 나누는 구조는 없다.
- 화면은 `runId`가 요청의 것과 다른 이벤트를 버린다 (`myAgentClient.ts:2247`). 작업 에이전트의 이벤트는 부모의 `runId`로 내보내야 표시된다.
- 승인 창은 한 번에 하나만 뜨고 나머지는 온 순서대로 대기한다 (`confirmDialog.ts:70-99`). 작업 에이전트 여러 개의 승인 요청은 쌓이지만 하나씩 처리된다.

### 2.2 내부 식별자를 `sessionId`로 넘겼을 때의 영향

조사 범위: `core/src/agent` 안에서 `opts.sessionId`와 도구 문맥의 `ctx.sessionId`를 쓰는 곳. 검색 결과 목록을 보고 핵심 지점만 읽었다. `core/src/agent` 밖(세션 저장소, 라우트)은 호출부 한 곳과 취소 라우트 한 줄만 봤다.

**문제없이 갈리는 것** (작업 에이전트마다 따로 생겨도 되는 것)
| 대상 | 저장 위치·키 | 근거 |
|---|---|---|
| 실행 메타 (TODO, 진행 중 작업, 읽은 파일, 이어하기 스냅샷) | `data/agent-run-meta/{키}.json` | `agent-run-meta.ts:90-100` |
| 증거 기록 | `sessionId`별 폴더 | `agent-evidence-store.ts:85` |
| 터미널 작업 ID, 도구 실행 취소 | `agent_{sessionId}_{toolCallId}`, 취소는 `sessionId` 일치 확인 | `agent-tool-execute.ts:879`, `tool-execution-cancel.ts` |
| 감사 기록 | 이벤트의 `sessionId` 필드 | `agent-audit-ledger.ts` |
| 모델 대화 상태 | 호출부가 만든 `responsesStateFactory`가 진짜 `sessionId`와 `lane`으로 저장 | `chat/modes/workspace-agent.ts` |

- 파일 이름 키는 영숫자·`_`·`-`만 남기고 64자에서 자른다. `__w1` 형태는 그대로 보존된다. 식별자가 64자를 넘으면 잘려서 서로 겹칠 수 있다.
- 화면의 명령 취소는 행에 실린 `cancelSessionId`를 그대로 보낸다. 이 값은 도구 문맥의 `sessionId`에서 오므로 (`agent-tool-execute.ts:279-283`) 내부 식별자가 자동으로 실린다. 취소 라우트는 받은 `session_id`를 그대로 넘긴다 (`dispatch.ts:1234`). 그 앞의 검증 코드는 읽지 않았다.

**조치가 필요한 것**
| 문제 | 근거 | 조치 |
|---|---|---|
| 고정 제약(사용자가 건 "건드리지 마" 류)이 `data/agent-constraints/{sessionId}.json`에서 읽힌다. 내부 식별자로는 부모의 제약을 못 읽는다. | `agent-locked-constraints.ts:69-90`, `agent-run-loop.ts:367-373` | 팀 실행기가 부모의 제약을 읽어 작업 에이전트의 `extraSystemNotes`로 넘긴다. |
| 되돌리기 지점이 `data/agent-checkpoints/{sessionKey}` 아래에 쌓인다. 작업 에이전트가 만든 지점은 대화의 되돌리기 목록과 다른 폴더에 들어간다. | `agent-checkpoint.ts:72-73`, `agent-run-step-loop.ts:1143-1151` | 팀 실행기가 팀 지점 하나를 소유한다 (2.4, 3.5). 2차의 조치안은 폐기했다. |
| 같은 내부 식별자를 다음 팀 실행에서 다시 쓰면 이전 실행의 메타(TODO, 이어하기 스냅샷, 읽은 파일)를 물려받는다. | `agent-run-meta.ts:294-305` (파일이 있으면 그대로 읽음) | 식별자에 팀 실행 구분값을 넣는다 (3.5). 끝난 뒤 메타 파일을 지운다. |
| `memory_propose`가 `source_session_id`와 세션 범위 메모리에 내부 식별자를 적는다. | `agent-tool-execute.ts:524-545` | 작업 에이전트 도구 목록에서 뺀다. |
| `scheduler_upsert`가 `sessionId`로 작업 폴더를 찾는다. 내부 식별자로는 못 찾고 현재 작업 폴더로 넘어간다. | `agent-tool-execute.ts:377-386` | 작업 에이전트 도구 목록에서 뺀다. |
| `conversation_image_get`, `save_web_asset`, 디버그 로그가 `sessionId`로 저장 위치를 정한다. 작업 에이전트는 대화에 첨부된 이미지를 못 찾을 것으로 보인다(해당 함수 안은 읽지 않았다). | `agent-tool-execute.ts:1239-1275`, `agent-debug-ingest.ts:46-48` | 필요한 이미지는 조율 에이전트가 항목 `prompt`에 경로로 넘긴다. 작업 에이전트는 디버그 모드로 띄우지 않는다. |
| 질문 단위·대화 단위 사용량 합계에서 작업 에이전트 비용이 빠지고, 제목 없는 별도 행으로 나온다. | 2.3 사용량 | 사용량 문맥에는 부모 `sessionId`를 쓰게 한다 (3.5). |

**부모 것을 그대로 쓰는 것** (내부 식별자와 무관)
- 쓰기 가능 여부 확인과 도구 추적은 `AsyncLocalStorage`의 채팅 실행을 본다 (`agent-tool-execute.ts:275, 285`). 부모 실행 안에서 띄우면 부모 것을 쓴다.
- 승인 요청에는 `sessionId`가 들어가지 않는다 (`agent-run-step-loop.ts:921-934`). 팀 실행기가 넘긴 콜백이 그대로 불린다.

### 2.3 3차 확인 (사용량 집계, 되돌리기·취소, 승인 자동 검토, 그 밖의 `sessionId` 저장소)

**사용량 집계**
- 집계는 호출 한 줄마다 대화 묶음(`session_id` 키)과 질문 묶음(`session_id`와 `turn_id`를 합친 키) 양쪽에 더한다 (`llm-usage-summary.ts:452-481`).
- 대화 제목과 질문 글은 대화 저장소에서 `session_id`로 찾아 붙인다 (`dispatch.ts:487-504`). 내부 식별자는 대화 저장소에 없으므로 제목과 질문이 비게 된다(대화 저장소의 조회 함수 안은 읽지 않았다).
- 따라서 작업 에이전트의 호출을 내부 식별자로 기록하면 다음처럼 된다.
  - 전체 합계, 모델별·용도별 합계에는 들어간다.
  - 질문 목록에는 부모 질문과 별개인 제목 없는 행이 작업 에이전트마다 하나씩 생긴다. 부모 질문 행의 비용에는 합쳐지지 않는다.
  - 대화 목록에도 제목 없는 행이 작업 에이전트마다 하나씩 생긴다.
- 2차 문서의 "질문 단위 합계에는 들어간다"는 틀렸다. 질문 키에 `session_id`가 들어간다.

**되돌리기 라우트**
- `/workspace/checkpoint/rollback`과 `/workspace/checkpoint/preview`는 받은 `session_id`를 검증 없이 되돌리기 폴더 키로 쓴다 (`dispatch.ts:1300-1375`, `agent-checkpoint.ts:217-218`).
- 화면은 대화의 `sessionId`를 보낸다 (`myAgentClient.ts:2450-2478`). 작업 에이전트가 내부 식별자로 만든 지점은 그 폴더에 없어서 `checkpoint not found`가 된다.
- 되돌리기 지점 목록을 돌려주는 HTTP 라우트는 없다. 5차에서 전체 파일 대조로 다시 확인했다(2.5). `listWorkspaceCheckpoints`를 쓰는 곳은 도구 실행부와 정리 코드뿐이다.
- 모델이 대신 승인한 수정 직전에도 `opts.sessionId` 키로 지점을 만들고, 키마다 20개만 남긴다 (`agent-run-step-loop.ts:1136-1151`).
- 시작 시 정리는 폴더마다 7일·5개 기준으로 지운다 (`agent-checkpoint.ts:482-492`). 작업 에이전트 폴더도 별개 폴더로 정리된다.

**취소 라우트**
- 도구 실행 취소(`/fs/tool-execution/cancel`)는 등록할 때의 `sessionId`와 받은 값이 정확히 같아야 한다 (`tool-execution-cancel.ts:19-27`). 화면 행이 내부 식별자를 실어 보내면 맞는다.
- 터미널 취소(`/fs/run-terminal/cancel`)는 `session_id` 접두사로 잡는다 (`dispatch.ts:1238-1259`). 화면이 대화의 `sessionId`로 보내면 작업 에이전트의 명령도 함께 취소된다.
- 두 라우트 모두 `session_id`가 실제 대화인지 확인하지 않는다.

**승인 자동 검토**
- 자동 검토는 실행 루프 안이 아니라 호출부의 승인 콜백 안에서 부른다 (`chat-orchestrator.ts:1126-1166`). 콜백이 대화의 `sessionId`, 사용자의 원래 메시지, 직전 답변을 직접 쥐고 있다.
- 작업 에이전트에 이 콜백을 그대로 넘기면 정책 판정(Autopilot, 나 대신 승인, 승인 카드 선별)이 지금과 같게 적용된다.
- 판단 모델은 작업 에이전트의 요청을 항목의 `prompt`가 아니라 사용자의 원래 메시지와 대조한다. 조율 에이전트가 사용자가 말하지 않은 일을 항목으로 만들면 판단 모델이 보류할 수 있다.
- 검토 호출의 사용량은 대화의 `sessionId`와 `purpose: 'approval'`로 기록된다 (`approval-auto-review.ts:686-687`).
- 승인 대기는 요청 `id`로 묶인다 (`chat-orchestrator.ts:1177`). `id`는 요청마다 `randomUUID()`로 만들므로 작업 에이전트끼리 겹치지 않는다 (2.4).

**메시지 고정**
- 실행 루프가 메시지를 만들 때 `opts.userMessage`에서 고정할 사실을 뽑아 `opts.sessionId`의 실행 메타에 적는다 (`agent-run-helpers.ts:162`, `agent-run-meta.ts:526-541`). 읽고 고쳐 다시 쓰는 방식이다.
- 작업 에이전트는 자기 메타에 적으므로 부모 메타와 덮어쓰기 충돌이 없다.
- 부모 대화에 쌓인 고정 사실은 작업 에이전트가 못 읽는다. 고정 제약과 같은 문제다.

**턴 문맥 기록**
- `data/agent-turn-context/{sessionId}.json`에 저장한다. 캐시 적중을 위한 최적화이고 실패해도 무시한다 (`agent-turn-context-store.ts`).
- 작업 에이전트마다 파일이 하나씩 생긴다. 동작에는 영향이 없고, 정리 대상에 넣어야 한다.

**작업 장부**
- 실행 루프는 장부 전체를 읽어 주제 목록을 만든다. 같은 대화이면 2점, 같은 작업 폴더이면 1점을 더한다 (`task-ledger.ts:124-143`, `agent-run-loop.ts:654-658`).
- 작업 에이전트는 같은 대화 점수만 못 받고, 같은 작업 폴더의 기록은 그대로 본다. 읽기 전용이라 충돌이 없다.
- 장부에 기록을 쓰는 함수(`upsertTaskLedgerRecord`)는 `core/src`와 `ui/workspace/src`의 `.ts`·`.tsx` 어디에서도 호출되지 않는다 (2.4). 작업 에이전트 실행이 장부 카드를 만들지 않는다.

### 2.4 4차 확인 (승인 `id`, 되돌리기 지점 전달, 완료 이벤트, 사용량 화면, 작업 장부, 검색 신뢰도)

**검색 신뢰도**
- 이 환경에는 `rg`가 없어 디렉터리 검색이 색인 기반으로 돌고, 일부 줄을 놓친다. 예: `createToolApprovalId`의 정의(`tool-approval.ts:317`)와 `upsertTaskLedgerRecord`의 정의(`task-ledger.ts:75`)가 디렉터리 검색에 나오지 않았다.
- 그래서 `core/src`와 `ui/workspace/src`의 `.ts`·`.tsx` 전체를 `Select-String`으로 다시 대조했다. 결과:
  - `subagent`, `delegate_task`, `spawn_agent`: 0건. "하위 에이전트·위임 도구가 없다"는 유지된다.
  - `runCodeAgent(` 호출은 `agent-mar-runtime.ts:10` 한 곳, `runMarOrCodeAgent(` 호출은 `chat/modes/workspace-agent.ts:418` 한 곳. 유지된다. (`code-agent.ts`가 이름을 다시 내보낸다.)
  - `upsertTaskLedgerRecord`: 정의 한 줄뿐. 호출부 없음.
  - `parentRunId`: `agent-run-meta.ts` 밖에 `agent-audit-ledger.ts`, `agent-hooks.ts`에도 있다. 2절의 표를 고쳤다.
- 이전 차수에서 디렉터리 검색만으로 "없다"고 적은 다른 항목(예: 되돌리기 지점 목록 라우트)은 이 방식으로 다시 확인하지 않았다.

**승인 요청 `id`**
- `createToolApprovalId()`는 `randomUUID()`다 (`tool-approval.ts:317-319`). 실행 루프가 요청마다 새로 만든다 (`agent-run-step-loop.ts:904`).
- 승인 대기 맵은 프로세스 전역이고 `id`가 키다 (`tool-approval.ts:305, 322-354`). 작업 에이전트 여러 개가 동시에 기다려도 섞이지 않는다.
- 승인 카드의 `session_title`은 호출부가 대화의 `sessionId`로 찾는다 (`chat-orchestrator.ts:1190`). 콜백을 그대로 넘기면 부모 대화 제목이 나온다.

**되돌리기 지점 전달**
- 자동 지점은 실행마다 첫 수정 직전에 한 번만 만든다(`autoCheckpointTaken`). 그 뒤 키마다 5개만 남긴다 (`agent-run-step-loop.ts:1182-1199`). 모델이 대신 승인한 수정 직전의 지점은 아직 보관하지 않은 대상마다 추가로 만들고 20개를 남긴다 (`agent-run-step-loop.ts:1136-1151`). 3차 문서의 "키마다 20개"는 뒤쪽 경로만 본 것이다.
- 실행 결과는 지점 `id`를 하나만 갖는다 (`agent-run-loop.ts:439`). 호출부가 이것을 `done` 이벤트의 `checkpointId`로 보낸다 (`chat-orchestrator.ts:1402-1423`).
- 화면은 `done`에서 받은 `checkpointId` 하나로 변경 검토 창의 미리보기와 되돌리기를 한다 (`myAgentClient.ts:2305-2330`, `MutateReviewPane.tsx:69-79`).
- 따라서 작업 에이전트마다 자동 지점을 따로 만들면, 키를 부모로 맞춰도 화면에는 그중 하나만 전달된다. 나머지 작업 에이전트가 바꾼 파일은 변경 검토 창에서 되돌릴 수 없다. 작업 에이전트가 6개 이상이면 5개 상한 때문에 앞선 지점이 지워진다.

**완료 이벤트**
- 호출부는 실행 결과의 `mutatedPaths`를 `workspace_mutate`와 `done`으로 보낸다 (`chat-orchestrator.ts:1396-1423`). 팀 실행기가 작업 에이전트의 변경 파일을 합쳐서 돌려주지 않으면 화면의 변경 검토 대상에서 빠진다.
- 답변에 붙는 사용량과 `lastProcessedTokens`는 대화 `sessionId`의 실행 메타 `lastPerf.usage`에서 읽는다 (`chat-orchestrator.ts:1407-1412`). 작업 에이전트는 자기 메타에 적으므로 답변 옆 사용량에는 조율 에이전트 몫만 나올 것으로 보인다(`lastPerf`를 적는 쪽은 읽지 않았다).

**사용량 화면의 용도**
- `purpose`는 `'chat' | 'approval' | 'image' | 'video' | 'embedding'` 다섯 값으로 닫힌 타입이다 (`llm-usage-log.ts:13`).
- 화면은 다섯 값에만 이름과 색을 갖고, 모르는 값은 키 글자를 그대로, 회색으로 그린다 (`SettingsUsagePage.tsx:21-38`).
- `worker:w1` 같은 값을 넣으려면 타입을 넓혀야 하고, 용도별 표에 작업 에이전트마다 영문 키 행이 하나씩 생긴다.

**작업 장부**
- `upsertTaskLedgerRecord`는 호출부가 없다. 실행 루프와 도구는 장부를 읽기만 한다 (`agent-run-loop.ts:96`, `agent-tool-execute.ts:94-99, 592-606`).
- `.mjs` 도구나 테스트에서 쓰는지는 보지 않았다.

### 2.5 5차 확인 (되돌리기 지점 내부, `lastPerf`, 승인 대기 시간)

**되돌리기 지점 내부**
- `createWorkspaceCheckpoint`는 부를 때마다 새 `id`와 새 폴더를 만든다 (`agent-checkpoint.ts:118`). 이미 만든 지점에 파일을 더 넣는 함수는 이 파일에 없다. 호출부는 세 곳이다: 자동 지점, 모델이 대신 승인하기 전의 지점, `workspace_checkpoint` 도구.
- 자동 지점에 들어가는 파일은 그 실행의 첫 수정 도구 호출이 가리킨 경로뿐이다. 경로를 못 뽑았을 때만 그때까지 읽은 파일을 넣는다. 최대 40개다 (`agent-run-helpers.ts:505-535`).
- 2MB를 넘는 파일은 보관하지 않고 조용히 건너뛴다 (`agent-checkpoint.ts`의 `MAX_FILE_BYTES`, `copyRel`).
- 되돌리기(`rollbackWorkspaceCheckpoint`)는 경로 목록을 받으면 지점에 있는 경로는 복원하고, 지점에 없는 경로는 "이번 수정으로 새로 생긴 파일"로 보고 지운다. 화면의 변경 거부는 항상 변경 파일 목록을 보낸다 (`workspaceStore.ts`의 `rejectMutateReview`).
- 따라서 지점에 안 들어간 기존 파일은 "되돌릴 수 없다"가 아니라 "변경 거부 시 지워진다"가 된다. 4차 문서(2.4)의 "되돌릴 수 없다"는 약하게 적은 것이다. 팀 지점에 파일 보관이 빠지면 그 파일이 지워질 수 있다.
- 지금의 단일 에이전트 실행에도 같은 위험이 있어 보인다. 자동 지점은 첫 수정 호출의 경로만 담으므로, 같은 실행에서 나중에 고친 기존 파일은 지점에 없다. 모델이 대신 승인한 경우에는 새 대상마다 지점을 새로 만들고 화면에 가는 `id`가 마지막 지점으로 바뀌어, 앞선 파일이 그 지점에 없다. 코드를 읽고 추론한 것이며 재현하지 않았다. 팀 실행과 별개로 재현 테스트가 필요하다.
- 지점 폴더의 `meta.json`은 통째로 쓴다. 파일 추가 함수를 만들면 팀 실행기 한 곳에서만 불러야 한다.
- 전체 파일 대조 결과 `/workspace/checkpoint/` 라우트는 `rollback`과 `preview` 둘뿐이다. 목록 라우트는 없다.

**`lastPerf`**
- 실행 루프의 종료 처리(`finish`)가 `recordSessionPerf(opts.cqrRoot, opts.sessionId, perf)`로 적는다 (`agent-run-loop.ts:490`). 그 실행 한 번의 사용량이고, 이전 값에 더하지 않고 바꿔 쓴다 (`agent-run-meta.ts:360-374`).
- 오류로 끝나면 종료 처리를 건너뛰므로, 사용량을 오류 객체에 붙여 넘긴다 (`agent-usage-carry.ts`).
- 호출부는 실행이 끝난 뒤 대화 `sessionId`의 `lastPerf.usage`를 읽어 답변에 붙인다 (`chat-orchestrator.ts:1321, 1407`).
- 따라서 작업 에이전트의 사용량은 각자의 메타에 적히고, 답변 옆에는 조율 에이전트 몫만 나온다. 4차의 추정이 맞다.
- `lastPerf.cost`는 모델 하나를 기준으로 계산한다 (`agent-run-loop.ts`의 `calculateLlmUsageCost(finalUsage, finalModelId, ...)`). 모델이 섞인 팀 실행의 토큰을 합쳐 한 모델로 다시 계산하면 비용이 틀린다. `cost`를 어디에 보여주는지는 읽지 않았다.

**승인 대기 시간**
- 서버 타이머는 승인 이벤트를 보내기 직전, `waitForToolApproval`을 부를 때 시작한다 (`chat-orchestrator.ts:1176-1177`, `tool-approval.ts:321-354`).
- 화면은 승인 이벤트를 처리할 때 자체 타이머를 건다. 시간은 서버 값보다 2초 짧다. 창이 떠 있든 대기 중이든 상관없이 시간이 되면 창을 거두고 거절로 답한다 (`myAgentClient.ts:2353-2385`, `confirmDialog.ts`의 `withdraw`). 대기 중인 요청이 사용자가 보기 전에 거절된다는 4차의 추정이 화면 코드로도 확인됐다.
- 화면은 스트림을 읽는 반복문 안에서 승인 답을 기다린다 (`myAgentClient.ts:2236-2385`). 승인 창이 떠 있는 동안 같은 스트림의 뒤 이벤트를 처리하지 않는다. 팀 실행에서는 다음 두 가지가 생긴다.
  - 한 작업 에이전트의 승인 창이 떠 있는 동안 다른 작업 에이전트의 진행 표시가 멈춘다.
  - 두 번째 승인 요청은 첫 번째에 답한 뒤에야 화면에 들어온다. 그동안 서버 타이머는 이미 돌고 있어서, 화면에 떴을 때는 서버가 이미 거절한 뒤일 수 있다. 이 경우 화면은 서버의 404를 보고 "승인 대기 시간이 지나 거절됨"으로 표시한다.

### 2.6 6차 확인 (변경 거부 재현, `lastPerf` 읽는 곳, 승인 대기와 시간 검토)

**변경 거부가 기존 파일을 지운다 (함수 수준 재현)**
- 방법: 임시 폴더에서 `core/dist/agent/agent-checkpoint.js`의 `createWorkspaceCheckpoint`와 `rollbackWorkspaceCheckpoint`를 직접 불렀다. 실행 루프와 화면은 거치지 않았다. 임시 폴더는 실행 뒤 지웠고 저장소에는 파일을 남기지 않았다.
- 경우 1 (자동 지점에 첫 수정 대상만 있음): 기존 파일 `a.ts`, `b.ts`. 지점에 `a.ts`만 보관. 둘 다 고치고 새 파일 하나를 만든 뒤 세 경로로 되돌리기. 결과: `a.ts` 복원, **기존 파일 `b.ts` 삭제**, 새 파일 삭제.
- 경우 2 (모델이 대신 승인, 대상마다 지점): 지점 1에 `a.ts`, 지점 2에 `b.ts`. 마지막 지점 `id`와 두 경로로 되돌리기. 결과: `b.ts` 복원, **기존 파일 `a.ts` 삭제**.
- 경우 3 (2MB 초과): 3MB 기존 파일을 지점에 요청하면 `fileCount`가 0이다. 고친 뒤 되돌리기. 결과: **그 파일 삭제**.
- 세 경우의 입력은 실행 루프와 화면이 실제로 만드는 값과 같은 모양이다. 자동 지점은 첫 수정 호출의 경로만 담고(`agent-run-step-loop.ts:1182-1199`, `agent-run-helpers.ts:505-535`), 화면에는 마지막 지점 `id`가 가고(`agent-run-loop.ts:439`), 변경 거부는 변경 파일 전체를 보낸다(`workspaceStore.ts:2164-2190`). 다만 제품을 띄워 끝에서 끝까지 재현하지는 않았다.
- 기존 검사(`tools/verify-parity-p1.mjs:206-245`)는 "지점에 없는 새 파일이 지워진다"만 확인한다. 지점에 없는 기존 파일의 경우는 검사하지 않는다.
- 팀 실행과 무관하게 지금 제품의 데이터 손실 버그다. 고치려면 파일마다 첫 수정 직전에 같은 지점에 보관하는 기능이 필요하고, 이것은 팀 지점에 필요한 기능(3.5)과 같다. 지점 `meta.json`에 "보관을 요청했지만 그때 없던 경로"를 적어 두고, 되돌리기는 그 목록에 있는 경로만 지우게 하면 보관이 빠진 기존 파일이 지워지지 않는다.

**`lastPerf`를 읽는 곳**
- `core/src`와 `ui/workspace/src`의 `.ts`·`.tsx` 전체 대조에서 `lastPerf`를 읽는 곳은 `chat-orchestrator.ts:1321, 1407` 두 줄이고, 둘 다 `.usage`만 읽는다.
- `lastPerf.cost`를 읽는 곳은 같은 범위의 패턴 대조에서 나오지 않았다. `cost`는 실행 메타와 `data/logs/agent-perf.jsonl`에 적히기만 한다(`agent-perf-metrics.ts`의 `writePerfJsonl`). `.mjs` 도구가 그 로그를 읽는지는 보지 않았다.
- `AgentPerfSnapshot`의 필수 필드는 `at`, `wall_ms`, `llm_round_trips`, `tool_calls`, `env`다. `usage`는 토큰 다섯 값(`prompt_tokens`, `completion_tokens`, `reasoning_tokens`, `cached_tokens`, `cache_write_tokens`)이다 (`agent-perf-metrics.ts:61-131`).
- 따라서 팀 합계는 조율 에이전트의 `lastPerf`를 그대로 두고 `usage`만 합계로 바꿔 적으면 답변 옆 사용량이 맞는다. `cost`는 화면에 쓰이지 않으므로 에이전트별 값을 더해 적는 것으로 충분하다.

**승인 대기와 걸음 수·시간 검토**
- 승인 대기 시간(`approvalWaitMs`)은 성능 기록에만 쓰인다. 전체 대조에서 다른 사용처가 없다.
- 실행의 경과 시간은 `Date.now() - runStartedAt`이고 승인 대기 시간을 빼지 않는다 (`agent-run-step-loop.ts:236`).
- 시간 검토는 걸음 사이에서만 한다. 경과 시간이 다음 검토 시각을 넘었으면 걸음을 시작하기 전에 검토 콜백(`onStepBudgetExhausted`)을 부른다. 승인을 기다리는 도중에는 끊지 않는다 (`agent-run-step-loop.ts:409-414`). 주석상 검토 간격은 30분이다. 상수 값은 읽지 않았다.
- 검토 판정은 경과 시간이 상한(`STEP_BUDGET_AUTO_GRANT_MAX_ELAPSED_MS`, 주석상 1시간)을 넘으면 항상 사용자에게 묻는다 (`step-budget-review.ts:357-372`).
- 검토 콜백이 없으면 걸음 수 상한에서 그대로 끝나고 시간 검토도 하지 않는다 (`agent-run-step-loop.ts:351-353, 409-411`).
- 팀 실행에서의 뜻: 승인을 한 줄로 세우면 작업 에이전트가 차례를 기다린 시간이 그 에이전트의 경과 시간에 들어간다. 검토 콜백을 넘긴 작업 에이전트는 기다리기만 했어도 시간 검토(검토 모델 호출)를 받고, 상한을 넘으면 계속할지 묻는 카드가 에이전트마다 뜬다.

### 2.7 7차: 단계 0 수정 (변경 거부가 기존 파일을 지우던 문제)

**바꾼 것**
| 파일 | 내용 |
|---|---|
| `core/src/agent/agent-checkpoint.ts` | 지점 `meta.json`에 `absentPaths`(보관을 요청했지만 그때 없던 경로)와 `skippedPaths`(있었지만 보관하지 못한 경로)를 적는다. `extendWorkspaceCheckpoint`를 새로 만들었다. 되돌리기는 `absentPaths`에 있는 경로만 지우고, 지점이 모르는 경로는 건드리지 않고 `skipped_paths`로 돌려준다. 미리보기는 `unprotected` 값을 추가로 돌려주고, `is_new`는 `absentPaths`에 있을 때만 참이다. |
| `core/src/agent/agent-run-step-loop.ts` | 수정 도구를 부를 때마다 그 대상 경로를 실행의 지점 하나에 추가 보관한다. 모델이 대신 승인한 경우에도 새 지점을 만들지 않고 같은 지점에 넣는다. 지점이 없거나 지워졌을 때만 새로 만든다. |
| `ui/workspace/src/api/myAgentClient.ts`, `store/workspaceStore.ts` | 되돌리기 결과의 `skipped_paths`를 받아, 변경 거부 뒤 상태 글에 "되돌리지 못함 N"을 보여준다. **17차에 되돌렸다.** 변경 검토 창이 연결돼 있지 않아 도달할 수 없는 코드였다(2.14). 서버 응답의 `skipped_paths`는 그대로 나간다. |
| `tools/verify-parity-p1.mjs` | 2.6의 세 경우와 지점 추가 보관 검사 9개를 넣었다. 기존 "새 파일 삭제" 검사는 실제 흐름처럼 수정 전에 경로를 지점에 알리도록 고쳤다. |

**규칙**
- 경로는 처음 기록된 상태를 유지한다. 이미 보관됐거나, 없던 것으로 적혔거나, 보관 실패로 적힌 경로는 다시 보관하지 않는다. 다시 보관하면 이미 바뀐 내용이 원본으로 들어간다.
- 이 수정 전에 만든 지점에는 `absentPaths`가 없다. 그런 지점으로 변경 거부를 하면 새로 생긴 파일도 지우지 않고 남긴다. 지우지 않는 쪽이 안전하다고 봤다.

**확인한 것**
- 코어와 화면의 타입 검사(`tsc`) 통과.
- `node tools/verify-parity-p1.mjs`에서 되돌리기 관련 검사 13개 통과(기존 4개, 새 9개).
- 같은 스크립트의 MCP 설정 검사 2개(`mcp config round-trip`, `formatUserMcpServersJson`)는 실패한다. 사용자 MCP가 원격 전용(`version: 3`, `streamable_http`)인데 검사는 `command` 방식 서버를 저장하려 해서, 저장한 서버가 빠진다. 이번에 바꾼 파일과 무관하고 고치지 않았다. 이 수정 전에도 실패했는지는 따로 돌려 보지 않았다.

**확인하지 못한 것**
- 실행 루프를 실제로 돌려 지점이 하나로 유지되는지. 지점 함수 수준의 검사와 타입 검사만 했다.
- 화면에서 변경 거부를 눌러 상태 글이 나오는지.
- 셸 명령이 만든 파일이 변경 파일 목록에 들어가는지. 들어간다면 지점이 모르는 경로라서 변경 거부 때 지워지지 않고 남는다.
- 변경 검토 창이 `unprotected` 값을 쓰지 않는다. 보관본이 없는 기존 파일은 여전히 전체가 추가된 것처럼 보일 수 있다.

### 2.8 8차 확인 (걸음 수·시간 값, 상한 종료의 결과 모양, 변경 파일 목록, 변경 검토 창)

**걸음 수·시간 검토의 실제 값**
| 값 | 상수 | 근거 |
|---|---|---|
| 실행당 걸음 수 상한 100 | `MAX_AGENT_STEPS` | `agent-run-types.ts:11` |
| 연장 한 번에 50걸음 | `STEP_BUDGET_EXTENSION` | `step-budget-review.ts:15` |
| 자동 연장 최대 2회 | `STEP_BUDGET_MAX_AUTO_GRANTS` | `step-budget-review.ts:16` |
| 시간 검토 간격 30분 | `STEP_BUDGET_TIME_CHECK_INTERVAL_MS` | `step-budget-review.ts:21` |
| 자동 승인 시간 상한 60분 | `STEP_BUDGET_AUTO_GRANT_MAX_ELAPSED_MS` | `step-budget-review.ts:23` |

- 6차에서 주석으로만 읽은 30분·1시간이 상수 값과 같다.
- 판정 순서(`decideStepBudgetGrant`, `step-budget-review.ts:357-372`): 검토 모델을 못 쓰면 사용자에게 묻는다. 검토 모델이 멈추라고 하면 멈춘다. 60분을 넘으면 항상 사용자에게 묻는다. 시간 검토는 60분 안이면 검토 모델의 판단만으로 계속한다. 걸음 수 연장은 "나 대신 승인"·Autopilot이고 자동 연장이 2회 미만일 때만 자동이다.
- 검토 콜백이 없으면 `extendStepBudget`이 바로 거짓을 돌려준다 (`agent-run-step-loop.ts:352-354`). 작업 에이전트는 100걸음에서 끝나고, 시간 검토는 아예 돌지 않는다 (`agent-run-step-loop.ts:412`).

**걸음 수 상한에서 끝날 때의 결과**
- 오류를 던지지 않고 정상 반환한다. 결과는 `content`(모델의 마지막 출력), `steps`, 그리고 `applicationNotice`를 갖는다. `applicationNotice.kind`는 `'continuation'`, 제목은 "실행 제한으로 중간 종료"다 (`agent-run-step-loop.ts:1618-1637`).
- 끝내기 직전에 이어하기 스냅샷을 그 실행의 `sessionId` 메타에 저장한다. 작업 에이전트는 자기 내부 식별자의 메타에 저장하므로 부모의 이어하기 상태를 덮어쓰지 않는다.
- 호스트 실행 제한 오류를 받은 경우에도 같은 모양(`kind: 'continuation'`)으로 정상 반환한다 (`agent-run-loop.ts:985-1045`).
- 도구 연속 실패로 중단하는 경로(`finishKeptRun`)의 결과 모양은 읽지 않았다.
- 따라서 팀 실행기는 결과의 `applicationNotice?.kind === 'continuation'`으로 "끝내지 못함"을 판정할 수 있다. 오류로 끝난 경우는 예외로 온다.

**변경 파일 목록에 들어가는 도구**
- 변경 파일 목록(`mutatedPathsThisRun`)에 경로를 넣는 도구는 `write_file`, `edit_file`, `apply_patch`, `delete_file` 넷이다 (`agent-run-step-loop.ts:1422-1449`).
- 셸 명령(`run_terminal`)이 만들거나 고친 파일은 목록에 들어가지 않는다. 변경 검토 창에 나오지 않고, 변경 거부로 되돌려지지도 지워지지도 않는다. 2.7의 물음("셸 명령이 만든 파일이 목록에 들어가는지")의 답이다.
- `rename_file`도 목록에 넣는 분기가 이 범위에 없다. 되돌리기 지점에는 옛 경로와 새 경로가 모두 보관 요청된다(`collectAutoCheckpointPaths`가 `path`와 `new_path`를 넣는다, `agent-run-helpers.ts:505-535`). 그러나 화면이 변경 파일 목록의 경로만 되돌리기로 보내므로, 이름 바꾸기는 변경 거부로 되돌려지지 않을 것으로 보인다. 읽은 범위는 1416-1452줄이고, 파일 안 `rename_file` 검색은 0건이었지만 이 검색은 줄을 놓친 적이 있다(2.4). 9차에서 전체 파일 대조와 실행으로 확인했다(2.9).
- 팀 실행에서의 뜻: 작업 에이전트가 셸 명령으로 바꾼 파일은 팀 실행기의 파일 점유 확인(수정 도구 직전)도 거치지 않고, 결과의 변경 파일 목록에도 없다.

**변경 검토 창**
- 미리보기 응답에서 창이 쓰는 값은 `before`, `after`, 크기, `is_new`, 차이 줄 수다 (`MutateReviewPane.tsx:74-93`). `unprotected`는 화면 코드 어디에서도 쓰지 않는다(`ui/workspace/src` 검색 0건).
- `is_new`가 참일 때만 "신규 · Reject 시 삭제"를 붙인다 (`MutateReviewPane.tsx:230`). 단계 0 뒤로 보관본이 없는 기존 파일은 `is_new`가 거짓이라 이 글이 붙지 않는다. 대신 되돌릴 수 없다는 표시도 없다.

**`agent-perf.jsonl`을 읽는 도구**
- `tools` 검색에서 이 파일 이름이 나온 곳은 `tools/lab/IMPROVEMENT_PLAN.md:96` 한 줄뿐이다. 읽는 `.mjs`는 나오지 않았다. 디렉터리 검색 결과라 줄을 놓쳤을 수 있다.

### 2.9 9차: `rename_file`과 변경 거부 재현

**코드 대조 (전체 파일 `Select-String`)**
- `core/src` 전체에서 `mutatedPathsThisRun.add`는 `agent-run-step-loop.ts:1427-1448`의 다섯 줄뿐이다. `rename_file` 분기는 없다. 8차의 추정이 맞다.
- `rename_file`은 수정 도구로 분류된다 (`verify-loop.ts:11-27`). 그래서 지점 보관은 거친다. `collectAutoCheckpointPaths`가 `path`와 `new_path`를 모두 넣는다.
- 화면의 변경 거부는 변경 파일 목록(`review.paths`)만 되돌리기로 보낸다 (`workspaceStore.ts:2164-2190`).

**재현 방법**
- 임시 폴더에서 빌드된 코어(`core/dist`)의 `collectAutoCheckpointPaths`, `createWorkspaceCheckpoint`, `extendWorkspaceCheckpoint`, `renameWorkspaceFile`, `rollbackWorkspaceCheckpoint`를 실행 루프와 같은 순서로 불렀다.
- 변경 파일 목록은 `agent-run-step-loop.ts:1422-1449`의 분기를 스크립트에 옮겨 적어 만들었다. 실행 루프 자체와 화면은 거치지 않았다.
- 시작 상태는 기존 파일 `rn/old.ts`(내용 `orig`) 하나다. 임시 폴더는 지웠다.

**결과**
| 경우 | 실행 순서 | 변경 파일 목록 | 변경 거부 결과 | 디스크 |
|---|---|---|---|---|
| A | `old.ts` → `new.ts` 이름 바꾸기 | 비어 있음 | 복원 0, 삭제 0 | `old.ts` 없음, `new.ts` = `orig`. 이름 바꾸기가 되돌려지지 않는다. |
| B | 이름 바꾸기 뒤 `new.ts` 수정 | `new.ts` | 복원 0, **삭제 1 (`new.ts`)** | **`old.ts`도 `new.ts`도 없다.** |
| C | `old.ts` 수정 뒤 이름 바꾸기 | `old.ts` | 복원 1 | `old.ts` = `orig`, `new.ts` = 수정된 내용이 그대로 남는다. |
| 대조 | B와 같되 목록에 `old.ts`, `new.ts`를 모두 넣음 | 둘 다 | 복원 1, 삭제 1 | `old.ts` = `orig`, `new.ts` 없음. 올바른 결과다. |

- 경우 B는 작업 폴더에서 파일이 사라지는 데이터 손실이다. 지점에는 `old.ts`가 보관돼 있고 `new.ts`는 "없던 경로"로 적혀 있다. 거부 요청에 `new.ts`만 오므로 `new.ts`는 지워지고 `old.ts`는 복원되지 않는다. 원본은 지점 폴더(`data/agent-checkpoints/...`)에 남지만, 지점은 키마다 5개만 남기고 정리된다.
- 경우 B는 단계 0 수정 전에도 같았다. 수정 전에는 지점에 없는 경로를 모두 지웠기 때문이다. 단계 0이 만든 문제가 아니라 단계 0이 막지 못한 문제다.
- 대조 결과로 보면, `rename_file` 성공 시 옛 경로와 새 경로를 변경 파일 목록에 넣는 것만으로 세 경우가 모두 풀린다. 지점 쪽 코드는 고칠 필요가 없다.

**확인하지 못한 것**
- 경우 A에서 변경 파일 목록이 비면 변경 검토 창이 뜨는지. 창이 뜨지 않으면 사용자는 거부할 방법이 없다.
- `apply_patch`의 `move` 동작(`files[].new_path`)이 목록과 지점에 어떻게 잡히는지. `collectAutoCheckpointPaths`와 목록 분기 모두 `files[].path`만 읽으므로 새 경로는 지점에도 목록에도 없을 것으로 보인다. 읽고 추론한 것이다.
- 실행 루프와 화면을 거친 재현.

### 2.10 10차: 단계 0-2 수정 (`rename_file`, `apply_patch` 이동)

**`apply_patch` 이동을 읽은 결과**
- 이동은 두 가지 형태로 들어온다. 패치 글의 `*** Update File: 옛경로` 다음 줄 `*** Move to: 새경로`(`Move File:`, `Rename to:`도 받는다)와 `files[].action = 'move'` + `files[].new_path`다 (`apply-patch.ts:174-181`, `273-296`).
- 수정 전에는 지점 대상 추출(`collectAutoCheckpointPaths`)과 변경 파일 목록 분기 모두 새 경로를 읽지 않았다. 9차의 추정이 맞다. 단일 파일 형태의 `args.new_path`만 지점 대상에 들어갔다.
- 수정 전 결과는 돌려 보지 않았다. 읽은 대로라면 이동 뒤 새 경로를 수정하고 변경 거부를 하면 옛 경로는 복원되고 새 경로는 이동 직후 내용으로 남아 파일이 둘이 된다. `rename_file`의 경우 B처럼 사라지지는 않는다.

**고친 내용**
- `agent-run-helpers.ts`에 `collectMutatedPathsForTool`을 추가했다. 도구 호출 하나가 바꾼 경로를 돌려준다. `rename_file`은 `path`와 `new_path`(별칭 `to`)를, `apply_patch`는 `path`·`new_path`·`files[].path`·`files[].new_path`·패치 글의 `Update/Add/Delete File`과 `Move to` 경로를 모두 넣는다.
- 실행 루프(`agent-run-step-loop.ts`)의 변경 파일 목록 분기 다섯 줄을 이 함수 호출 하나로 바꿨다. `write_file`·`edit_file`·`delete_file`의 동작은 같다.
- `collectAutoCheckpointPaths`도 `files[].new_path`와 `Move to` 경로를 지점 대상으로 넣는다. 이동 전에 새 경로가 "없던 경로"로 적혀야 변경 거부 때 지워지기 때문이다. 패치 머리줄 정규식은 패치 해석기와 같게 대소문자를 가리지 않도록 맞췄다.
- 지점 쪽 코드(`agent-checkpoint.ts`)와 화면은 고치지 않았다.

**검사**
- `tools/verify-parity-p1.mjs`에 10개를 추가했다. 빌드된 코어의 실제 함수(`collectAutoCheckpointPaths`, `collectMutatedPathsForTool`, `renameWorkspaceFile`, `applyFilePatches`)를 실행 루프와 같은 순서(지점 보관 → 실행 → 목록 기록)로 부른다. 9차와 달리 목록 분기를 옮겨 적지 않는다.
- 2.9의 경우 A·B·C, `apply_patch` 이동 두 형태(패치 글, `files[]`) 모두 변경 거부 뒤 `old.ts`가 원래 내용으로 돌아오고 `new.ts`가 없다. 10개 통과.
- 코어 타입 검사(`tsc -p tsconfig.json`) 통과. 같은 스크립트의 MCP 설정 검사 2개는 여전히 실패한다(2.7).

**확인하지 못한 것**
- 실행 루프와 화면을 거친 확인. 검사는 루프의 순서를 흉내 낸 것이고, 루프가 `toolOk`를 어떻게 판정하는지는 거치지 않는다.
- `rename_file`이 `{ ok: false }`를 돌려줄 때(대상 없음, 목적지 있음) `toolOk`가 거짓이 되는지. 참이면 바뀌지 않은 경로가 목록에 들어간다. 그 경로는 지점에 처음 상태로 적혀 있어 변경 거부로 잃는 것은 없다고 보지만 읽고 추론한 것이다.
- 변경 검토 창이 옛 경로(디스크에서 없어진 파일)를 어떻게 그리는지.
- 폴더 이름 바꾸기. `renameWorkspaceFile`은 폴더도 옮길 수 있어 보이는데, 지점 보관이 폴더 경로를 어떻게 다루는지 읽지 않았다.

### 2.11 11차 확인 (실패한 이름 바꾸기, 변경 검토 창, 부분 거부, 폴더 이름 바꾸기)

**실패한 이름 바꾸기 (읽어서 확인)**
- `renameWorkspaceFile`은 대상이 없거나 목적지가 이미 있으면 `{ ok: false }`를 돌려준다 (`apply-patch.ts:447-463`). 목적지가 있는 경우는 실행으로도 확인했다.
- 실행 루프는 이 출력을 `ERROR: tool_call_failed` 글로 바꾼 뒤(`tool-self-correction.ts`의 `classifyToolOutputFailure`가 `"ok": false`를 실패로 본다) 성공 여부를 판정한다. `agentToolOutputOk`는 `ERROR:`로 시작하거나 JSON의 `ok`가 `false`이면 거짓이다 (`agent-tool-result.ts:5-18`, `agent-run-step-loop.ts:1296-1309`).
- 변경 파일 목록에 넣는 줄은 `if (toolOk)` 안에 있다 (`agent-run-step-loop.ts:1414-1436`). 실패한 이름 바꾸기의 경로는 목록에 들어가지 않는다. 10차의 걱정은 해당하지 않는다.

**`apply_patch`가 쓰는 도중 실패한 경우 (읽고 추론)**
- `apply_patch`는 모든 항목을 먼저 검증하고, 하나라도 틀리면 아무것도 쓰지 않는다. 검증을 통과한 뒤 쓰는 도중에 실패하면 이미 쓴 파일은 남고 `PARTIAL_COMMIT`과 `ok: false`를 돌려준다 (`apply-patch.ts:356-411`).
- 이 경우 도구 출력이 `ERROR: apply_patch_failed`라서 `toolOk`가 거짓이고, 이미 바뀐 파일이 변경 파일 목록에 들어가지 않는다. 지점에는 보관돼 있지만 변경 검토 창에 나오지 않아 화면에서 되돌릴 수 없다. 지워지지는 않는다. 디스크 쓰기 실패가 있어야 생기는 드문 경우이고 실행해 보지 않았다.

**변경 검토 창이 이름 바꾸기를 그리는 방식 (읽어서 확인)**
- 이름 바꾸기는 목록에 두 줄로 나온다. 둘을 하나로 묶거나 "이름 바꿈"이라고 표시하는 코드는 없다 (`MutateReviewPane.tsx`).
- 옛 경로 줄: 미리보기의 `after`가 없어 모든 줄이 삭제(`-`)로 보인다. 나란히 보기에서는 오른쪽에 "(현재 없음)"이 나온다. 미리보기 응답의 `is_deleted_on_disk`는 화면에서 쓰지 않는다.
- 새 경로 줄: `is_new`가 참이라 "신규 · Reject 시 삭제"가 붙고 모든 줄이 추가(`+`)로 보인다.
- 창에는 전부 거부 외에 줄마다 「복원」 버튼과 「Reject 선택」이 있고, 이때는 고른 경로만 되돌리기로 보낸다 (`workspaceStore.ts:2163-2172`).

**부분 거부 (함수 수준 실행)**
- 방법은 2.9와 같다. 임시 폴더에서 빌드된 코어의 `collectAutoCheckpointPaths`, `collectMutatedPathsForTool`, `createWorkspaceCheckpoint`, `renameWorkspaceFile`, `rollbackWorkspaceCheckpoint`를 불렀다. 실행 루프와 화면은 거치지 않았고 임시 폴더는 지웠다. 시작 상태는 기존 파일 `rn/old.ts`(내용 `orig`), 실행은 `old.ts` → `new.ts` 이름 바꾸기 한 번이다.

| 거부 대상 | 결과 | 디스크 |
|---|---|---|
| `new.ts`만 | 복원 0, **삭제 1** | **`old.ts`도 `new.ts`도 없다.** |
| 위에 이어 `old.ts` | 복원 1 | `old.ts` = `orig`. 올바른 상태로 돌아온다. |
| `old.ts`만 | 복원 1 | `old.ts` = `orig`, `new.ts` = `orig`. 같은 파일이 둘이 된다. |

- 새 경로만 거부하면 파일이 작업 폴더에서 사라진다. 옛 경로 줄이 목록에 남아 있는 동안은 그 줄을 거부해 되살릴 수 있다. 그 상태에서 Accept를 누르면 창이 닫히고 원본은 지점 폴더에만 남는다.
- 단계 0-2가 막은 것은 "전부 거부"의 손실이다. 부분 거부에는 같은 손실이 남아 있다. 고치려면 이름 바꾸기의 두 경로를 한 쌍으로 묶어 함께 되돌려야 한다. 지점에 쌍 정보를 적고 되돌리기가 한쪽을 받으면 다른 쪽도 처리하게 하거나, 화면이 두 줄을 하나로 묶어 보내는 방법이 있다. 아직 고치지 않았다(4절 단계 0-3).

**폴더 이름 바꾸기 (함수 수준 실행)**
- `renameWorkspaceFile`은 폴더도 옮긴다. `d1`(안에 `x.ts`) → `d2`가 성공했다.
- 지점은 폴더를 보관하지 않는다. 옛 폴더 `d1`은 "보관하지 못한 경로"로, 새 폴더 `d2`는 "없던 경로"로 적힌다. 폴더 안의 파일은 지점에 들어가지 않는다.
- 이름을 바꾼 뒤 `d2/x.ts`를 수정하고 전부 거부(`d1`, `d2`, `d2/x.ts`)한 결과: 복원 1, 삭제 0, 되돌리지 못함 1(`d1`). `d2/x.ts`는 원래 내용으로 돌아오고, 폴더 이름은 `d2`로 남는다. 잃는 파일은 없다.
- 되돌리기는 파일만 지우므로(`agent-checkpoint.ts`의 `st.isFile()` 확인) "없던 경로"로 적힌 새 폴더는 지워지지 않는다.
- 따라서 폴더 이름 바꾸기는 변경 거부로 되돌려지지 않는다. 화면에는 "되돌리지 못함 1"이 나온다. 데이터 손실은 아니고 기능이 없는 것이다.
- 실행하지 않은 경우: 폴더 안 파일을 먼저 수정하고 폴더 이름을 바꾼 뒤 거부. 읽은 대로라면 옛 폴더가 그 파일 하나만 가진 채 다시 생기고, 새 폴더의 수정된 파일은 그대로 남는다.

**그 밖에 읽은 것**
- `delete_file`은 파일을 지우지 않고 작업 폴더의 휴지통으로 옮긴다 (`apply-patch.ts:419-445`). 변경 거부로 원래 자리에 복원해도 휴지통의 사본은 남을 것으로 보인다(실행하지 않았다).

### 2.12 12차: 단계 0-3 수정 (이름 바꾸기의 부분 거부)

**고친 내용**
- 지점 메타에 `movePairs`(옛 경로 → 새 경로 목록)를 추가했다. `recordCheckpointMovePairs`가 적는다 (`agent-checkpoint.ts`).
- 되돌리기는 요청받은 경로를 쌍으로 이어진 경로까지 넓힌 뒤 복원·삭제를 정한다. 연쇄(`old` → `new` → `third`)도 끝까지 따라간다. 함께 처리한 경로는 응답의 `paired_paths`로 돌려준다. 경로 목록 없이 부르는 전체 복원은 그대로다.
- 쌍을 뽑는 `collectMovePairsForTool`을 `agent-run-helpers.ts`에 만들었다. `rename_file`, `apply_patch`의 `files[].new_path`, 패치 글의 `Move to`를 읽는다.
- 실행 루프는 도구가 성공한 뒤에만 쌍을 적는다 (`agent-run-step-loop.ts`, 변경 파일 목록에 넣는 줄 바로 아래). 실패한 이름 바꾸기는 쌍으로 남지 않는다. 적는 데 실패하면 무시하고 계속한다.
- 화면은 `paired_paths`에 든 줄도 변경 검토 목록에서 뺀다 (`workspaceStore.ts`의 `rejectMutateReview`, `myAgentClient.ts`). 11차에 "화면은 그대로 둔다"고 했지만, 안 빼면 이미 되돌려진 경로의 줄이 남아서 이 두 곳은 고쳤다.

**검사 (함수 수준 실행)**
- `tools/verify-parity-p1.mjs`에 10개를 추가했고 모두 통과했다. 방법은 2.9와 같고, 실행 루프와 화면은 거치지 않았다.

| 경우 | 거부 대상 | 결과 |
|---|---|---|
| 이름 바꾸기 | 새 경로만 | 옛 경로 복원, 새 경로 삭제 |
| 이름 바꾸기 | 옛 경로만 | 옛 경로 복원, 새 경로 삭제 (전에는 같은 파일이 둘이 됐다) |
| 이름 바꾸기 뒤 새 경로 수정 | 새 경로만 | 원래 파일이 원래 내용으로 복원 |
| 연쇄 이름 바꾸기 | 마지막 경로만 | 처음 경로로 복원, 중간·마지막 경로 없음 |
| `apply_patch` 이동 (패치 글) | 새 경로만 | 옛 경로 복원 |
| 이름 바꾸기 + 무관한 파일 수정 | 새 경로만 | 무관한 파일의 수정은 그대로 남음 |

- 나머지 4개는 `collectMovePairsForTool`이 세 형태에서 쌍을 뽑고 일반 수정에서는 뽑지 않는지 본다.
- 타입 검사는 코어와 화면 모두 통과했다. MCP 설정 검사 2개는 여전히 실패한다(2.7).

**동작이 달라지는 점과 한계**
- 옛 경로 줄만 거부해도 새 경로 파일이 지워진다. 에이전트가 새 경로에 한 수정도 함께 없어진다. 이름 바꾸기를 되돌린다는 뜻이라 의도한 동작이다.
- 화면의 상태 글은 "복원 N · 삭제 N" 숫자에 짝 경로가 포함될 뿐, 짝이 함께 처리됐다는 말은 따로 나오지 않는다.
- 이 수정 전에 만든 지점에는 쌍 기록이 없어 부분 거부가 전과 같이 동작한다.
- 쌍은 실행에 지점이 있을 때만 적힌다. 지점 생성에 실패한 실행에서는 적히지 않는다.
- 폴더 이름 바꾸기도 쌍으로 적히지만, 지점이 폴더를 보관하지 않으므로 여전히 되돌려지지 않는다(2.11).
- `recordCheckpointMovePairs`도 `meta.json`을 통째로 쓴다. 팀 실행에서는 `extendWorkspaceCheckpoint`와 마찬가지로 팀 실행기 한 곳에서만 불러야 한다.
- 읽지 않은 것: 에이전트 도구 `workspace_rollback`이 경로 목록을 넘기는지. 넘긴다면 같은 넓히기가 적용된다.

### 2.13 13차: 실행 루프를 거친 확인

**방법**
- `tools/verify-mutate-reject-e2e.mjs`를 새로 만들었다 (`npm run verify:mutate-reject-e2e`). `tools/verify-plugin-e2e.mjs`의 가짜 모델 서버 방식을 따랐다.
- 임시 폴더에 작업 폴더를 만들고, OpenAI 호환 가짜 모델 서버가 도구 호출을 차례로 내보낸다. 빌드된 코어의 `runCodeAgent`가 그 호출을 실제로 실행한다. 승인 콜백은 항상 허용이다.
- 한 실행에서 하는 일: 기존 파일 `a.ts`·`b.ts` 수정, `old.ts` → `new.ts` 이름 바꾸기 뒤 `new.ts` 수정, `created.ts` 새로 만들기, `apply_patch`(`files[]` 형태)로 `moved-src.ts` → `moved-dst.ts` 이동.
- 되돌리기는 실행 결과의 `checkpointId`와 `mutatedPaths`를 써서 `rollbackWorkspaceCheckpoint`를 부른다. 인자는 `/workspace/checkpoint/rollback` 라우트가 넘기는 것과 같다 (`dispatch.ts:1300-1343`).
- 거치지 않은 것: HTTP 서버, 화면(`rejectMutateReview`), 실제 모델, 승인 카드.

**결과 (24개 통과)**

| 확인한 것 | 결과 |
|---|---|
| 수정 도구 호출이 모두 성공하고 디스크가 예상대로 바뀜 | 통과 |
| 변경 파일 목록에 이름 바꾸기·이동의 옛 경로와 새 경로가 모두 들어감 | `a.ts`, `b.ts`, `created.ts`, `moved-dst.ts`, `moved-src.ts`, `new.ts`, `old.ts` |
| 수정 호출 6번 동안 되돌리기 지점이 하나로 유지됨 | 지점 폴더 1개, 실행 결과의 `checkpointId`와 같음 |
| 지점 메타에 `absentPaths`, `movePairs`가 적힘 | 통과 |
| 전부 거부 | 기존 파일 넷이 원래 내용으로 복원, `new.ts`·`created.ts`·`moved-dst.ts` 삭제 |
| `new.ts` 줄만 거부 | `old.ts` 복원, `new.ts` 삭제, 응답의 `paired_paths`에 `old.ts`. 다른 파일의 수정은 그대로 |
| `moved-src.ts` 줄만 거부 (`apply_patch` `files[]` 이동) | `moved-src.ts` 복원, `moved-dst.ts` 삭제 |

**하면서 알게 된 것**
- 실행 루프는 모델 요청 한 번과 실행되는 턴 하나가 일대일이 아니다. 가짜 서버가 요청 횟수로 다음 호출을 정하게 했더니 수정 호출 일부가 실행되지 않았다. 대화에 든 도구 결과를 보고 다음 호출을 정하게 바꾸니 모두 실행됐다. 실행 루프가 왜 더 묻는지는 읽지 않았다.
- 실행 루프가 스스로 넣는 읽기 단계가 `created.ts`를 `BARE_MODULE_READ`(npm 패키지 이름으로 보임) 오류로 거절했다. 수정과 되돌리기 결과에는 영향이 없었다. 원인은 읽지 않았다.
- 임시 `cqrRoot` 폴더는 프로세스가 살아 있는 동안 `EPERM`으로 지워지지 않는다. 코어가 그 아래 파일을 열어 둔 것으로 보인다. 검사는 프로세스가 끝난 뒤 지우는 별도 프로세스를 띄운다. 무엇이 열려 있는지는 읽지 않았다.

### 2.14 14차: 변경 검토 창의 연결 상태, HTTP 라우트, 모델 대신 승인 경로

**변경 검토 창은 화면에 연결돼 있지 않다 (전체 파일 대조, `ui/workspace/src` 아래 `.ts`·`.tsx` 전부)**
- `MutateReviewPane`이라는 글자는 자기 파일(`components/MutateReviewPane.tsx`)에만 있다. 가져다 쓰는 곳이 없다.
- `pendingMutateReview`에 값을 넣는 곳이 없다. 초기값 `null`(`workspaceStore.ts:1760`), 수락 때 `null`(2158), 거부 뒤 남은 줄 정리(2203)뿐이다. 커밋된 `HEAD`도 같다.
- 서버는 완료 이벤트에 `checkpointId`를 여전히 싣고(`chat-orchestrator.ts:1402-1423`), 화면 클라이언트도 `onDone`으로 넘긴다(`myAgentClient.ts:2305-2330`). 저장소는 `info.mutatedPaths`만 읽고(`workspaceStore.ts:1565`) `checkpointId`는 쓰지 않는다.
- 화면의 `rollbackWorkspaceCheckpoint`를 부르는 곳은 `rejectMutateReview` 하나, `fetchCheckpointPreview`를 부르는 곳은 `MutateReviewPane` 하나다. 둘 다 도달할 수 없다.
- `git log -S"<MutateReviewPane"`에는 update 17(2026-08-31)과 update 18(2026-09-01) 두 커밋이 나온다. 17에서 붙이고 18에서 뗀 것으로 보이지만 두 커밋의 내용은 읽지 않았다(15차에서 읽었다, 2.15). `tools/verify-preview-explorer.mjs`가 "Preview에서 검토" 글과 자동 파일 열기가 없어야 한다고 검사하는 것과 맞는다.

**이것이 바꾸는 것**
- 2.6, 2.9, 2.11에서 재현한 삭제·소실은 되돌리기 함수의 실제 결함이지만, 지금 화면에서는 변경 거부를 누를 방법이 없어 사용자에게 일어나지 않는다. "지금 제품에 있는 데이터 손실 버그"라는 표현은 과했다. 경로 목록을 넘기는 호출은 `POST /workspace/checkpoint/rollback`을 직접 부르는 경우뿐이다.
- 2.4, 2.8, 2.11, 2.12의 "변경 검토 창이 …를 보여준다", "짝 줄이 목록에서 빠진다"는 구성 요소와 저장소 코드를 읽은 내용이고, 화면에서 일어나는 일이 아니다. 12차에서 고친 `workspaceStore.ts`·`myAgentClient.ts`도 도달할 수 없는 코드다.
- 단계 0, 0-2, 0-3의 수정은 되돌리기 함수와 라우트를 안전하게 만든 것이고, 팀 실행이 변경 거부를 다시 쓰려면 필요하다. 지금 사용자가 겪는 문제를 고친 것은 아니다.
- 팀 실행 설계(3.5, 3.7)는 "변경 검토 창"을 전제로 적혀 있다. 화면을 다시 붙일지, 다른 되돌리기 화면을 만들지는 6절에 정할 것으로 남긴다.

**에이전트 도구 `workspace_rollback`** (`agent-tool-execute.ts:933-949`)
- 경로 목록을 넘기지 않는다. 그러면 되돌리기는 지점에 보관된 파일만 전부 복원하고 아무것도 지우지 않는다(`agent-checkpoint.ts`의 `rollbackWorkspaceCheckpoint`). 쌍 처리도 타지 않는다.
- 이름 바꾸기 뒤에 이 도구로 되돌리면 옛 경로가 복원되고 새 경로도 남을 것이다. 잃는 파일은 없다. 읽고 추론한 것이고 실행하지 않았다.
- 승인이 항상 필요하다(`needsHumanApproval`의 `workspace_rollback` 분기).

**승인이 필요한 수정 도구** (`tool-approval.ts:465-610`)
- 작업 폴더 안의 `edit_file`, `rename_file`, 보통 크기의 `write_file`·`apply_patch`는 승인을 묻지 않는다. 2.13의 검사에서 승인 콜백은 한 번도 불리지 않았다(실행으로 확인, 호출 0회). 2.13에 "승인 콜백은 항상 허용"이라고 적었지만 실제로는 묻지 않은 것이다.
- 승인을 묻는 것은 `delete_file`, 큰 `write_file`, 큰 `apply_patch`, 작업 폴더 밖 경로다. 그래서 "모델이 대신 승인한 경우의 지점 처리"(`agent-run-step-loop.ts:1138-1190`)는 이 호출들에서만 탄다.
- 2.5에 "모델이 대신 승인한 경우에는 새 대상마다 지점을 새로 만든다"고 적은 것은 이 범위로 좁혀 읽어야 한다.

**실행한 것** (`tools/verify-mutate-reject-e2e.mjs`에 두 경우 추가, 전체 48개 통과)

| 경우 | 방법 | 결과 |
|---|---|---|
| 모델 대신 승인 | 승인 콜백이 `{ approved, by: 'reviewer' }`로 답한다. `doomed.ts` 삭제 → `a.ts` 수정 → `old.ts`→`new.ts` 이름 바꾸기 → `b.ts` 삭제 | 승인 요청 2회(둘 다 `delete_file`). 지점은 하나이고 이름표가 `before-model-approval:mock-reviewer`. 전부 거부하면 `doomed.ts`·`b.ts`·`a.ts`·`old.ts`가 원래 내용으로 돌아오고 `new.ts`는 지워진다 |
| HTTP 라우트 | 실행 뒤 `dispatchApiRequest`를 임시 포트에 올리고 `GET /workspace/checkpoint/preview`, `POST /workspace/checkpoint/rollback`(`new.ts`만)을 보낸다. 본문 모양은 화면 클라이언트와 같다 | 둘 다 200. 응답에 `paired_paths: ["old.ts"]`, `deleted_paths: ["new.ts"]`, `skipped_paths: []`. `old.ts` 복원, `new.ts` 삭제 |

- HTTP 경우의 한계: 대화와 작업 폴더의 연결은 가짜 저장소로 대신했다(`sessionStore.load`가 `allowed_paths`를 돌려준다). 라우트 코드와 그 아래 함수는 빌드된 실제 코드다. 사용권 검사도 통과시키는 가짜다.
- 하면서 알게 된 것: `sessionFromReq`는 머리글이 없으면 `'default'`를 돌려준다(`core/src/http/json.ts:19-23`). 그래서 `workspaceRootForRequest`의 "대화가 없으면 PC 기본 작업 폴더" 분기(`dispatch.ts:288`)는 타지 않는다. 처음에는 그 분기로 작업 폴더를 주려다 500이 났다.

### 2.15 15차: 변경 검토 창이 빠진 경위

**git 기록** (`git log -S`, 각 커밋의 `git show`)
| 커밋 | 날짜 | 한 일 |
|---|---|---|
| `a26a7d0` 첫 공개 | 2026-08-26 | `MutateReviewPane.tsx`와 저장소의 `pendingMutateReview`가 들어 있다. |
| `cd7c3b7` | 2026-08-27 | 창 파일(251줄)과 저장소 코드(85줄)를 지웠다. 커밋 글: "The model-directed loop is a single coder with no Accept/Reject pane". 검사에 `pendingMutateReview`가 없어야 한다는 단언을 넣었다. |
| `cd8d87a` update 8 | 2026-08-28 | CQR_PA 보관본을 옮기면서 저장소 코드가 다시 들어왔고, 위 단언은 빠졌다. |
| `b6d24eb` update 17 | 2026-08-31 | 창 파일이 다시 들어오고 `MainWorkspaceContainer.tsx`에 붙었다. 커밋 글에 "mutate review pane wiring"이 있다. |
| `9a6c590` update 18 | 2026-09-01 | `MainWorkspaceContainer.tsx`에서 가져오기와 표시 분기를 뺐다. 커밋 글에는 이 일이 따로 적혀 있지 않고 "legacy mode cleanup", "right-panel tab registry"가 있다. 같은 커밋에서 Preview 모드 목록을 `workspacePreviewModes`로 옮겼다. |

- 14차의 "17에서 붙이고 18에서 뗐다"는 맞다. 다만 그 전에 한 번 지웠다가 보관본을 옮기면서 되살아난 것이다.
- `a26a7d0`, `cd8d87a`, `b6d24eb`, `HEAD`의 `workspaceStore.ts`에서 `pendingMutateReview`가 나오는 줄은 타입, 초기값 `null`, 수락 때 `null`, 거부 뒤 남은 줄 정리뿐이다. 실행이 끝났을 때 값을 채우는 줄은 네 시점 모두 없다. 창은 update 17에서 붙어 있던 동안에도 열리지 않았을 것으로 본다. 저장소 파일 하나만 본 것이고, 다른 파일이 값을 넣었는지는 `HEAD`에서만 대조했다(2.14).

**룰북** (`C:\MY_FULL_AI\RULEBOOK\MY_CUSTOM_CODEX\docs`)
- `02_ALWAYS_ON_RULES.md` 8번: 기본 수정은 즉시 디스크에 적용한다. Accept/Reject 패널은 화면에 나타나지 않는다. 되돌리기는 지점 API다.
- `decisions/ADR-RE-002-runtime-is-canonical.md` 규칙 3이 같은 내용이고, 결과 절에 "변이 수락 UI를 구현하면 이 룰북과 다른 제품이 된다"고 적혀 있다. 2026-09-02 후속에 "파일은 다시 들어왔으나 미마운트"라고 적혀 있다.
- 따라서 창이 없는 것은 실수가 아니라 기록된 결정이다. 이유는 "단일 코더 루프에는 수락 단계가 없다"로 적혀 있다.

**이것이 바꾸는 것**
- "창을 다시 붙이기"는 붙이기만으로 끝나지 않는다. 실행이 끝났을 때 창을 여는 코드를 새로 써야 하고, ADR-RE-002 규칙 3을 뒤집는 결정이 먼저 필요하다. "팀 실행용 화면을 새로 만들기"도 수락·거부 화면이면 같은 규칙에 걸린다.
- 지금 규칙과 맞는 것은 "수정은 즉시 적용, 되돌리기는 지점 API와 에이전트 도구"다. 팀 실행에 그대로 쓰려면 `workspace_rollback`이 보완돼야 한다. 지금은 경로 목록 없이 불러서 보관된 파일만 복원하고 새로 생긴 파일은 남긴다(2.14). 단계 0 뒤로 지점이 "없던 경로"를 적고 있으므로, 전체 되돌리기가 그 경로를 지우게 하는 것은 안전하게 할 수 있다. 아직 고치지 않았다.
- `tools/verify-parity-p1.mjs:89-129`는 창 파일과 `pendingMutateReview`가 소스에 있는지 본다. 창 파일을 지우면 이 검사가 깨진다.
- 12차에서 고친 화면 코드(`workspaceStore.ts`, `myAgentClient.ts`)는 도달할 수 없는 코드로 남아 있다. 해는 없지만 쓰이지 않는다.

### 2.16 16차: 되돌리기 방식 확정, 단계 0-4 수정 (`workspace_rollback`)

**확정한 것**
- 수정은 즉시 디스크에 적용하고, 수락·거부 화면은 두지 않는다. 되돌리기는 에이전트 도구 `workspace_rollback`으로 한다. ADR-RE-002 규칙 3과 맞는다(2.15).
- 이 문서의 이전 절에서 "변경 거부"라고 적은 동작은, 앞으로는 "에이전트가 `workspace_rollback`을 부르는 것"으로 읽는다. 파일별 부분 되돌리기는 화면이 아니라 도구의 `paths` 인자로 한다.

**고치기 전에 읽은 것**
- `workspace_rollback`은 경로 목록 없이 되돌리기 함수를 불렀다(`agent-tool-execute.ts`). 보관된 파일만 복원하고 새로 생긴 파일은 남겼다. 이름 바꾸기 뒤에는 옛 경로와 새 경로가 둘 다 남는다.
- 자동 지점의 `id`는 상태 글(`reportStatus`)과 실행 결과로만 나가고, 모델이 받는 도구 결과에는 없다(`agent-run-step-loop.ts:1140-1245`에서 읽은 범위). 모델은 자기 실행이 만든 지점의 `id`를 알 방법이 없어, 사용자가 말로 되돌리기를 시켜도 도구를 부를 수 없었을 것으로 본다. 대화 기록 등 다른 경로로 `id`가 모델에 들어가는지는 대조하지 않았다.

**고친 것 (단계 0-4)**
| 파일 | 내용 |
|---|---|
| `core/src/agent/agent-checkpoint.ts` | 되돌리기 함수에 `removeCreated` 선택 인자를 넣었다. 경로 목록 없이 부르면서 이 값을 켜면, 지점이 "없던 경로"로 적은 것(실행이 새로 만든 파일, 이름 바꾸기·이동의 새 경로)도 지운다. 보관하지 못한 경로는 `skipped_paths`로 돌려준다. 값을 주지 않으면 전과 같이 복원만 한다. |
| `core/src/agent/agent-tool-execute.ts` | `workspace_rollback`이 `paths`를 받는다. 없으면 `removeCreated`를 켜서 지점 전체를 되돌리고, 있으면 그 경로만 되돌린다(이름 바꾸기 짝은 12차의 쌍 처리로 함께 간다). 지점 `id`가 비었거나 이 대화에 없는 값이면 아무것도 바꾸지 않고, 이 대화의 지점 목록(최근 5개, 최신순)을 돌려준다. |
| `core/src/agent/agent-tool-definitions.ts` | 도구 설명과 인자에 위 동작을 적었다. |
| `ui/workspace/src/store/workspaceStore.ts`, `api/myAgentClient.ts` | 12차에 넣은 짝 줄 처리(`paired_paths`)를 뺐다. 화면이 연결돼 있지 않아 도달할 수 없는 코드였다(2.14). 서버 응답의 `paired_paths`는 그대로 나간다. 7차에 넣은 `skipped_paths` 상태 글은 16차에는 그대로 두었다가 17차에 같은 이유로 되돌렸다. 두 화면 파일은 이 작업 전과 같다. |

- HTTP 라우트(`POST /workspace/checkpoint/rollback`)는 고치지 않았다. 경로 목록 없이 부르면 전과 같이 복원만 한다.
- 이전에 만든 지점은 "없던 경로" 기록이 없어, 도구로 전체를 되돌려도 아무것도 지우지 않는다.

**실행으로 확인한 것** (`tools/verify-mutate-reject-e2e.mjs`, 78개 통과)
| 경우 | 결과 |
|---|---|
| 실행 루프로 수정한 뒤 도구를 `id` 없이 호출 | `ok: false`, 목록 첫 줄이 실행 결과의 지점 `id`와 같다. 파일은 바뀌지 않는다. |
| 도구를 `paths` 없이 호출 | 기존 파일이 모두 원래 내용으로 복원되고 `new.ts`, `created.ts`, `moved-dst.ts`가 지워진다. |
| 도구를 `paths: ["new.ts"]`로 호출 | `old.ts` 복원, `new.ts` 삭제. 다른 파일의 수정은 그대로다. |
| 되돌리기 함수를 경로 목록도 `removeCreated`도 없이 호출 | 복원만 하고 삭제는 0이다(이전 동작 유지). |

- 코어와 화면 타입 검사 통과. `tools/verify-parity-p1.mjs`는 MCP 설정 검사 2개만 실패한다(전과 같다).
- 한계: 도구 실행 함수(`executeAgentTool`)를 직접 불렀다. 모델이 지점 목록을 보고 `id`를 골라 다시 부르는 흐름과 승인 카드는 거치지 않았다. `workspace_rollback`은 승인을 묻는 도구로 안내문에 적혀 있다(`agent-run-helpers.ts:71`).

**남는 것**
- 지점은 대화마다 최근 5개만 남는다(`clearOldCheckpoints(..., 5)`, 모델 대신 승인 경로는 20). 실행 여섯 번 전의 수정은 되돌릴 수 없다.
- 지점은 파일의 "그 실행에서 처음 수정하기 전" 상태를 갖는다. 되돌린 뒤 다시 앞으로 돌리는 방법은 없다.
- 사용자가 화면에서 직접 누르는 되돌리기는 없다. 에이전트에게 말로 시켜야 한다.

## 3. 설계

### 3.1 구성 요소
| 요소 | 역할 |
|---|---|
| 팀 실행기 | 작업판을 소유하고, 작업 에이전트를 띄우고, 파일 점유를 판정하고, 이벤트와 승인을 중계한다. 코드이며 모델이 아니다. |
| 조율 에이전트 | 작업을 항목으로 나누고, 결과를 확인하고, 막힌 항목을 다시 배분하고, 마지막에 진단과 테스트를 돌린다. `runCodeAgent` 한 번에 작업판 도구를 추가한 것이다. |
| 작업 에이전트 | 항목 하나를 맡아 끝낸다. `runCodeAgent` 한 번이다. |
| 작업판 | 팀 실행당 파일 하나. 쓰기는 팀 실행기만 한다. |

### 3.2 진입점
- `core/src/chat/modes/workspace-agent.ts`에서 오케스트레이션 모드일 때 `runMarOrCodeAgent` 대신 팀 실행기를 부른다.
- 팀 실행기는 `agent-mar-runtime.ts`에 둔다.
- 모드는 `execution_policy`에 명시 값으로 둔다. 메시지 글에서 추정하지 않는다.

### 3.3 작업판 항목
| 필드 | 뜻 |
|---|---|
| `id` | 항목 식별자 |
| `title`, `prompt` | 할 일 |
| `status` | `pending` / `claimed` / `running` / `review` / `done` / `failed` / `skipped` |
| `depends_on` | 선행 항목 `id` 목록 |
| `file_scope` | 건드릴 파일·폴더 범위 |
| `category` | 난이도 등급. 모델 배정에 쓴다. |
| `acceptance` | 완료 기준 |
| `owner` | 담당 에이전트 식별자 |
| `result` | 결과 요약과 바꾼 파일 목록 |
| `notes` | 다른 에이전트가 읽어야 할 결정 사항 (인터페이스 이름, 형식 등) |

### 3.4 스케줄링 규칙
1. 선행 항목이 모두 `done`이고 `file_scope`가 실행 중인 항목과 겹치지 않는 `pending` 항목을 고른다.
2. 동시 실행 상한 안에서 작업 에이전트를 띄운다.
3. 항목이 실패하면 그 항목에 딸린 후속 항목만 `skipped`로 두고, 무관한 항목은 계속 돈다.
4. 작업 에이전트의 "완료"는 `review` 상태다. 조율 에이전트가 확인한 뒤 `done`이 된다.
5. 빌드와 테스트는 조율 에이전트만 돌린다. 작업 에이전트가 동시에 돌리면 서로 간섭한다.

### 3.5 작업 에이전트 격리
- 메타: 작업 에이전트마다 내부 식별자를 `sessionId`로 넘겨 메타 파일을 분리한다. 형태는 `{sessionId}__{팀실행 구분값}_w1`이다.
  - `{sessionId}_`로 시작해야 한다. 터미널 취소 접두사 규칙과 맞물린다.
  - 팀 실행 구분값을 넣어 이전 팀 실행의 메타를 물려받지 않게 한다.
  - 전체 길이는 64자 이하로 둔다. 파일 이름 키가 64자에서 잘린다.
  - 팀 실행이 끝나면 작업 에이전트의 메타 파일을 지운다.
- 고정 제약과 고정 사실: 팀 실행기가 부모 대화의 제약과 고정 사실을 읽어 작업 에이전트에 `extraSystemNotes`로 넘긴다.
- 브라우저: 작업 에이전트에 `browserRouting: 'background'`를 넘겨 격리 브라우저만 쓰게 한다. 사용자에게 보이는 브라우저는 조율 에이전트만 쓴다.
- 도구: 작업 에이전트에서 `memory_propose`, `scheduler_*`, `conversation_image_get`을 뺀다.
- 되돌리기 (16차 확정, 2.16): 수정은 즉시 디스크에 적용하고 수락·거부 화면은 두지 않는다. 되돌리기는 조율 에이전트가 `workspace_rollback`으로 한다.
  - 팀 실행기가 부모 `sessionId` 키로 팀 지점 하나를 소유한다. `workspace_rollback`이 대화 `sessionId` 키의 지점만 찾기 때문이다. 조율 에이전트는 부모 `sessionId`로 돌므로 이 지점을 찾을 수 있다.
  - 작업 에이전트는 자동 지점을 따로 만들지 않고, 파일을 처음 수정하기 직전에 팀 실행기에 그 파일의 보관을 요청한다. 지점에 파일을 더 넣는 함수(`extendWorkspaceCheckpoint`)는 단계 0에서 만들었다(2.7). `meta.json`을 통째로 쓰므로 팀 실행기 한 곳에서만 부른다. 이름 바꾸기 쌍 기록도 같다(2.12).
  - 보관은 반드시 수정보다 먼저 끝나야 한다. 새로 만드는 파일도 만들기 전에 요청해야 "없던 경로"로 적히고, 그래야 전체 되돌리기가 그 파일을 지운다(2.16).
  - 작업 에이전트의 도구 목록에서 `workspace_rollback`과 `workspace_checkpoint`를 뺀다. 내부 식별자 키로는 팀 지점을 찾지 못하고, 다른 에이전트의 수정을 되돌려서도 안 된다.
  - 팀 전체를 되돌릴 때는 `paths` 없이 부른다. 항목 하나만 되돌릴 때는 그 항목 `result`의 변경 파일 목록을 `paths`로 넘긴다. 두 항목이 같은 파일을 차례로 고쳤으면 뒤 항목만 되돌릴 수 없다. 지점은 파일마다 첫 상태 하나만 갖는다.
  - 팀 실행기는 결과의 `checkpointId`로 팀 지점의 `id`를 돌려준다. 조율 에이전트는 `id`를 몰라도 도구를 빈 `id`로 불러 목록을 받을 수 있다(2.16).
  - 보관에 실패한 파일(2MB 초과 포함)은 되돌릴 때 지워지지 않고 그대로 남으며 `skipped_paths`로 보고된다(2.7, 2.16). 팀 실행에서 그런 파일의 수정 자체를 거부할지는 따로 정한다.
- 결과 합치기: 팀 실행기가 작업 에이전트의 `mutatedPaths`를 합쳐 결과로 돌려준다. 사용량은 팀 실행기가 작업 에이전트가 끝날 때마다 그 메타의 `lastPerf.usage`를 읽어(오류로 끝났으면 오류 객체에서) 더해 두고, 조율 에이전트가 끝난 뒤 합계를 대화 `sessionId`의 `lastPerf`에 다시 적는다. 호출부가 그 값을 읽기 때문이다(2.5). 메타 정리는 이 뒤에 한다. 적는 방법은 조율 에이전트의 `lastPerf`에서 `usage`만 합계로 바꾸는 것이다. 읽는 쪽이 `usage`만 쓰기 때문이다(2.6). 비용은 에이전트별로 계산한 값을 더한다.
- 셸 명령과 이름 바꾸기: 셸 명령이 바꾼 파일은 변경 파일 목록에도 팀 지점에도 없고 파일 점유 확인도 거치지 않는다(2.8). 첫 버전에서는 작업 에이전트의 `run_terminal`을 읽기 성격의 명령으로 제한할지, 도구 목록에서 뺄지 정해야 한다(6절). `rename_file`은 변경 파일 목록에 들어가지 않고, 이름을 바꾼 뒤 새 경로를 수정한 채로 변경 거부를 하면 파일이 양쪽 경로에서 모두 사라진다(2.9). 이 문제는 단계 0-2에서 실행 루프를 고쳐 풀었다. `rename_file`과 `apply_patch` 이동은 옛 경로와 새 경로를 모두 목록에 넣는다(2.10). 팀 실행기는 따로 더하지 않고 작업 에이전트의 `mutatedPaths`를 그대로 합친다. 부분 거부로 파일이 사라지던 문제는 단계 0-3에서 풀었다. 지점이 이름 바꾸기의 두 경로를 쌍으로 적고 되돌리기가 함께 처리한다(2.12). 팀 실행에서는 쌍 기록도 팀 실행기가 팀 지점에 대신 적어야 한다. 남은 문제는 폴더 이름 바꾸기가 변경 거부로 되돌려지지 않는 것이다(2.11). 첫 버전에서는 작업 에이전트의 폴더 이름 바꾸기를 팀 실행기가 거부하는 것이 안전하다. 폴더 하나가 여러 항목의 `file_scope`에 걸칠 수 있기 때문이기도 하다.
- 비용: 사용량 문맥의 `sessionId`도 부모 것으로 고정한다. `CodeAgentOptions`에 사용량용 식별자를 따로 받는 선택 필드를 추가하고, `purpose`는 `chat` 그대로 둔다. `purpose`가 닫힌 타입이고 화면이 모르는 값을 영문 키로 그리기 때문이다(2.4). 에이전트별 비용이 필요하면 사용량 기록에 에이전트 식별자 열을 따로 추가한다. 첫 버전에서는 넣지 않고, 작업판 항목의 `result`에 모델과 토큰 수를 적는 것으로 대신한다. 내부 식별자를 그대로 두면 사용량 화면에 제목 없는 행이 생긴다(2.3).
- 정리: 팀 실행이 끝나면 작업 에이전트의 실행 메타, 턴 문맥 파일, 증거 폴더, 브라우저 산출물 폴더를 지운다.
- 대화 기록: 조율 에이전트의 결과만 호출부가 저장한다. 작업 에이전트는 `runCodeAgent`로 직접 띄우므로 저장 경로를 타지 않는다.
- 모델 상태: `lane`을 작업 에이전트별로 다르게 준다.
- 파일: 수정 도구 실행 직전에 팀 실행기가 경로를 확인해, 다른 에이전트가 점유한 범위면 거부한다.

### 3.6 모델 배분
- 항목에는 모델 이름이 아니라 `category`를 적는다.
- `category` → 모델, 대체 순서를 설정 파일에 둔다.
- 팀 실행 전체의 비용 상한을 둔다.

### 3.7 이벤트와 승인
- 팀 실행기가 작업 에이전트의 진행 콜백과 승인 콜백을 감싸 에이전트 식별자를 붙여 내보낸다. 이벤트의 `runId`는 부모 것을 쓴다.
- 화면은 `ToolActivityLog`의 행에 에이전트 식별자를 받아 에이전트별로 묶어 보여준다.
- 승인 창에 보낸 에이전트와 항목 제목을 표시한다. 대기 방식은 지금의 순서 대기를 그대로 쓴다. 승인 `id`는 요청마다 고유하므로 대기 코드를 고칠 필요가 없다(2.4).
- 승인 대기 시간은 요청마다 5분이고 넘으면 거절로 처리된다 (`tool-approval.ts:307`). 승인 창은 한 번에 하나만 뜨므로, 뒤에 쌓인 작업 에이전트의 요청은 사용자가 보기도 전에 시간이 지나 거절될 수 있다. 화면이 승인 답을 기다리는 동안 스트림 처리를 멈추므로, 두 번째 요청은 화면에 들어오기도 전에 서버에서 시간이 지날 수 있다(2.5).
- 첫 버전의 조치: 팀 실행기가 승인 콜백을 한 번에 하나씩만 부른다. 서버 타이머가 콜백 안에서 시작하므로, 차례가 온 요청만 시간이 흐른다. 화면 코드를 고치지 않아도 된다. 대신 승인 자동 검토(모델 판단)도 한 줄로 서게 된다.
- 걸음 수·시간 검토: 작업 에이전트에는 검토 콜백(`onStepBudgetExhausted`)을 넘기지 않는다. 작업 에이전트는 걸음 수 상한에서 끝나고 항목은 `failed`가 되며, 다시 맡길지는 조율 에이전트가 정한다. 콜백을 넘기면 승인 차례를 기다린 시간까지 경과 시간으로 잡혀 에이전트마다 검토 모델 호출과 계속 여부 카드가 생긴다(2.6). 팀 실행 전체의 시간·걸음 검토는 조율 에이전트의 콜백 하나로 한다.
- 작업 에이전트의 걸음 수: 콜백이 없으므로 100걸음에서 연장 없이 끝난다(2.8). 팀 실행기는 결과의 `applicationNotice?.kind === 'continuation'`이면 항목을 `failed`로 두고, 결과의 `content`와 변경 파일 목록을 조율 에이전트에게 넘긴다. 예외로 끝난 경우도 `failed`다. 그 밖의 정상 반환은 `review`다. 항목 하나가 100걸음을 넘을 크기면 조율 에이전트가 더 잘게 나눠야 한다.
- 되돌리기 승인: `workspace_rollback`은 승인을 묻는 도구다(`agent-run-helpers.ts:71`의 안내문). 조율 에이전트만 부르므로 승인 줄 세우기와 충돌하지 않는다. 작업 에이전트가 도는 중에 되돌리면 그 에이전트가 읽은 내용과 디스크가 어긋나므로, 팀 실행기는 실행 중인 항목이 없을 때만 되돌리기를 허용한다. 수락·거부 화면은 두지 않는다(2.16).
- 남는 문제: 승인 창이 떠 있는 동안 다른 작업 에이전트의 진행 표시가 멈춘다. 고치려면 화면이 승인 답을 스트림 처리와 따로 기다리게 바꿔야 한다. 단계 3에서 다룬다.

## 4. 단계
| 단계 | 내용 | 확인 방법 |
|---|---|---|
| 0 (완료) | 변경 거부가 지점에 없는 기존 파일을 지우는 버그 수정(2.6, 2.7). 파일마다 첫 수정 직전에 같은 지점에 보관한다. | `tools/verify-parity-p1.mjs`에 2.6의 세 경우 추가, 통과. 실행 루프와 HTTP 라우트를 거친 확인도 통과(2.13, 2.14). 화면은 연결돼 있지 않다(2.14). |
| 0-2 (완료) | `rename_file`과 `apply_patch` 이동이 옛 경로와 새 경로를 변경 파일 목록과 지점 대상에 넣는다(2.9, 2.10). | 2.9의 경우 A·B·C와 `apply_patch` 이동 두 형태를 `tools/verify-parity-p1.mjs`에 추가, 통과. 실행 루프와 HTTP 라우트를 거친 확인도 통과(2.13, 2.14). 화면은 연결돼 있지 않다(2.14). |
| 0-3 (완료) | 변경 검토 창에서 이름 바꾸기의 한쪽 경로만 거부해도 다른 쪽이 함께 되돌려진다(2.11, 2.12). 지점에 쌍을 적는다. | 부분 거부 경우들을 `tools/verify-parity-p1.mjs`에 추가, 통과. 실행 루프와 HTTP 라우트를 거친 확인도 통과(2.13, 2.14). 화면은 연결돼 있지 않아 짝 줄 처리는 도달할 수 없는 코드다(2.14). |
| 0-4 (완료) | 에이전트 도구 `workspace_rollback`이 새로 생긴 파일도 지우고, 경로를 지정할 수 있고, 지점 `id`를 모르면 목록을 돌려준다(2.16). | `tools/verify-mutate-reject-e2e.mjs`에 세 경우 추가, 78개 통과. 도구 실행 함수를 직접 불렀고, 모델이 도구를 고르는 흐름과 승인 카드는 거치지 않았다. |
| 1 | 작업판 형식과 팀 실행기 뼈대. 작업 에이전트 1개로 기존과 같은 결과가 나오는지 본다. | 단위 테스트 |
| 2 | 작업 에이전트 2개 이상 동시 실행. 메타 분리, 파일 점유, 팀 지점 파일 보관, 승인 콜백 한 줄 세우기. | 겹치지 않는 두 항목 동시 수정 테스트. 조율 에이전트의 `workspace_rollback` 뒤 기존 파일이 복원되고 새 파일만 지워지는지 확인 |
| 3 | 이벤트·승인에 에이전트 식별자. 화면 표시. | 화면 확인 |
| 4 | 카테고리 → 모델 표, 비용 상한. | 설정 테스트 |
| 5 | 실패 처리, 중단 후 재시작. | 실패 주입 테스트 |
| 이후 | worktree 격리 | |

## 5. 아직 확인하지 못한 것
- 사용량 화면(`ui/workspace`)의 질문·대화 목록을 그리는 부분. 용도 이름·색 표와 코어의 집계 방식만 읽었다.
- `tools/verify-parity-p1.mjs`의 MCP 설정 검사 2개 실패(2.7). 검사가 낡은 것으로 보이지만 고치지 않았다.
- 도구 연속 실패로 중단하는 경로(`finishKeptRun`)의 결과 모양. 걸음 수 상한 쪽은 8차에서 읽었다(2.8).
- `rename_file`과 `apply_patch` 이동은 10차에서 고쳤다(2.10). 실패한 이름 바꾸기, 변경 검토 창의 표시, 폴더 이름 바꾸기는 11차에서 확인했다(2.11). 부분 거부의 손실은 12차에서 고쳤다(2.12). 실행 루프를 거친 확인은 13차에서 했다(2.13). HTTP 라우트와 모델 대신 승인 경로는 14차에서 했다(2.14). 남은 것은 폴더 안 파일을 수정한 뒤 폴더 이름을 바꾼 경우의 실행 확인이다.
- `apply_patch`가 쓰는 도중 실패했을 때 이미 바뀐 파일이 변경 검토 창에 나오지 않는 것(2.11). 읽고 추론한 것이다.
- 변경 검토 창은 화면에 연결돼 있지 않다(2.14). 화면을 거친 확인은 창을 다시 붙이기 전에는 할 수 없다. 뗀 경위는 15차에서 읽었다(2.15). update 18 커밋 글에는 뗀 이유가 따로 없고, 근거는 `cd7c3b7`의 커밋 글과 ADR-RE-002다. 설치된 배포본이 이 소스와 같은지는 확인하지 않았다.
- 첫 공개부터 update 17까지 저장소 파일 밖에서 `pendingMutateReview`를 채운 코드가 있었는지(2.15). 저장소 파일만 봤다.
- HTTP 라우트 확인(2.14)은 대화와 작업 폴더의 연결을 가짜로 대신했다. 실제 대화 저장소와 프로젝트 저장소를 거친 확인은 없다.
- 모델 대신 승인 경로(2.14)는 `delete_file`로만 탔다. 큰 `write_file`, 큰 `apply_patch`, 실제 판단 모델은 거치지 않았다.
- 이름 바꾸기 뒤 에이전트 도구 `workspace_rollback`으로 되돌린 결과는 16차에 고치고 실행으로 확인했다(2.16). 남은 것은 실제 모델이 지점 목록을 보고 `id`를 골라 다시 부르는지, 승인 카드를 거친 흐름이다.
- 자동 지점의 `id`가 대화 기록 등 다른 경로로 모델에 들어가는지(2.16). 실행 루프의 지점 생성 부분만 읽었다.
- 이전에 만든 지점("없던 경로" 기록 없음)을 도구로 되돌린 결과. 코드로는 복원만 하고 지우지 않는다. 실행하지 않았다.
- 2.13에서 본 두 가지: 실행 루프가 모델에 더 묻는 이유, 자동 읽기 단계의 `BARE_MODULE_READ` 거절.
- `data/logs/agent-perf.jsonl`을 읽는 `.mjs` 도구. 디렉터리 검색에서는 나오지 않았지만 전체 파일 대조는 하지 않았다.
- 이전 차수에서 디렉터리 검색만으로 "없다"고 적은 항목 중 다시 대조하지 않은 것. 되돌리기 지점 목록 라우트는 5차에서 확인했다.
- 대화 저장소의 `questionLabels`, `sessionTitles` 안.
- `core/src/agent` 안의 `sessionId` 검색 목록 전체. 이번까지 읽은 곳 외에 남은 줄이 있다.
- 터미널 취소 접두사 동작과 2.2의 내용 전체는 코드를 읽고 추론한 것이다. 단계 2의 테스트로 확인해야 한다.
- 동시에 도는 셸 명령끼리의 간섭(같은 `node_modules`, 같은 포트, 같은 빌드 산출물). 코드로 막는 장치는 찾지 못했다.

## 6. 정해야 할 것
- 동시 실행 상한의 기본값.
- 작업 에이전트가 작업판에 항목을 직접 추가할 수 있는지, 조율 에이전트에게 요청만 하는지.
- 작업 에이전트의 승인 요청을 사용자에게 그대로 보낼지, 조율 에이전트가 먼저 거를지.
- git 저장소가 아닌 폴더에서 이 모드를 허용할지.
- 작업 에이전트에게 셸 명령(`run_terminal`)을 허용할지. 허용하면 그 명령이 바꾼 파일은 파일 점유, 변경 검토, 되돌리기 어디에도 잡히지 않는다(2.8).
- 사용자가 에이전트를 거치지 않고 화면에서 직접 누르는 되돌리기 단추를 둘지. 수락·거부 창이 아니라 "이 실행 되돌리기" 하나라면 ADR-RE-002 규칙 3과 부딪히는지 따로 판단해야 한다(2.16).
- 화면에 남은 변경 검토 창 코드(`MutateReviewPane`, `pendingMutateReview`)를 지울지. 이 작업에서 화면에 넣었던 수정은 모두 되돌렸고(17차), 남은 것은 원래 있던 코드다. `tools/verify-parity-p1.mjs:89-129`가 소스에 있는지 검사하므로 지우려면 검사도 고쳐야 한다(2.15).
- **확정(16차)**: 되돌리기는 에이전트 도구에 맡긴다(2.16). 아래 줄은 확정 전의 기록이다.
- (확정 전 기록) 팀 실행의 결과를 사용자가 어디서 검토하고 되돌릴지. 변경 검토 창은 지금 화면에 연결돼 있지 않다(2.14). 창을 다시 붙일지, 팀 실행용 화면을 새로 만들지, 되돌리기를 에이전트 도구(`workspace_rollback`)에만 맡길지 정해야 3.5와 3.7의 되돌리기 항목이 확정된다. 앞의 둘은 ADR-RE-002 규칙 3(수락·거부 화면을 두지 않는다)을 뒤집는 결정이 먼저 필요하다(2.15). 권고는 첫 버전을 세 번째 안으로 하고 `workspace_rollback`이 "없던 경로"도 지우게 보완하는 것이다. 이 경우 3.5의 "화면이 지점 `id` 하나만 받는다"는 전제와 3.7의 변경 검토 서술은 "조율 에이전트가 팀 지점 `id` 하나로 되돌린다"로 바꿔 읽는다.
