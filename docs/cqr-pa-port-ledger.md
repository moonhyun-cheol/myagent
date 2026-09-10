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
| 7 | 2026-09-09-conversation-status-toast-navigation | 대기 | 46 | — |
| 4 | 2026-09-09-conversation-token-time-display | 대기 | 46 | — |
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
