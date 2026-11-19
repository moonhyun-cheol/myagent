#!/usr/bin/env node
/**
 * Context profile module now carries only the budget-band note (70% / 90%).
 * Phase profiles and tool-result compaction were unused and removed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('core/src/agent/agent-context-profile.ts', 'utf8');
const loop = readFileSync('core/src/agent/agent-run-step-loop.ts', 'utf8');

assert.doesNotMatch(source, /compileAgentStepContext|resolveAgentContextProfile|compactConsumedToolResults/);
assert(loop.includes('resolveAgentBudgetBand'), 'step loop must resolve the budget band');
assert(loop.includes('agentBudgetBandNote'), 'step loop must emit the budget band note');

const {
  resolveAgentBudgetBand,
  resolveAgentBudgetBandThresholds,
  agentBudgetBandNote,
} = await import('../core/dist/agent/agent-context-profile.js');

const t = resolveAgentBudgetBandThresholds({});
assert.deepEqual(t, { converge: 0.7, finalize: 0.9 });
assert.equal(resolveAgentBudgetBand(10, 100, t), null);
assert.equal(resolveAgentBudgetBand(70, 100, t), 'converge');
assert.equal(resolveAgentBudgetBand(90, 100, t), 'finalize');
assert.equal(resolveAgentBudgetBand(5, 0, t), null);
assert.deepEqual(
  resolveAgentBudgetBandThresholds({
    MY_AGENT_BUDGET_CONVERGE_FRACTION: '0.8',
    MY_AGENT_BUDGET_FINALIZE_FRACTION: '0.5',
  }),
  { converge: 0.8, finalize: 0.8 },
  'finalize is clamped to converge',
);
assert.match(agentBudgetBandNote('converge'), /수렴/);
assert.match(agentBudgetBandNote('finalize'), /마감 임박/);
assert.doesNotMatch(agentBudgetBandNote('finalize'), /\d+\s*(?:걸음|steps?)/i, 'raw step count is never shown');

console.log('agent context profiles (budget band): ok');
