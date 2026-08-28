# AGENTS.md — MY Agent product memory

Short facts for coding agents. Prefer **build-generated** JSON over memory:

- `core/config/defaults/ui-facts.json` — shell title bar / confirm / ChatPane paths
- `core/config/defaults/product-facts.json` — API routes + layout roots
- `manifest.json` — product version `1.0.3`. Public label is `MY Agent {version} (update {N})`. Clients follow monotonic `update_sequence` (now 14), not SemVer. Bump sequence on every signed zip; bump SemVer only for user-facing meaning (patch/minor/major). GitHub update titles come from `formatGitHubReleaseTitle`.
- **Org automaton (회사 모듈):** slash·OpenClaw·Bulbasaur URL은 `MY_CUSTOM_CODEX-COMPANY/agent-module/` (`automaton-tools.manifest.json`, `openclaw-workflow-map.json`, `deploy-overrides.json`). 중립 코어는 overlay **로더만** (`organization-automaton-manifest.ts`, `organization-openclaw-workflow.ts`, `organization-deploy-overrides.ts`).
- **CQR_PA port:** `tools/port-keep-policy.json`. 아카이브는 공유 엔진 버그픽스만 가져온다. 제품 신원·모델 매트릭스·설치/첫실행·공개 엔트리·설정/모델 센터는 덮지 않는다.

## Product layout

| Area | Path | Notes |
|------|------|-------|
| Product UI | `ui/workspace` | React workspace — the only UI at `/` |
| Shell (WPF) | `shell/CqrPa.Shell` | Custom title chrome (`MainWindow.xaml`) |
| Core API | `core/src` | Routes in `core/src/routes/dispatch.ts` |
| Rulebook | `../RULEBOOK/MY_CUSTOM_CODEX` (via `.rulebook-link.yml`) | **GitHub 미포함.** 로컬 generated는 `rulebook/docs/generated/` (gitignore) |

## Hard rules

1. **Do not invent file state.** `read_file` (or live facts) before asserting Title/WindowStyle/confirm/API paths.
2. **UI target map** — title bar ≠ ChatPane. See `rulebook/docs/specs/technical/ui-target-map.md`.
3. **Work modes** — 세션에 작업 폴더가 있거나, standalone이면서 전역 `dev_workspace_root`가 있으면 같은 에이전트 평면을 유지한다. 모델이 읽기·설명·수정과 도구 사용을 판단하고, 로컬은 세션 실행 정책·승인·경로 보안만 집행한다. 문장 정규식으로 작업 모드나 도구 팩을 재판정하지 않는다.
4. **Done = evidence** — **완료 조건 = 디스크·실행 증거.** 변경 경로와 기계 진단은 런타임 메타에 보존하되 사용자 답변에 자동 첨부하지 않는다. 성공한 `tsc`/빌드/진단은 사용자가 요청했거나 실제 성과를 직접 증명할 때만 언급하며, 실패는 모델 수리 루프로 전달한다. skipped ≠ pass. 자동 진단만으로 active task나 UI 기능 완료를 허용하지 않는다. No success claim without mutate + disk probe when markers are claimed. Web HTML/JS: runtime smoke (DOM id ↔ `getElementById`, boot `render*` calls). **UI/shell Acceptance** — PLAN P0에 사용자 클릭·화면 경로 1줄; `tsc`/`dotnet build` alone ≠ 완료. 「연결/연동/인앱에서 열림」은 호출 경로 증거 필수 (`chrome.webview.postMessage` `inAppBrowser.open` 또는 `NavigationStarting`→`OpenInAppBrowser`); `<a href>` alone → PARTIAL (`shell_integration_overclaim`). UI 기능 구현 시 `MY_AGENT_UI_AUTOPILOT` (default on)로 한 실행에서 Acceptance까지 닫기. **Post-mutate syntax:** `write_file`/`edit_file`/`apply_patch` on `.js`/`.json` auto-check (`node --check` / `JSON.parse`); on `.ts`/`.tsx` auto-check duplicate module-scope decls (no tsc spawn); `ERROR: SYNTAX_BROKEN` → repair, not 완료. **매 턴은 미닫힌 Exit Gate 1개만** 실행·검증한다 (전체 재진단·동일 명령 재위임·후속 파이프라인 설계는 그 다음). Review/피드백/구조·리팩토 필요성: short 결론 → 미충족 ≤3 → **Acceptance 단위** 다음 수정 1개 (장문 표 금지). Prefer `product-facts` / `ui-facts` / rulebook / `.gitignore` before calling any policy "미결정"; P0 only with deploy/security evidence. RCA: `rulebook/docs/plans/2026-07-27-agent-exit-gate-rca.md`. **Coding IQ (ADR-006):** Understanding Card → mutate → Exit Gate; OWUI code default `MY_AGENT_CODE_OWUI_PROTOCOL=api`.
5. **Single UI** — product UI changes target `ui/workspace`; `ui/web` and `/legacy` were removed.
6. **Index first** — Repository map + Query search hits + Adjacent code + Embedding retrieval / `query_repo_map` / `search_embeddings` before guessing paths.
7. **Multimodal** — screenshots, pasted logs, and seeded diagnostics are first-class inputs (not UI-only).
8. **Agentic loop** — plan → mutate (atomic `apply_patch`) → verify → repair until pass.
9. **Patch format** — unique `old_text` with context; multi-file patches are all-or-nothing.
10. **Constraint lock** — Before mutating, restate P0 constraints: new-vs-modify, **artifactKind/runtimeSurface**, entry point, data sources, requiredSecrets, do-not-touch paths. Persist/reuse session `lockedConstraints` when present.
11. **Direction reversal** — If the user corrects direction (`반대`, `아니지`, `그게 아니라`), discard the prior design; isolate wrong-modality files under `_web_legacy`/`_legacy`; keep only the revised single flow and rewrite PLAN P0.
12. **Preserve + new** — If the user asks to keep existing and add new, create a separate folder/entry; never rewrite the existing program in place.
13. **Outcome (live vs verify)** — 라이브 에이전트 루프는 `evaluateOutcomeGate()`를 호출하지 않는다. 모델이 도구 없이 산문으로 멈추면 그게 완료다. 로컬은 silent verify, post-mutate 구문 게이트(`ERROR: SYNTAX_BROKEN`), Exit Gate 노트만 집행한다. `evaluateOutcomeGate`는 `tools/verify-*.mjs` 전용. 예전 라이브 outcome-policy 모듈은 제거됨 (`verify-model-directed-runtime.mjs` retired list).
14. **No-tools done / assumed smoke** — 「도구 쓰지 마 + 완료 보고」→ `도구 없이 완료 보고 불가. 미반영.` Assumed smoke tables without command stdout are blocked. Reviews must re-read session-mutated paths.
15. **Session Exit Gate** — `openGate`는 `data/agent-run-meta/`에 persist되고 다음 턴 시스템 노트로 주입된다 (`agent-open-gate.ts`). 라이브 `planMarRoles`/`runMultiAgent`는 항상 `['coder']`라 Critic이 게이트를 열지 않는다. Artifact contract: `agent-artifact-contract.ts` + `domain-connectors.json`. Verify: `verify:artifact-contract` + `verify:domain-registry`. Claim helpers: `agent-claim-gates.ts`. Runtime smoke: `agent-runtime-smoke.ts`.
16. **Do not defer debug to the user** — no 「콘솔 보세요 / app.js 확인해야」; fix in-session. Self-correct status: 「해결 중…」.

## Where to look

- Chat orchestration: `core/src/chat/chat-orchestrator.ts`
- Code agent: `core/src/agent/code-agent.ts` (façade) → `agent-run-loop.ts` / `agent-run-helpers.ts` / `agent-run-types.ts` / `agent-status-report.ts` / `agent-llm-step.ts`
- Workspace index: `core/src/agent/index/` (`public.ts` façade + `repo-map` / embedding / symbol / workspace-index impls; root paths re-export for compat)
- Symbol windows: `core/src/agent/index/agent-symbol-chunks.ts`
- Embeddings (A2 pilot): `core/src/agent/index/agent-embedding-index.ts` + `embedding-sqlite-store.ts` + `core/src/providers/embeddings.ts`
 - local default; cloud: `MY_AGENT_EMBEDDINGS=cloud|auto` + `MY_AGENT_EMBEDDINGS_API_KEY` + `MY_AGENT_EMBEDDINGS_BASE_URL` (+ optional `MY_AGENT_EMBEDDINGS_MODEL`)
 - persist: `MY_AGENT_EMBED_STORE=sqlite` (default, `node:sqlite`) or `json`; scale via `MY_AGENT_EMBED_MAX_FILES` / `MY_AGENT_EMBED_MAX_CHUNKS`
 - disable: `MY_AGENT_EMBEDDINGS=0`
- Tool registry: `agent-tool-definitions.ts` + `agent-tool-registry.ts`; normalize/parse: `agent-tool-normalize.ts`; façade: `tools.ts`
- Agentic planner note: `core/src/agent/agent-planner.ts`
- Outcome gate (verify scripts only): `core/src/agent/agent-outcome-gate.ts` — **not** called from `agent-run-step-loop.ts`
- Post-mutate syntax gate: `core/src/agent/agent-post-mutate-syntax.ts` (`ERROR: SYNTAX_BROKEN` on `.js`/`.json`; duplicate module-scope decls on `.ts`/`.tsx`)
- Diagnostics UI tsc: `run-diagnostics.ts` — when mutate paths include `ui/workspace/src/`, use `npm --prefix ui/workspace exec -- tsc -b` (root tsconfig is core-only)
- Structure / OWUI TEXT: ADR-004 + `rulebook/docs/plans/2026-07-27-agent-structure-improvement-plan.md`
- Multi-agent wrapper (ADR-005): `agent-mar-runtime.ts` — `MY_AGENT_MULTI_AGENT=0`이면 `runCodeAgent` 직행. 기본 on이어도 `planMarRoles`/`runMultiAgent`는 항상 `roles: ['coder']` (`reason: model_directed_single_agent`). `MY_AGENT_MANDATORY_CRITIC`는 라이브 역할 플랜을 바꾸지 않는다.
- **Model-directed runtime:** 작업 의도·도구 선택·완결성은 모델이 판단한다. 로컬 런타임은 전체 도구 스키마, 실행 정책, 승인, 경로 보안, 결과 증거만 관리한다. **Artifact contract:** `agent-artifact-contract.ts` + **domain registry** `domain-connectors.json` / `agent-domain-registry.ts`. Verify: `verify:artifact-contract` + `verify:domain-registry`.
- **Failure plane (ADR-008):** `agent-failure-plane.ts` — infra≠assistant merge; UI never demotes code→chat; mutate without workspace → policy refuse; **fail/stop persist + tool-plane 1 retry + code final-only bubble**. Verify: `verify:failure-plane`
- **Harness:** `core/src/providers/harness-policy.ts` — 사용자가 선택한 reasoning/Autopilot/승인 정책만 적용한다. 요청 문구로 reasoning을 낮추거나 툴콜을 합성하지 않는다. Responses/Anthropic Messages에서는 native tools가 필수이며, `TEXT TOOL_CALL`은 Ollama·명시적 구형 Chat Completions 호환에만 허용한다. 로컬은 경로 보안, 승인, 구문·진단·산출물 증거, 인프라 재시도만 담당한다. **Ollama for coding off by default** (`MY_AGENT_ALLOW_OLLAMA_CODE=1` / `local_only` only); silent OWUI→Ollama fallback off (`MY_AGENT_OLLAMA_FALLBACK=1` opt-in).
- Claim / capability: overclaim·debug-deferral·invented capability gates; self-correct UX 「해결 중…」
- Perf metrics (P2): `core/src/agent/agent-perf-metrics.ts` → session `lastPerf` + `data/logs/agent-perf.jsonl` + bakeoff `summary.env`/`wall_ms`
- Session mutate meta / Exit Gate: `core/src/agent/agent-run-meta.ts` + `agent-open-gate.ts` + **session continuity** (`agent-session-continuity.ts`: bare 「이어서」 only; mid-run meta flush; interrupt → resume Exit Gate; seed `WorkspaceReadGate` only on continuity/openGate; skip Understanding/retrieval-first cold start)
- Reverse-engineering rulebook (runtime-canonical): `.rulebook-link.yml` → `../RULEBOOK/MY_CUSTOM_CODEX`
- Work-mode loop verify: `npm run verify:work-mode-loop` (coding = AGENT 기본; `wantsExplicitPlanFirst` / `MY_AGENT_CODE_PLAN_LOCK` 골든 포함)
- Automaton remote (=Discord OpenClaw): `openclaw-adapter-client.ts` → `POST /cqr/adapter/request` (서버 서명). Token: env or `data/vault/openclaw-adapter.json`.
- Multimodal: `core/src/agent/agent-multimodal.ts`
- Video attachments: `core/src/attachments/video-keyframes.ts` (+ `text-extract.ts`) — ffmpeg keyframes → vision; with attachments, do not `intent-clarify` for missing file/URL (R-067)
- LLM wire log (OpenAI request/response): `MY_AGENT_LLM_LOG=1` → `data/logs/llm-wire.jsonl` (`full` for longer bodies)
- API dispatch: `core/src/routes/dispatch.ts`
- Status: `../RULEBOOK/MY_CUSTOM_CODEX/docs/01_CURRENT_STATUS.md` (로컬 RULEBOOK, GitHub 아님)
- **Project structure:** `rulebook/docs/ops/STRUCTURE.md`
