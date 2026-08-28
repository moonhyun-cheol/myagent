# Residual ops risks — how to clear them

These four were **out of automated 납기 default**. Use this when you need **ops-proven** gates.

## OWUI / code-agent probe timeout (root cause, 2026-08-04)

**Symptom:** status says `API tools probe (25s)` but wait is ~2min; external races abort.

**Cause:** `withApiTimeout` set `timeoutMs: harness.owuiProbeTimeoutMs` (25s), but  
`completeAgentStep` **ignored** `stepOpts.timeoutMs` and always used `AGENT_STEP_TIMEOUT_MS` (600s).  
Native OWUI tools hang → no hard abort at 25s → TEXT sticky never kicks in until far later.

**Fix:** `core/src/agent/agent-llm-step.ts` — honor `stepOpts.timeoutMs` on `chatCompletionWithTools`.

**Agent-only greenfield tips:**
- **Default:** code agent uses `MY_AGENT_CODE_OWUI_PROTOCOL=text` (local TOOL_CALL). No probe delay.
- **Opt-in probe:** `MY_AGENT_CODE_OWUI_PROTOCOL=probe` — 25s native try then sticky TEXT (timeout plumb fixed).
- Path-free 「만들어줘」 soft-seeds `index.html` / `app.js` / `styles.css` / `package.json` / `README.md`.
- Final bubble scrubs residual `TOOL_CALL` / `WIRING_SMOKE` markers; evidence block marks weak ≠ pass.
- Driver: `node tools/lab/agent-only-desktop.mjs`

---

## 1) Playwright browser tools

**Symptom:** lab/browser `skip` — `playwright unavailable`  
**Why:** chromium not under `runtime/playwright` until bootstrap.

**Fix (dev machine):**

```powershell
# from MY Agent root; needs internet + Node
powershell -NoProfile -ExecutionPolicy Bypass -File tools\bootstrap-playwright-if-needed.ps1
# force re-install:
powershell -NoProfile -ExecutionPolicy Bypass -File tools\bootstrap-playwright.ps1 -Root .
```

**Verify:**

```bash
# fails if still missing when env set
set MY_AGENT_LAB_BROWSER=1
npm run lab:skills-tools
# or delivery acceptance browser leg
set MY_AGENT_ACCEPTANCE_BROWSER=1
node tools/lab/delivery-acceptance.mjs
```

**Ship:** employee install can run Playwright optional (`MY_AGENT_INSTALL_SKIP_OPTIONAL=1` skips).
Full install bundles runtime later; **delta does not re-ship browser cache**.

---

## 2) OpenClaw live

**Symptom:** automaton tools only schema/intent dry-run; no Discord side effect.  
**Why:** live path needs adapter URL + token + network; default lab forbids live.

**Fix (ops PC with adapter):**

1. Activation server / vault: `openclaw_adapter.base_url` + `token`  
   or env `OPENCLAW_ADAPTER_BASE_URL` + `OPENCLAW_ADAPTER_TOKEN`  
2. Offline client verify (no side effect if health only):

```bash
node tools/verify-openclaw-adapter-client.mjs
```

3. Dry schema already:

```bash
node tools/lab/runners/automaton-dry.mjs
# via lab: MY_AGENT_LAB_OPENCLAW=1 only marks opt-in; does not fire real jobs
```

4. **Live tool:** one real slash command in shell chat → automaton mode (manual acceptance).

Do **not** auto-fire live tools from CI.

---

## 3) Live OWUI code agent 1 turn

**Symptom:** not in default delivery-acceptance; live smoke may hang or read-only fail under model latency.

**Fix:**

```bash
# skip if no keys (exit 0); fail only with force
node tools/lab/owui-code-agent-smoke.mjs
# require keys + mutate
set MY_AGENT_OWUI_SMOKE_FORCE=1
set MY_AGENT_CODE_AUTOPILOT=1
node tools/lab/owui-code-agent-smoke.mjs
```

If live fails with `mutated: []` but status shows `read_file`: model flake — **re-run once** or do **manual shell chat** once.  
Do not block 납기 on a single flaky cloud turn.

**Manual:** MY Agent → 코드 칩 → 작업 폴더 → `README에 smoke-ok 한 줄` → disk proof.

---

## 4) `predeploy --stage` + missing portable node

**Symptom (old):** `FAIL Portable Node` / pipeline-venv on `deploy/output/stage/app`.  
**Why:** stage from **deferred/slim** install does not embed `runtime/node` until install; old check assumed **full** stage.

**Fix (auto, product):** predeploy now detects absence and passes  
`--node-mode=deferred` / `--venv-mode=deferred` to `verify-publish-bundle`.

**Manual full-tree check** (real full ship only):

```bash
# rebuild full stage with bundled node
npm run publish
node tools/verify-publish-bundle.mjs --app-dir deploy/output/stage/app
# or slim/deferred:
node tools/verify-publish-bundle.mjs --app-dir deploy/output/stage/app --node-mode=deferred --venv-mode=deferred
```

**Delta path** does not use `stage/app` the same way — use `LATEST_DELTA_ZIP.txt` + `verify-delta-apply`.

---

## Quick matrix

| Risk | Clear command | Default 납기 |
|------|----------------|--------------|
| Playwright | bootstrap + `MY_AGENT_LAB_BROWSER=1` lab | skip OK |
| OpenClaw live | vault + manual slash / health probe | dry-run only |
| OWUI 1-turn | `owui-code-agent-smoke.mjs` or UI manual | skip if no key |
| stage node | auto deferred flags in predeploy | fixed |

Re-run default 납기: `npm run lab:delivery-acceptance`  
Ops-complete: browser env + OWUI smoke + optional OpenClaw health.

---

## 5) Full-surface stress (all residual layers)

```powershell
# reuses Desktop CQR_MaxStress_Demo if present; force agent rebuild: $env:MY_AGENT_LAB_SKIP_AGENT='0'
npm run lab:full-surface

# tighten optional failures
$env:MY_AGENT_LAB_BROWSER='1'          # Playwright missing → fail
$env:MY_AGENT_LAB_OPENCLAW='1'         # adapter /health when configured
$env:MY_AGENT_LAB_MARKET_LIVE='1'      # run.ps1 file probe (not full research)
$env:MY_AGENT_LAB_EMBED_FORCE='1'      # warm embed count=0 → fail
npm run lab:full-surface
```

Report: `data/_skill_tool_lab/full-surface-stress-report.json`  
Covers: agent maxstress, Playwright DOM, OpenClaw health+runbook, market capability, shell/UI case matrix, embed/repo-map quality, automaton dry, embed cold, **skill quality honesty**, **pathless greenfield fixture**.

OpenClaw ops detail: `tools/lab/OPENCLAW_RUNBOOK.md`
