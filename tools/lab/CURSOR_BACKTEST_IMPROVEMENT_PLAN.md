# Cursor-log backtest → MY Agent improvement plan

Generated: 2026-08-13T02:40:15.447Z

**Product checklist:** absorbed by [three-plane PA vision](../../rulebook/docs/plans/2026-08-11-three-plane-pa-vision.md) (coding / knowledge / secretary Acceptance bars + weekly cadence). Live suite: `npm run lab:cursor-backtest:live` (`:10200`, restart API after build).

## Scope

Offline gate backtest from Cursor agent transcripts + failure-class assistant samples.
Live LLM plane: **not run** (API/vault optional). Offline gate scores only.

## Results (this run)

| Metric | Value |
|--------|-------|
| User routing goldens | 40/40 |
| Bad-assistant catch | 9/9 |

## Feedback

- Harvest: 664 unique user turns from 286 transcript files.
- Seed+harvest suite: 40 questions · routing goldens pass 40/40.
- Bad-assistant catch: 9/9 (must be 100% for capability-denial class).
- Query mix: {"remote_repo":2,"verify_ops":4,"live_fs":2,"explain":2,"mutate":18,"ops_product":2,"other":10}

## Improvement plan (prioritized)

### P0 — Keep green (regression lock)

1. Keep `verify:capability-policy` in `verify:agent`; never delete shell_net / remote-repo goldens.
2. Wire this backtest into lab cadence:
   - `node tools/lab/cursor-query-backtest.mjs` after capability changes
   - optional: npm script `lab:cursor-backtest`
3. Fail CI/local predeploy when bad-assistant catch < 100% for seeded denial class.

### P1 — Routing completeness (from harvest gaps)

1. Expand `looksLikeRemoteRepoInspectTask` if harvest shows GitHub without verb (bare URL only).
2. Expand `looksLikeToolTask` for Korean ops verbs: 「루프 돌려」「백테스트」「검증해」「확인해」 when they imply product verify, not pure chat.
3. When user says 「니가 터미널에」 without URL, still mark tool plane if prior turn had remote URL (session continuity / openGate style).
4. `shouldRunWorkspaceAgent`: ensure harvest mutate + path questions never demote to brand skill.

### P2 — Live response backtest (LLM plane)

1. Start core API + OWUI vault; re-run with `MY_AGENT_CURSOR_BT_LIVE=1`.
2. For each suite item: runCodeAgent once; score:
   - `contentDeniesAvailableCapability(final)` must be false after repair window
   - remote_repo: must call run_terminal or read cloned path
   - mutate: mutateOk or honest partial with markers
3. Store transcripts under `data/_skill_tool_lab/cursor-bt-live/`.
4. Auto-promote failing live replies into BAD_ASSISTANT_SAMPLES.

### P3 — Product UX honesty

1. If no workspace and no global root: policy reply that explains setup — **not** "no terminal forever".
2. HITL Accept on run_terminal: UI copy that public clone is expected after Accept.
3. Surface status: 「가용 능력 거부 환각 — TOOL_CALL 재시도」 remains user-visible thought if product ships thoughts.

### P4 — Continuous harvest

1. Weekly: re-harvest transcripts; drop secrets (paths with \
as, tokens).
2. Cap suite at 40–60; retire flaky pure-chat lines.
3. Track pass rates in `data/_skill_tool_lab/cursor-query-backtest.json` history array.

## Acceptance for "done"

- Offline: user goldens with hard expect ≥ 95%; bad-assistant = 100%.
- Live (when enabled): 0 capability-denial finals on remote_repo + nas class; ≥1 real tool call per toolTask suite item.

## Commands

```powershell
cd <MY Agent>
node tools/lab/cursor-query-backtest.mjs
npm run verify:capability-policy
# later:
# $env:MY_AGENT_CURSOR_BT_LIVE='1'
# node tools/lab/cursor-query-backtest.mjs
```
