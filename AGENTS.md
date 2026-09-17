# AGENTS.md — MY Agent product memory

Short facts for coding agents. Prefer **build-generated JSON** over memory or RULEBOOK prose.

**Self-edit:** read `core/config/defaults/skills/my-agent-self-edit.md` first. **Other tools (Cursor 등):** `docs/EXTERNAL_AGENT_KNOWLEDGE.md` → RULEBOOK `docs/knowledge-export/01-core.md`.

**RULEBOOK 지식 기준 (2026-09-14 / 제품 캡처 1.1.5, update 53):** 외부
`C:\MY_FULL_AI\RULEBOOK\MY_CUSTOM_CODEX\docs\knowledge-export\01-core.md`가 기본 portable 지식이다.
업데이트·릴리즈 작업은 `02-updates-release.md`, 작업 키트 작업은
`03-work-kit-launcher.md`를 추가로 참조한다. 라이브 코드와 빌드 생성 JSON이 export보다 우선하며,
RULEBOOK 본문을 제품 repo에 복사하거나 `rulebook/` 디렉터리를 만들지 않는다.

## Build-generated facts

- `core/config/defaults/ui-facts.json` — shell title bar / confirm / ChatPane paths
- `core/config/defaults/product-facts.json` — API routes + layout roots
- `manifest.json` — version `1.1.5`, `update_sequence` **53**. Public label `MY Agent {version} (update {N})`. Clients follow monotonic sequence, not SemVer alone.

## Product layout

| Area | Path |
|------|------|
| Product UI | `ui/workspace` at `/` |
| Conversation skill toggle | `ui/workspace/src/components/ChatPane.tsx` composer `+` |
| Shell | `shell/CqrPa.Shell` (`MainWindow.xaml`) |
| Core API | `core/src/routes/dispatch.ts` |
| RULEBOOK (authority) | `../RULEBOOK/MY_CUSTOM_CODEX` — **not in this repo** (ADR-RE-008) |

## Critical product facts

- **Skills:** user-facing activation is only the composer `+` picker backed by `/skills/selectable`; selecting the active skill again turns it off. Work-kit catalog/install internals have no Settings surface.
- **Updates (3 streams — do not merge):** core `channels/stable.json` + idle gate + `MYAgent.Updater`; org module folder swap; work-kit catalog refresh. The former launcher stream is retired. Only the core stream checks automatically at app startup; work-kit catalog and skill/org-module updates are not polled or applied on startup/Settings entry. Idle gate defers core update Yes/No while chat session turns are alive (`session_busy`) or UI reports work (`workspace_busy`). See R-605/R-618 and the WorkKit integration ADR.
- **Org module / Features:** base overlay in company repo; Automaton slash via Organization Feature (`data/organization-features/`) after ops Work Kit apply (ADR-RE-011 / R-625). Organization-module API/install contracts remain available, but opening Settings → 스킬 does not automatically check or apply them.
- **Workspace behavior:** `execution_policy.workspace_behavior` = `agent`|`plan`|`ask`. No regex re-judging from message text. Folder bind does not rewrite `chat`→`web_dev` (RC-013). Default project chat is a soft agent plane (RC-014).
- **Reasoning UI:** Korean 자동/최소/낮음/중간/높음/매우 높음/최고 → wire `auto|minimal|low|medium|high|xhigh|max`; options filtered to the selected model’s supported efforts.
- **Unified Document surface:** Preview「문서」하나에서 읽기·렌더링 편집·원문 편집·diff를 제공한다. 현재 열린 프로젝트 Markdown이 AI 공동편집 대상이며, 선택→composer 확인→requestId 결속 제안→비교→명시 적용/거절 순서다. 적용 전 tab/revision/baseContent/diskConflict 불일치는 자동 적용을 차단한다. AI 메모는 비수정 질의이고, 타챗 공유·첨부·이전 SQLite 문서는 더보기의 별도 이식 기능이다. 프로젝트 Markdown이 본문 SSOT다 (ADR-RE-014).
- **Document status strip (update 37):** path + source badge + editable/dirty + dump hint; views `읽기`/`렌더링 편집`/`원문 편집`/`변경 비교`; default open view = `preview`.
- **Sidebar / skills (update 38):** resizable nav sidebar; composer `+` organization skill picker via `/skills/selectable`.
- **Update 51:** WorkKitLauncher retired; `/launcher/*` 404; launcher update stream/install paths removed; core delta delete-list cleans legacy launcher files; work-kit catalog/install internals are not exposed as a Settings management page.
- **Install asset invariant:** `MYAgent-v{version}-install.zip` is an offline bundle with root `install.bat` plus `app/`. The BAT must reach `app/tools/install/install-ui.ps1` and `install.ps1`. An `app/`-only ZIP is invalid even when the payload binaries exist. Inspect the final ZIP root before publishing or replacing a release asset.
- **Update 50:** CQR_PA tool-call batches (`activityGroupId`), full redacted activity retention, grouped subtask cancellation, unified intermediate-work collapse, project-root Markdown-backed document collaboration, updater permission preflight/failure recovery hardening, and first-install per-user permission probing/fallback. The former separate collaboration surface is unified into「문서」by ADR-RE-014.
- **Update 49:** consecutive tool-failure run stop, work-log `<details>` collapse, caption dblclick restore, narrow chat-first layout.
- **Update 45:** CQR_PA port — automation content outcomes (`success|warning|failed|blocked`) on runs/feed UI; General Work Principles + risk-proportionate verification / active_task acceptance wording.
- **Update 44:** Document toolbar「더보기」menu uses a fixed portal so overflow parents no longer clip it; includes update-43 UI theme/UX polish already on main.
- **Update 43:** CQR_PA feature port (tool activity, SQLite sessions, memory batch, ledger TODO, automation feed focus); per-execution subtask cancellation; additive collaborative Document workspace; safe message Markdown; chat-history keyboard navigation; skill/reasoning/browser visibility; Astra explicit reasoning. Delta apply stops only `MYAgent.exe` whose executable path is under that install root.
- **Update 42:** Organization Features; idle gate `session_busy`/`workspace_busy`; Automaton progress-only status text.
- **Update 41:** strip debug telemetry; model-aware Responses summary; sidebar N/D shortcuts; auto follows visible default provider; tools-plane cleanup.
- **Sidebar tree icons (update 39):** 개인 작업=`ChatTeardropText`, 워크스페이스=`HardDrives`, 프로젝트=`TreeStructure`, 하위 폴더=`FolderSimple`.
- **Agent runtime (CQR SSOT):** `MAX_AGENT_STEPS = 100` sole logical cap (no progressive 30-segment auto-chain). Tool results → Evidence Store; model retains via `todo_update`/`retainEvidence`; Context Assembler before each LLM call; Continuation Snapshot for resume (not chat-message injection). Tools: `todo_update`, `evidence_read` under `active_task`.

## Hard rules (P0)

1. **Do not invent file state** — `read_file` / ui-facts / product-facts before asserting paths or UI.
2. **Title bar ≠ ChatPane** — shell vs workspace are different targets (`ui-facts.json`).
3. **Single product UI** — `ui/workspace` at `/`; conversation skills are toggled only from the composer `+`. `/launcher/*` is removed/404.
4. **Done = evidence** — disk mutate + verification; UI features need click/screen path, not `tsc` alone.
5. **Live agent** — no `evaluateOutcomeGate`, no OpenGate injection, no planner/reviewer chain (ADR-RE-006).
6. **Failure plane** — tool failures must not demote to plain chat.
7. **Index first** — repo map / search before guessing paths.
8. **No rulebook in product tree** — no `rulebook/` folder, no delta zip rulebook (ADR-RE-008).
9. **Document memo ≠ chat** — memo Q&A must not appear as chat bubbles (R-620).
10. **Chat rendering/navigation** — user/assistant text uses safe Markdown; message action payloads remain exact source text. Background keyboard navigation must ignore composer inputs, buttons, links, and other editable controls.
11. **Per-execution cancel** — stop buttons cover `run_terminal`/`run_tests`/`run_diagnostics` only. A cancel must not abort the parent chat or sibling executions. File side effects are not rolled back.
12. **Install ZIP entry point** — a full install asset must contain root `install.bat` and `app/`; verify the final archive, not only the staged `app/`. `app/`-only is not a valid installer.
13. **UI replacement preserves journeys** — merging, replacing, or removing a UI surface requires migrating every user interaction, not only its data/API path. Register release-critical outcomes in `tools/release-critical-ui-journeys.json`; the verifier must exercise the replacement and the final bundle where applicable. Do not delete the old surface until those journeys pass.
14. **Agent-authored patch notes** — every completed user-visible behavior change must add or update one `development` entry in `ui/workspace/src/data/developer-patch-notes.json` in the same work unit. Write user outcomes only; exclude commits, paths, test machinery, internal IDs, and refactors with no user effect. Consolidate duplicates. Never mark `released` without the exact released `manifest.json` version and `update_sequence`; run `npm run verify:developer-patch-notes`.

Full P0 list: RULEBOOK `docs/02_ALWAYS_ON_RULES.md`. On conflict, **live code wins** (ADR-RE-002).

## Where to look

- Chat: `core/src/chat/chat-orchestrator.ts`
- Agent loop: `core/src/agent/agent-run-loop.ts`, `agent-run-step-loop.ts`
- Evidence/TODO: `agent-evidence-store.ts`, `agent-todo-ledger.ts`, `agent-context-assembler.ts`, `agent-continuation-snapshot.ts`
- Tools: `core/src/agent/agent-tool-definitions.ts`, `apply-patch.ts`
- Document AI memo: `ui/workspace/src/components/MarkdownDocument.tsx`, `lib/documentMemo.ts`
- Document surface: `ui/workspace/src/components/MarkdownDocument.tsx`, `DocumentCollaborationPanel.tsx`, `DocumentPortability.tsx`, `core/src/documents/`
- Chat Markdown/navigation: `ui/workspace/src/components/MessageMarkdown.tsx`, `lib/chatHistoryNavigation.ts`
- Shell updates: `shell/CqrPa.Shell/UpdatePollingService.cs`
- Update gate: `core/src/system/update-gate.ts`
