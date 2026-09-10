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
| 5 | 2026-09-09-model-driven-conversation-images | 대기 | 46 | — |
| 6 | 2026-09-09-unified-workflow-cancel | 대기(대형/위험) | 46 | — |
| 9 | 2026-09-10-scheduler-queue-cancel-completion-badge | 대기 | 47 | — |
| 8 | 2026-09-09-scheduler-conversation-window-usability | 대기(WPF 셸 포함) | 47 | — |
| 10 | 2026-09-09-document-top-level-tab | 대기 | 48 | — |
| 11 | 2026-09-10-service-terminal-orchestration | 보류 | 48 | `D:\.workspace\...`·포트 하드코딩 → 직접 포팅 불가. 범용화 설계 또는 제외 결정 필요 |

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
