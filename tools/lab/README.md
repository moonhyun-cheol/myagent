# Skill / tool lab

Exercise MY Agent skills + agent tools without a full chat turn.

```bash
npm run lab:skills-tools
node tools/lab/skill-tool-lab.mjs --level=0|1
node tools/lab/skill-tool-lab.mjs --catalog-only
```

| Path | Role |
|------|------|
| `catalog.mjs` | Inventory from dist definitions + skill manifest |
| `runners/tools-direct.mjs` | L1 `executeAgentTool` on isolated fixture |
| `runners/browser-tools.mjs` | Browser pack (Playwright + local HTML) |
| `runners/automaton-dry.mjs` | Automaton schema + intent dry-run |
| `runners/skills-l0.mjs` | Skill registry + verify-skills |
| `runners/skills-l2.mjs` | Routing/inject matrix (`MY_AGENT_LAB_L2=1`) |
| `runners/domain-l1.mjs` | Neutral domain registry and delivery-profile mock |
| `runners/embedding-cold.mjs` | Cold empty-index embeddings golden |
| `delivery-acceptance.mjs` | 납기 검수 (런타임+스위트, `--full-agent` optional) |
| `owui-code-agent-smoke.mjs` | Optional live OWUI 1-turn (skip without keys) |
| `harsh-acceptance.mjs` | Critic build TaskBoard via all code tools + skills/automaton/domain |
| `product-browser-smoke.mjs` | Playwright E2E on harsh-taskboard (needs localhost allow) |
| `agent-only-desktop.mjs` | Live agent-only rebuild of Desktop demo (no tools gap-fill) |
| `drive-desktop-demo.mjs` | Agent + tools gap-fill drive of Desktop demo |
| `realuse-full-check.mjs` | Real-use fixture + **full surface** (tools 전수 / skills L0-L1 / browser dry / coverage 표) — `lab:realuse` |
| `cursor-query-backtest.mjs` | Cursor transcript harvest + offline routing/capability backtest + improvement plan — `lab:cursor-backtest` |
| `cursor-query-live-backtest.mjs` | Live API SSE suite (coding/knowledge/secretary) — `lab:cursor-backtest:live` (`MY_AGENT_API_BASE`, default `:10200`) |
| `user-pattern-catalog.mjs` | Curated ≥50 user question patterns + multi-turn CHAINS |
| `user-pattern-mine.mjs` | Mine Cursor harvest + `data/sessions` → report — `lab:pattern-mine` |
| `pattern-chain-backtest.mjs` | Offline plane/gate score for catalog + chains; `--live` for 3 deep chains — `lab:pattern-chain` |
| `daily-smoke.mjs` | L0 offline + L1 live hard bars (API up) — `lab:daily-smoke` / `lab:daily-smoke:offline` |
| `improve-loop.mjs` | Continuous measure→remediate→rebuild toward score target (default 94) — `lab:improve-loop` |
| `maturity-scorecard.mjs` | **5 dim ≥95** (three_plane / harness_l0 / l1_hardbars / cursor_feel / daily_loop) — `lab:maturity` / `lab:maturity:live` |
| `lab-workspace-bind.mjs` | Live lab Dev workspace bind (product root vs realuse app) |
| `fixtures/toy-workbench/` | Toy project for mutate/market/image chain labs → copied to `data/_toy_workbench` |
| `PERSONAL_PACK.md` | 뼈대 vs `data/` 개인 pack 운영 SOP |
| `fixtures/cqrpa-realuse-app/` | Sample workspace for manual CQR UI QA (`REALUSE_TASKS.md`) |

```bash
npm run lab:realuse              # 픽스처 + API + surface 전수 + 커버리지 표
npm run lab:realuse:deep         # + 범위 밖(UI e2e / agent gates / L2 / shell / OWUI)
npm run lab:realuse:deep-only    # deep pack only
npm run lab:realuse:light        # 픽스처/API/parity only
npm run lab:realuse:loop         # --loops=2 지속 검증
npm run lab:realuse:browser      # Playwright force
CQR_REALUSE_OWUI=1 npm run lab:realuse
```

Reports: `data/_skill_tool_lab/realuse-full-check-report.{md,json}` (Coverage section included).

### Three-plane cadence (coding / knowledge / secretary)

See [`../../rulebook/docs/plans/2026-08-11-three-plane-pa-vision.md`](../../rulebook/docs/plans/2026-08-11-three-plane-pa-vision.md).

```bash
# After capability / work-mode / turn-decision changes — goldens first, then code
npm run verify:capability-policy
npm run verify:work-mode-loop
npm run verify:turn-decision
npm run lab:cursor-backtest

# Weekly + after API restart (dist must include latest core/dist)
$env:MY_AGENT_API_BASE='http://127.0.0.1:10200'
npm run lab:cursor-backtest:live
```

Policy bug fix rule: **add golden or live case first**, then change code. Phrase-only “done” is not accepted.

Personal pack (skills / plugins / MCP survive product updates) — see [`PERSONAL_PACK.md`](PERSONAL_PACK.md):

```bash
npm run pack:personal:export
npm run pack:personal:export -- --dry-run
npm run pack:personal:import
```

| Path | Role |
|------|------|
| `OPS_RESIDUAL_FIXES.md` | How to clear the 4 residual ops risks |
| `IMPROVEMENT_PLAN.md` | Backlog / completion status |
| `RELEASE_CHECKLIST.md` | Ship gate |
| `AGENT_MODULE_FREEZE.md` | Prefer barrels; no new agent-*.ts lightly |

Outputs under `data/_skill_tool_lab/` (gitignored).

Optional later: `MY_AGENT_LAB_BROWSER=1`, `MY_AGENT_LAB_OPENCLAW=1`, L2 live LLM.
