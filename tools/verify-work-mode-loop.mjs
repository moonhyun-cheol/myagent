#!/usr/bin/env node
/**
 * Model-directed work-plane contract.
 * The runtime exposes the complete tool schema and does not infer work modes
 * from user-message regular expressions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_AGENT_TOOLS } from '../core/dist/agent/tools.js';
import { codingPlanLockEnabled } from '../core/dist/providers/harness-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');

const toolNames = new Set(CODE_AGENT_TOOLS.map(tool => tool.function.name));
for (const name of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'delete_file']) {
  assert.equal(toolNames.has(name), true, `complete code-agent schema must include ${name}`);
}

for (const relative of [
  'core/src/agent/agent-run-loop.ts',
  'core/src/agent/agent-run-helpers.ts',
  'core/src/agent/agent-llm-step.ts',
  'core/src/chat/chat-orchestrator.ts',
]) {
  const source = read(relative);
  assert.doesNotMatch(source, /agent-work-mode|classifyAgentWorkMode|filterToolsForWorkMode/);
}
const orchestrator = read('core/src/chat/chat-orchestrator.ts');
assert.match(orchestrator, /resolveTurnSkillMode/);
assert.doesNotMatch(orchestrator, /CONCEPT_RE/);
const skillFlow = read('core/src/skills/chat-skill-flow.ts');
assert.match(skillFlow, /resolveDefaultOrganizationSkillMode/);
assert.match(skillFlow, /brand_concept/);

assert.equal(codingPlanLockEnabled({}), false);
assert.equal(codingPlanLockEnabled({ MY_AGENT_CODE_PLAN_LOCK: '1' }), true);

console.log('verify-work-mode-loop: ok (model-directed runtime + full tool schema)');
