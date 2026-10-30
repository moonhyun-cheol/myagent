// Step-budget review at the per-run cap: reviewer selection, parsing, grant policy (A안), wiring.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const m = await import('../core/dist/agent/step-budget-review.js');

// Reviewer: first candidate from a different vendor than the working model.
assert.equal(m.pickStepBudgetReviewers('claude-opus-4')[0], '~openai/gpt-terra-latest');
assert.equal(m.pickStepBudgetReviewers('anthropic/claude-opus-4.5')[0], '~openai/gpt-terra-latest');
assert.equal(m.pickStepBudgetReviewers('~openai/gpt-luna-latest')[0], '~anthropic/claude-sonnet-latest');
assert.equal(m.pickStepBudgetReviewers('gpt-5.5')[0], '~anthropic/claude-sonnet-latest');
assert.equal(m.pickStepBudgetReviewers('gemini-3-pro')[0], '~openai/gpt-terra-latest');
assert.equal(m.pickStepBudgetReviewers('~openai/gpt-x').at(-1), '~openai/gpt-terra-latest', 'same vendor only as last resort');
assert.equal(m.modelVendor('~google/gemini-pro-latest'), 'google');

// Parsing.
assert.deepEqual(m.parseStepBudgetReview('{"decision":"continue","confidence":0.9,"reason":"ok","instruction":"x"}'),
  { verdict: 'continue', confidence: 0.9, reason: 'ok', instruction: '' });
assert.equal(m.parseStepBudgetReview('```json\n{"decision":"redirect","confidence":2,"reason":"loop","instruction":"고쳐"}\n```').confidence, 1);
assert.equal(m.parseStepBudgetReview('{"decision":"maybe"}'), null);
assert.equal(m.parseStepBudgetReview('not json'), null);

// A안 grant policy: 50 steps, auto at most twice under delegate/autopilot.
assert.equal(m.STEP_BUDGET_EXTENSION, 50);
assert.equal(m.STEP_BUDGET_MAX_AUTO_GRANTS, 2);
const ok = { verdict: 'continue', reviewer: 'OpenRouter/~openai/gpt-terra-latest' };
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'delegate', autoGrantsUsed: 0 }), 'auto');
assert.equal(m.decideStepBudgetGrant({ review: { ...ok, verdict: 'redirect' }, approvalPolicy: 'autopilot', autoGrantsUsed: 1 }), 'auto');
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'delegate', autoGrantsUsed: 2 }), 'ask', 'third extension asks the user');
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'ask', autoGrantsUsed: 0 }), 'ask');
assert.equal(m.decideStepBudgetGrant({ review: { ...ok, verdict: 'stop_ask_user' }, approvalPolicy: 'delegate', autoGrantsUsed: 0 }), 'stop');
assert.equal(m.decideStepBudgetGrant({ review: { verdict: 'stop_ask_user', reviewer: 'unavailable' }, approvalPolicy: 'delegate', autoGrantsUsed: 0 }), 'ask', 'reviewer outage asks, never auto');

// Wall-time limits: 30-minute checkpoints; no automatic grant after an hour.
assert.equal(m.STEP_BUDGET_TIME_CHECK_INTERVAL_MS, 30 * 60_000);
assert.equal(m.STEP_BUDGET_AUTO_GRANT_MAX_ELAPSED_MS, 60 * 60_000);
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'delegate', autoGrantsUsed: 0, elapsedMs: 61 * 60_000 }), 'ask', 'over an hour asks even under delegate');
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'delegate', autoGrantsUsed: 0, elapsedMs: 20 * 60_000 }), 'auto');
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'ask', autoGrantsUsed: 0, elapsedMs: 31 * 60_000, trigger: 'time' }), 'auto', '30-min checkpoint continues on reviewer go-ahead');
assert.equal(m.decideStepBudgetGrant({ review: ok, approvalPolicy: 'autopilot', autoGrantsUsed: 0, elapsedMs: 60 * 60_000, trigger: 'time' }), 'ask', '60-min checkpoint asks');
assert.equal(m.decideStepBudgetGrant({ review: { ...ok, verdict: 'stop_ask_user' }, approvalPolicy: 'ask', autoGrantsUsed: 0, elapsedMs: 31 * 60_000, trigger: 'time' }), 'stop');
assert.equal(m.decideStepBudgetGrant({ review: { verdict: 'continue', reviewer: 'unavailable' }, approvalPolicy: 'delegate', autoGrantsUsed: 0, elapsedMs: 31 * 60_000, trigger: 'time' }), 'ask');
assert.equal(m.formatElapsedMinutes(42 * 60_000), '42분');
assert.equal(m.formatElapsedMinutes(65 * 60_000), '1시간 5분');
assert.equal(m.formatElapsedMinutes(120 * 60_000), '2시간');

// Facts text: request, counts, failures, own progress note; secrets redacted.
const facts = {
  userRequest: '빌드 오류 고쳐줘 api_key=abc123',
  stepsUsed: 100, stepLimit: 100, extensionsGranted: 0,
  actions: [
    { step: 1, tool: 'read_file', ok: true, target: 'core/a.ts' },
    { step: 2, tool: 'run_terminal', ok: false, target: 'npm run build', failure: 'TS2345' },
  ],
  mutatedPaths: ['core/a.ts'], todoSummary: '[doing] fix build', lastModelOutput: '빌드 오류 1건 남음',
};
const text = m.buildStepBudgetFactsText(facts);
assert.match(text, /steps_used: 100\/100/);
assert.match(text, /failed_steps: 1/);
assert.match(text, /run_terminal \[error\] npm run build -> TS2345/);
assert.match(text, /빌드 오류 1건 남음/);
assert.doesNotMatch(text, /abc123/);
assert.doesNotMatch(text, /Resource usage/, 'no resources → no resource section');
assert.match(text, /trigger: steps/);
assert.doesNotMatch(text, /elapsed_minutes/, 'no elapsed → no time line');
const tText = m.buildStepBudgetFactsText({ ...facts, stepsUsed: 40, elapsedMs: 45 * 60_000, trigger: 'time' });
assert.match(tText, /trigger: time/);
assert.match(tText, /elapsed_minutes: 45\.0/);
assert.match(tText, /avg_seconds_per_step: 67\.5/);
assert.match(m.buildStepBudgetSystemPrompt(), /Elapsed wall time is also context/);
assert.match(m.buildStepBudgetSystemPrompt(), /When trigger is time/);

// Resources: host cost estimate reaches the reviewer and the approval-card label.
const priced = m.buildStepBudgetResources({
  input_tokens: 1_200_000, output_tokens: 40_000, cached_input_tokens: 900_000, cache_write_input_tokens: 100_000,
  cache_hit_rate: 0.75, pricing_status: 'priced', total_cost_microusd: 3_420_000,
}, 100);
assert.equal(priced.costUsd, 3.42);
assert.ok(Math.abs(priced.costPerStepUsd - 0.0342) < 1e-9);
const rText = m.buildStepBudgetFactsText({ ...facts, resources: priced });
assert.match(rText, /## Resource usage/);
assert.match(rText, /cache_hit_rate 75\.0%/);
assert.match(rText, /cost_usd_so_far: 3\.4200; cost_per_step_usd: 0\.0342/);
const label = m.formatStepBudgetResourceLabel(priced, 50);
assert.match(label, /입력 1\.20M 토큰 \(캐시 75%\)/);
assert.match(label, /지금까지 약 \$3\.42/);
assert.match(label, /추가 50스텝 예상 약 \$1\.71/);
const unpriced = m.buildStepBudgetResources({
  input_tokens: 5000, output_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0,
  cache_hit_rate: 0, pricing_status: 'unpriced',
}, 100);
assert.equal(unpriced.costUsd, undefined);
assert.match(m.buildStepBudgetFactsText({ ...facts, resources: unpriced }), /cost_usd_so_far: unknown/);
assert.match(m.formatStepBudgetResourceLabel(unpriced), /가격 정보 없음/);
assert.equal(m.formatStepBudgetResourceLabel(undefined), '');
assert.match(m.buildStepBudgetSystemPrompt(), /never stop only because a run is expensive/);

// reviewStepBudget: falls through a failing reviewer, returns unavailable when all fail.
const cqrRoot = path.join(os.tmpdir(), 'verify-step-budget-review');
const store = { resolveProvider: (_id, modelId) => ({ def: { name: 'OpenRouter' }, modelId, baseUrl: 'https://x', secret: { api_key: 'k' }, wireApi: 'chat_completions' }) };
const seen = [];
const r1 = await m.reviewStepBudget({
  providerStore: store, cqrRoot, workingModelId: 'claude-opus-4', facts,
  complete: async ({ model }) => {
    seen.push(model);
    if (model === '~openai/gpt-terra-latest') throw new Error('503');
    return { content: '{"decision":"redirect","confidence":0.8,"reason":"같은 빌드 오류 반복","instruction":"원인부터 읽어라"}' };
  },
});
assert.deepEqual(seen.slice(0, 2), ['~openai/gpt-terra-latest', '~google/gemini-pro-latest']);
assert.equal(r1.verdict, 'redirect');
assert.equal(r1.instruction, '원인부터 읽어라');
const r2 = await m.reviewStepBudget({ providerStore: store, cqrRoot, workingModelId: 'gpt-5', facts, complete: async () => ({ content: 'nope' }) });
assert.equal(r2.reviewer, 'unavailable');
assert.equal(r2.verdict, 'stop_ask_user');
const note = m.formatStepBudgetExtensionNote(r1, 50, 'auto');
assert.match(note, /\+50 스텝, 자동 승인/);
assert.match(note, /지시: 원인부터 읽어라/);
const tNote = m.formatStepBudgetTimeNote(r1, 31 * 60_000, 'auto');
assert.match(tNote, /작업 시간 점검 \(31분 경과, 자동 승인\)/);
assert.match(tNote, /지시: 원인부터 읽어라/);

// Wiring: step loop asks the host at the cap; orchestrator implements A안 with an approval card.
const stepLoop = readFileSync(new URL('../core/src/agent/agent-run-step-loop.ts', import.meta.url), 'utf8');
assert.match(stepLoop, /while \(state\.steps < stepLimit \|\| await extendStepBudget\(\)\)/);
assert.match(stepLoop, /resolveAgentBudgetBand\(state\.steps, stepLimit\)/);
assert.match(stepLoop, /lastModelOutput: \(state\.lastModelOutput \|\| state\.answerBuf\)\.trim\(\),\s*resources,/);
assert.match(stepLoop, /buildStepBudgetResources\(\s*calculateLlmUsageCost\(state\.llmUsage/);
assert.match(stepLoop, /runElapsedMs\(\) >= nextTimeCheckMs/);
assert.match(stepLoop, /if \(!await extendStepBudget\('time'\)\) break;/);
assert.match(stepLoop, /state\.opts\.onStepBudgetExhausted && state\.steps > 0/, 'no handler → no time stop');
assert.match(stepLoop, /elapsedMs,\s*trigger,/);
const orch = readFileSync(new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url), 'utf8');
assert.match(orch, /onStepBudgetExhausted: async/);
assert.match(orch, /tool: 'step_budget'/);
assert.match(orch, /formatStepBudgetResourceLabel\(facts\.resources/);
assert.match(orch, /est_extension_cost_usd/);
assert.match(orch, /decideStepBudgetGrant\(\{ review, approvalPolicy, autoGrantsUsed, elapsedMs, trigger: facts\.trigger \}\)/);
assert.match(orch, /formatStepBudgetTimeNote\(review, elapsedMs, 'auto'\)/);
const wsAgent = readFileSync(new URL('../core/src/chat/modes/workspace-agent.ts', import.meta.url), 'utf8');
assert.match(wsAgent, /onStepBudgetExhausted: callbacks\?\.onStepBudgetExhausted/);

console.log('verify-step-budget-review: ok');
