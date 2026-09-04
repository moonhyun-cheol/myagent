# AGENTS.md — MY Agent product memory

Short facts for coding agents. Prefer **build-generated JSON** over memory or RULEBOOK prose.

**Self-edit:** read `core/config/defaults/skills/my-agent-self-edit.md` first. **Other tools (Cursor 등):** `docs/EXTERNAL_AGENT_KNOWLEDGE.md` → RULEBOOK `docs/knowledge-export/01-core.md`.

**RULEBOOK 지식 기준 (2026-09-04 / 제품 캡처 1.1.4, update 38):** 외부
`C:\MY_FULL_AI\RULEBOOK\MY_CUSTOM_CODEX\docs\knowledge-export\01-core.md`가 기본 portable 지식이다.
업데이트·릴리즈 작업은 `02-updates-release.md`, WorkKitLauncher 작업은
`03-work-kit-launcher.md`를 추가로 참조한다. 라이브 코드와 빌드 생성 JSON이 export보다 우선하며,
RULEBOOK 본문을 제품 repo에 복사하거나 `rulebook/` 디렉터리를 만들지 않는다.

## Build-generated facts

- `core/config/defaults/ui-facts.json` — shell title bar / confirm / ChatPane paths
- `core/config/defaults/product-facts.json` — API routes + layout roots
- `manifest.json` — version `1.1.4`, `update_sequence` **38**. Public label `MY Agent {version} (update {N})`. Clients follow monotonic sequence, not SemVer alone.

## Product layout

| Area | Path |
|------|------|
| Product UI | `ui/workspace` at `/` |
| Work kit launcher | `shell/WorkKitLauncher` + `ui/work-kit-launcher` at `/launcher/` |
| Shell | `shell/CqrPa.Shell` (`MainWindow.xaml`) |
| Core API | `core/src/routes/dispatch.ts` |
| RULEBOOK (authority) | `../RULEBOOK/MY_CUSTOM_CODEX` — **not in this repo** (ADR-RE-008) |

## Critical product facts

- **Work kits:** `WorkKitLauncher.exe` — catalog feed, per-shelf install, apply. No work-kit UI in Settings.
- **Updates (4 streams — do not merge):** core `channels/stable.json` + idle gate + `MYAgent.Updater`; launcher `launcher-stable.json` + `--apply-update`; org module folder swap; work-kit catalog refresh. See R-605/R-617/R-618, ADR-RE-007.
- **Org module:** overlay loader in core; content in company repo. Settings → 스킬 for manual check/apply.
- **Workspace behavior:** `execution_policy.workspace_behavior` = `agent`|`plan`|`ask`. No regex re-judging from message text. Folder bind does not rewrite `chat`→`web_dev` (RC-013). Default project chat is a soft agent plane (RC-014).
- **Reasoning UI:** Korean 자동/최소/낮음/중간/높음/매우 높음/최고 → wire `auto|minimal|low|medium|high|xhigh|max`; options filtered to the selected model’s supported efforts.
- **Document AI memo (R-620):** Preview「문서」→ 선택 → AI에게 묻기. Answer stays in floating AI memo (draggable; collapse → red corner reopen). **Not** ChatPane bubbles. Call uses ask + `uiHidden` / `documentMemo.ts`.
- **Document status strip (update 37):** path + source badge + editable/dirty + dump hint; views `원문 편집`/`읽기`/`변경 비교`; default open view = `preview`.
- **Sidebar / skills (update 38):** Material Icons distinguish 작업폴더 (`folder`) vs 프로젝트 (`account_tree`); resizable nav sidebar; composer `+` organization skill picker via `/skills/selectable`.
- **Agent runtime (CQR SSOT):** `MAX_AGENT_STEPS = 100` sole logical cap (no progressive 30-segment auto-chain). Tool results → Evidence Store; model retains via `todo_update`/`retainEvidence`; Context Assembler before each LLM call; Continuation Snapshot for resume (not chat-message injection). Tools: `todo_update`, `evidence_read` under `active_task`.

## Hard rules (P0)

1. **Do not invent file state** — `read_file` / ui-facts / product-facts before asserting paths or UI.
2. **Title bar ≠ ChatPane** — shell vs workspace are different targets (`ui-facts.json`).
3. **Single product UI** — `ui/workspace` at `/`. WorkKitLauncher is separate WinExe.
4. **Done = evidence** — disk mutate + verification; UI features need click/screen path, not `tsc` alone.
5. **Live agent** — no `evaluateOutcomeGate`, no OpenGate injection, no planner/reviewer chain (ADR-RE-006).
6. **Failure plane** — tool failures must not demote to plain chat.
7. **Index first** — repo map / search before guessing paths.
8. **No rulebook in product tree** — no `rulebook/` folder, no delta zip rulebook (ADR-RE-008).
9. **Document memo ≠ chat** — memo Q&A must not appear as chat bubbles (R-620).

Full P0 list: RULEBOOK `docs/02_ALWAYS_ON_RULES.md`. On conflict, **live code wins** (ADR-RE-002).

## Where to look

- Chat: `core/src/chat/chat-orchestrator.ts`
- Agent loop: `core/src/agent/agent-run-loop.ts`, `agent-run-step-loop.ts`
- Evidence/TODO: `agent-evidence-store.ts`, `agent-todo-ledger.ts`, `agent-context-assembler.ts`, `agent-continuation-snapshot.ts`
- Tools: `core/src/agent/agent-tool-definitions.ts`, `apply-patch.ts`
- Document AI memo: `ui/workspace/src/components/MarkdownDocument.tsx`, `lib/documentMemo.ts`
- Shell updates: `shell/CqrPa.Shell/UpdatePollingService.cs`, `WorkEnvironmentUpdatePollingService.cs`
- Update gate: `core/src/system/update-gate.ts`
