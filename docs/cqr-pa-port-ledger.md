# CQR_PA patch-candidates 포팅 원장

`patch-candidates/`는 다른 소유자의 CQR_PA 저장소(`.my_agent_remote/moonhyun-cheol__CQR_PA/`,
`.gitignore` 추적 제외)에만 존재하는 명세 보관소다. 본체(MY Agent)로의 포팅 현황은 이 문서로 추적한다.
CQR_PA 클론 자체는 수정·삭제·push 하지 않는다.

기준: update_sequence 45 (update 45 제거 커밋 `7353973`) 이후 `b4d0725`·`d1bcf41`가 추가한 11개 후보.

| # | 후보 | 상태 | 대상 update | 커밋 |
|---|------|------|-------------|------|
| 1 | 2026-09-09-server-chat-cancel | 이미 반영(스킵) | — | — |
| 3 | 2026-09-10-scheduler-run-outcome-status | 포팅 완료 | 47 | `4750568` |
| 2 | 2026-09-10-conversation-list-chat-focus | 포팅 완료 | 46 | (이 커밋) |
| 7 | 2026-09-09-conversation-status-toast-navigation | 포팅 완료 | 46 | (이 커밋) |
| 4 | 2026-09-09-conversation-token-time-display | 포팅 완료 | 46 | (이 커밋) |
| 5 | 2026-09-09-model-driven-conversation-images | 포팅 완료 | 46 | (이 커밋) |
| 6 | 2026-09-09-unified-workflow-cancel | 포팅 완료 | 46 | (이 커밋) |
| 9 | 2026-09-10-scheduler-queue-cancel-completion-badge | 포팅 완료 | 47 | (이 커밋) |
| 8 | 2026-09-09-scheduler-conversation-window-usability | 포팅 완료 | 47 | (이 커밋) |
| 10 | 2026-09-09-document-top-level-tab | 포팅 완료(구조 차이로 조정) | 48 | (이 커밋) |
| 11 | 2026-09-10-service-terminal-orchestration | (a) 골격 포팅 완료 | 48 | 머신 종속 원본 → 범용 스키마 주도 런너 골격만 이식 |

## #2 conversation-list-chat-focus (포팅 완료)
- 스토어에 `historyFocusNonce` + `requestHistoryFocus()` 추가(`workspaceStore.ts`).
- `ProjectsTree.openSession`가 세션 로드 성공 후 `requestHistoryFocus()` 호출 → 같은 대화 재선택 시에도 포커스 이동.
- `ChatPane`이 nonce를 `requestAnimationFrame`에서 소비해 이력 영역(`scrollRef`)에 포커스.
- `chatHistoryNavigation.tabToComposer()` 추가: 이력 영역 자체 포커스 상태의 보조키 없는 `Tab` -> 입력창(`draftInputRef`)으로 이동, 기본 탭 이동 차단. 메시지 내부 인터랙션 요소의 Tab은 기존 접근성 유지.
- 이력 영역 `aria-keyshortcuts`에 `Tab` 추가.
- 검증: `ui/workspace` `tsc -b` exit 0, `npm run build` exit 0.

## #4 conversation-token-time-display (포팅 완료)
- 설정 모달에 `대화` 범주 신설: `대화 표시` 페이지에서 `사용 토큰 표시`·`시간 정보 표시` 토글(둘 다 기본 꺼짐, PC 로컬 저장). `SettingsConversationPage.tsx` + `SettingsModal.tsx` nav 항목.
- 로컬 설정/이벤트: `lib/conversationDisplayPreferences.ts` (localStorage `my-agent.conversation-display` + CustomEvent + `useSyncExternalStore` 훅). 변경 시 열려 있는 대화 화면에 즉시 반영.
- 토큰 사용량 배선:
  - `SessionMessage.usage?: { input_tokens?; output_tokens? }` 신설(`core .../sessions/types.ts`).
  - `CloudChatService.complete/completeStream`가 provider `CompletionResult.usage`(prompt/completion)를 `{ input_tokens, output_tokens }`로 매핑해 반환.
  - `chat-orchestrator` 비스트림 `handle` + 스트림 클라우드 경로가 assistant 메시지에 usage 저장, 스트림 SSE `done`에 `usage` 첨부.
  - 에이전트 경로: `loadAgentRunMeta().lastPerf.usage`를 마지막 assistant 메시지에 `setLastAssistantUsage()`로 반영 + `done`에 첨부.
- UI: `ChatTurn.usage`(카멜) 신설, 복원 매핑(assistant 턴 = 직전 user.at→요청시각, m.at→완료시각, usage) + `onDone` 라이브 patch. `ChatPane` assistant 버블 하단 메타(`입력 N 토큰 · 요청 hh:mm · 출력 N 토큰 · 완료 hh:mm · 소요 mm:ss`), 각 옵션 꺼짐 시 해당 항목 생략, 진행 중 소요시간은 기존 실시간 시계(`clockNow`) 사용.
- 검증: 코어 `tsc -p tsconfig.json --noEmit` exit 0, `ui/workspace` `npm run build`(tsc -b + vite build) exit 0.

## #7 conversation-status-toast-navigation (포팅 완료)
- 스토어에 `unseenCompletions: Record<string, boolean>` 상태 추가(`workspaceStore.ts`).
  - 완료 알림 시 `activeSessionId !== sid`이면 해당 세션을 미확인으로 표시.
  - `runJob`가 `running` 진입 시 해당 세션 미확인 해제(진행 중 우선).
  - `loadChatSession`가 세션 열람 시 미확인 즉시 해제.
- 완료 토스트에 `targetSessionId` 연결(`userNotifications.ts` 타입 + 알림 payload).
- `ProjectsTree.SessionRow`: 진행 중 = `CircleNotch` 회전 아이콘, 미확인 완료 = 녹색 원 + 제목 볼드. 진행 중이 미확인보다 우선.
- `NotificationCenter`: `targetSessionId` 있는 토스트 본문 클릭 → `loadChatSession` + `my-agent:navigate-chat` 이벤트로 채팅 화면 전환, 토스트 닫기/액션 버튼은 `stopPropagation`으로 이동 억제.
- `MainWorkspaceContainer`: `my-agent:navigate-chat` 구독 → `activeSurface='chat'`.
- 검증: `ui/workspace` `npm run build`(tsc -b + vite build) exit 0.

## #9 scheduler-queue-cancel-completion-badge (포팅 완료)
- 실행 상태에 `cancelled` 추가(`core .../scheduler/types.ts`, UI `AutomationRun.status`).
- 대기 취소:
  - `PersonalSchedulerStore.cancelRun(id)`: `queued`만 취소(→`cancelled`+`finished_at`), 아니면 `{ok:false, reason:'not_found'|'not_queued'}`.
  - `markRunRunning(id)`를 상태 확인 포함 원자적 전환으로 변경(`queued`만 `running`, 반환 boolean). 큐 대기 중 취소된 실행은 `false` → executor 미시작.
  - `PersonalSchedulerRuntime.execute`가 `markRunning` false면 executing 증가 없이 early-return.
  - `POST /automations/runs/:id/cancel`: `queued`만 200, 종료/실행중 409, 미존재 404.
  - UI `RunsDashboard`: `queued` 행에만 `취소` 버튼(성공 시 즉시 `cancelled`로 갱신, 오류는 상단 alert).
- 완료 숫자 배지:
  - 기존 피드 `read_at` 활용. `markFeedRead()`/`countUnreadFeed()`(result·error 미읽음) 추가, `POST /automations/feed/read`.
  - `MainWorkspaceContainer`가 10초마다 `listAutomationFeed`로 미읽음 수 계산 → 도크 아이콘 `badgeCount`(기존 `99+` UI). 자동화 화면 진입 시 `markAutomationFeedRead()`로 배지 0 해제.
- 검증: `npm run verify:personal-scheduler`(cancellation/feedBadge 케이스 포함) exit 0, `ui/workspace` `npm run build` exit 0.

## #5 model-driven-conversation-images (포팅 완료)
- 순수 모듈 `core/src/agent/conversation-image-catalog.ts` 신설: 세션 durable 메시지 + 첨부 메타에서 이미지 카탈로그(첨부 id·메시지 위치/시각·파일명·MIME·발신 메시지 excerpt)를 생성. 최신 N=16개로 bounded, SVG·비이미지 제외. 로컬 유사도/키워드 매칭·자동 재첨부 없음(모델이 id로 선택).
- 컨텍스트 주입: `agent-run-helpers.buildAgentMessages`가 `opts.history`로 카탈로그 노트를 시스템 메시지에 추가(멀티모달 노트 다음). 노트는 "metadata only — not pixels" 계약과 `conversation_image_get` 사용법을 명시.
- 툴 `conversation_image_get`(읽기 전용): `agent-tool-definitions`에 정의, `agent-runtime-facts`(생성기+JSON+폴백) read_only 목록에 추가. `agent-tool-execute`가 `AttachmentService.get(id, sessionId)`로 세션 스코프 조회 → `validateConversationImage`로 SVG/비이미지/과대/미존재·타세션(=missing) 거부, 통과 시 원본을 data URL로 반환.
- 멀티모달 전달: 툴 role은 이미지 파트를 담지 못하므로, 실행 결과에 `followUpImage`를 추가하고 `agent-run-step-loop`가 tool 결과 push 직후 이미지 파트를 담은 `user` 턴을 추가해 다음 모델 스텝에 전달. `conversation_image_get`은 병렬 read 대상이 아니라 직렬 경로로 실행됨.
- 검증: 코어 `tsc -p tsconfig.json --noEmit` exit 0. 표적 스크립트 `verify:conversation-image-catalog`(7/7 통과): 카탈로그 생성·SVG 제외·bounding, 메타데이터 계약 노트, 검증 거부 사유, 툴 등록(정의+read_only 팩+facts), executeAgentTool 실 조회+세션 격리(타세션 미조회, data URL 반환), 소스 내 로컬 휴리스틱 부재.

## #8 scheduler-conversation-window-usability (포팅 완료)
- 자동화 편집:
  - 백엔드 PATCH `/automations/tasks/:id` + `saveTask(body, id)`와 클라이언트 `saveAutomationTask(input, id?)`·`buildAutomationTriggers`(`daily_time` 필드)는 본체에 이미 존재 → UI만 신설.
  - `SchedulerSurface`에 `editingTask` 상태 추가. 작업 행 `…` 메뉴에 `수정` 항목(`PencilSimple`) → 기존 값이 채워진 `ScheduleDraft`를 편집 모드로 연다.
  - `draftInitFromTask()`가 트리거에서 폼 초기값 도출: `time.at`→한 번 실행(로컬 datetime 변환), `time.daily_time`+`weekdays`→정기 실행, manual/무트리거→수동. sequence/on_action/condition은 `lockedTriggers`로 트리거 편집 잠금(이름·설명·지시만 수정, 트리거 원본 유지).
  - 저장 시 기존 ID로 PATCH, `enabled`/`misfire_policy`는 기존 값 보존.
- 대화 탐색: `SessionRow` 루트에 `data-session-nav-id` 부여. `ProjectsTree`에 전역 `Ctrl+PageUp/PageDown` 핸들러 — DOM에 실제 렌더된 `[data-session-nav-id]`만 순서대로 수집(접힌 폴더·검색 제외 항목 자동 제외), 현재 활성 행 기준 이전/다음 행의 기존 클릭 경로(`.click()`) 실행. 첫 항목에서 위/마지막에서 아래는 현재 유지.
- 데스크톱 창: `MainWindow.xaml` `WindowChrome.ResizeBorderThickness` 6→10, `MaximizeWorkArea.ApplyChrome` 복원 분기의 동적 복원값도 6→10으로 일치.
- 검증: `ui/workspace` `npm run build`(tsc -b + vite build) exit 0. WPF 2줄 상수 변경은 콘텐츠 검토(명세도 self-contained 빌드 제약 명시).

## #6 unified-workflow-cancel (포팅 완료)
- 개별 실행 중지(명세 §4·5·6)는 본체 `ToolActivityLog`에 이미 구현되어 있었음(`/fs/tool-execution/cancel`, `cancelSessionId`, `cancelRequested`, 연결 종료 후 running 유지). 남은 범위 = **응답↔작업 교차 타임라인 + 세션 저장/복원**.
- 교차 타임라인 모델: `WorkTimelineItem = {kind:'response';text} | {kind:'tool';id}`.
  - 순수 헬퍼 `core/src/sessions/work-timeline.ts` + 클라이언트 미러 `ui/workspace/src/lib/workTimeline.ts`: `pushResponseDelta`(직전 항목이 응답이면 이어붙이고, 도구 뒤면 새 응답 세그먼트), `pushToolMarker`(도착 위치에 도구 기록, 같은 id 재수신은 no-op → 재정렬 없음), `sanitizeWorkTimeline`(복원 검증, 빈 배열/누락은 undefined=레거시 폴백). 세그먼트 8,000자·항목 200개 bound.
- 서버 권위 순서: `SessionStore.pendingWorkTimeline`가 `appendAssistantThought`(응답 델타)·`appendToolActivity`(도구)에서 SSE 도착 순서로 누적 → 체크포인트 드래프트/`append`/`finalizeStoppedRun` 3개 저장 지점에서 assistant 메시지 `work_timeline`에 첨부. 메시지는 sqlite에 전체 JSON 저장되므로 별도 sqlite 매핑 없이 자동 영속·복원. `SessionMessage.work_timeline?`(core+UI 타입) 신설.
- UI: `ChatTurn.workTimeline` 신설. 라이브 리듀서 `onThought`/`onToolActivity`가 클라이언트 헬퍼로 타임라인 유지, 세션 복원 매핑에서 `sanitizeWorkTimeline(m.work_timeline)`로 복원.
- ChatPane 렌더: `turn.workTimeline?.length`면 2단계 패널(reasoning 묶음→도구 묶음) 대신 **평면 교차 타임라인**(응답 세그먼트=muted 텍스트, 도구=단일 `ToolActivityLog rows={[activity]}`)을 도착 순서대로 렌더, 최종 답변은 기존 위치(타임라인 뒤)에 `최종 응답`으로 유지. workTimeline 없는 **레거시 세션은 기존 reasoning details + 하단 ToolActivityLog로 폴백**.
- 검증: 코어 `tsc -p tsconfig.json` + `verify:work-timeline`(7/7: 교차 순서·연속 델타 병합·도구 재수신 무재정렬·도구 뒤 새 세그먼트·sanitize 복원/폴백·core 저장 배선·UI 배선) exit 0, `ui/workspace` `npm run build`(tsc -b + vite build) exit 0. ⚠️ 실제 WebView2 라이브 스트림/복원 표시는 앱 실행 검증 아님(정적·빌드·알고리즘 검증까지).

## #10 document-top-level-tab (포팅 완료 — 구조 차이로 조정)
- **CQR_PA와의 구조 차이(중요)**: CQR_PA는 문서 표면이 협업 문서(`DocumentPane`) 하나뿐이고 상위 `문서` 탭이 비어(미연결) 있어, 그 탭을 `DocumentPane`에 연결하고 협업 문서 하위 탭을 제거하는 작업이었다. 그러나 MY Agent는 문서 표면이 **둘**이다:
  - 상위 `document` 모드 = `MarkdownDocument` (Monaco 기반 **파일 문서** 다중 탭 편집기 — `documentTabs`/`activeDocumentTabId`, R-620 AI 메모/차이 비교/작업폴더 FS 편집, AssetExplorer "문서로 열기" 진입점). **비어 있지 않은 실제 출시 기능.**
  - `작업` 하위 `협업 문서` 탭 = `DocumentPane` (TipTap 세션 협업 문서).
  - 스펙을 문자 그대로 적용하면 상위 `문서` 탭을 `DocumentPane`으로 교체 → `MarkdownDocument` 파일 문서 시스템 전체가 진입점을 잃는 회귀가 발생한다.
- **조정 포팅(회귀 없이 CQR_PA 의도 최대 반영)**:
  - `WorkspaceMode`에 `codocument` 추가(`types.ts`).
  - 상위 Preview 레지스트리에 `협업 문서`(`codocument`, `NotePencil`) 탭 추가 → `작업 / 문서 / 협업 문서 / 미디어 / 웹`. `document`(파일 문서)는 기존대로 유지.
  - `PreviewBody`가 `mode === 'codocument'`일 때 기존 `DocumentPane`을 상위 탭에서 직접 렌더(스크롤 컨테이너로 래핑).
  - `작업`(`WorkspaceObjectsPane`)에서 `협업 문서` 하위 탭과 `DocumentPane` 조건부 렌더 제거 → `최근 작업물 / 파일 / 할 일`만 남김. `WorkspaceObjectTabId`에서 `documents` 제거.
  - `normalizeWorkspaceMode` 허용 목록에 `codocument` 추가(레거시 `canvas`→`document` 보정 유지).
- CQR_PA 수용 기준 대비: #2(중간 하위 탭 없이 상위에서 공동 편집기 열림)·#3(작업 화면에 협업 문서 하위 탭 없음)·#4(문서 기능 전부 상위에서 동일 동작)·#5·#6 충족. **#1(탭 4개 = 작업/문서/미디어/웹)만 미충족** — MY Agent는 CQR_PA에 없는 파일 문서 편집기를 별도로 갖고 있어 탭이 5개(협업 문서 추가)가 되며, 협업 탭 라벨도 `협업 문서`다. 이는 파일 문서 기능 회귀를 피하기 위한 불가피한 편차.
- 검증: `ui/workspace` `npm run build`(tsc -b + vite build) exit 0. ⚠️ 실제 WebView2에서의 탭 전환/문서 편집 상호작용은 앱 실행 검증 아님(정적·빌드 검증까지).

## #11 service-terminal-orchestration — (a) 범용 런너/스키마 골격만 포팅
- **원본은 직접 포팅 불가**: CQR_PA WORK_SPEC은 사내 인프라에 강하게 묶임 — 특정 서비스명(NS_FBE/EVAL), 하드코딩 포트(18349/18000/18080), 절대 경로(`D:\.workspace\NS_FBE\run_local.ps1`, `my_automaton\run_local.ps1`), 고정 자동화 작업 ID(`96c43a09-...`). MY Agent 배포 트리에 이 서비스/경로는 존재하지 않는다.
- **이식 범위 = (a) 범용 골격만**(계획대로). 스펙의 **재사용 가능한 오케스트레이션 계약**만 스키마 주도로 일반화:
  - `tools/commands/start-services.ps1`: 전용 Windows Terminal 창(`MY_AGENT_SERVICES` 기본)에 서비스 탭을 모으는 런너. 헬스 우선 점검(정상 서비스는 재실행/종료/재시작 안 함), 탭 실행 직후 직전 foreground window 복원(포커스 보존), 모든 배치 후 **단 한 번** 최종 활성화. `-WhatIf`·`-NoFinalActivate` 옵션. `pwsh.exe` 우선 → `powershell.exe` fallback. `wt.exe` 부재는 명시적 오케스트레이션 실패(서비스 런처 자체 셸 fallback과 구분).
  - `tools/commands/start-services.schema.json`: 서비스 목록 스키마(`name`/`command` 필수, `tabTitle`/`healthUrl`/`skipIfHealthy`/`workingDirectory` 선택, `terminalWindowName`). 머신 종속 값은 전부 스키마 입력으로 외부화 — 골격엔 하드코딩 없음.
  - `tools/commands/services.example.json`: 플레이스홀더 예제(실제 서비스로 교체용).
- **미이식(범위 밖, (b)~)**: 실제 NS_FBE/EVAL 서비스 런처 연동(`run_local.ps1` `-TerminalWindowName`/`-NoActivate`), 사내 자동화 작업 갱신/일시정지 등 사내 배포 운영 항목. 이들은 MY Agent 제품 저장소 대상이 아니며 필요 시 별도 사내 배포 단위에서 반영해야 한다.
- 검증: `npm run verify:service-orchestration` **12/12 통과** — 스키마 구조/예제 적합성, 골격의 CQR_PA 머신 종속값 부재(경로·포트·ID 정적 스캔), 계약 요소(전용 창 기본값·헬스 우선 스킵·포커스 캡처/복원·단일 최종 활성화·pwsh fallback·wt.exe 실패), 그리고 실제 PowerShell 파서 검사 + `-WhatIf -NoFinalActivate` 드라이런 exit 0. ⚠️ 실제 Windows Terminal 다중 탭 기동/포커스 복원은 앱·환경 실행 검증 아님(정적·파서·드라이런까지).
