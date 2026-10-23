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

// Wiring: step loop asks the host at the cap; orchestrator implements A안 with an approval card.
const stepLoop = readFileSync(new URL('../core/src/agent/agent-run-step-loop.ts', import.meta.url), 'utf8');
assert.match(stepLoop, /while \(state\.steps < stepLimit \|\| await extendStepBudget\(\)\)/);
assert.match(stepLoop, /resolveAgentBudgetBand\(state\.steps, stepLimit\)/);
const orch = readFileSync(new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url), 'utf8');
assert.match(orch, /onStepBudgetExhausted: async/);
assert.match(orch, /tool: 'step_budget'/);
const wsAgent = readFileSync(new URL('../core/src/chat/modes/workspace-agent.ts', import.meta.url), 'utf8');
assert.match(wsAgent, /onStepBudgetExhausted: callbacks\?\.onStepBudgetExhausted/);

console.log('verify-step-budget-review: ok');
