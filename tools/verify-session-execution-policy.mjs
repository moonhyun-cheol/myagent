#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import {
  defaultExecutionPolicyFromConfig,
  normalizeExecutionPolicy,
} from '../core/dist/execution-policy.js';
import { resolveSessionReasoningEffort } from '../core/dist/providers/harness-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-session-policy-'));

try {
  const store = new SessionStore(temp, temp);
  store.ensure('chat-a', { execution_policy: { reasoning: 'high', autopilot: 'on', approval: 'autopilot' } });
  store.ensure('chat-b', { execution_policy: { reasoning: 'low', autopilot: 'off', approval: 'ask' } });
  store.setExecutionPolicy('chat-a', { reasoning: 'medium', autopilot: 'auto', approval: 'delegate' });

  assert.deepEqual(store.load('chat-a')?.execution_policy, { reasoning: 'medium', autopilot: 'auto', approval: 'delegate' });
  assert.deepEqual(store.load('chat-b')?.execution_policy, { reasoning: 'low', autopilot: 'off', approval: 'ask' });
  assert.deepEqual(defaultExecutionPolicyFromConfig({ agent_reasoning: 'high', agent_autopilot: true, approval_delegation: 'safe_local' }), {
    reasoning: 'high',
    autopilot: 'on',
    approval: 'autopilot',
  });
  assert.deepEqual(normalizeExecutionPolicy({ reasoning: 'bad', autopilot: 'bad', approval: 'bad' }), {
    reasoning: 'auto',
    autopilot: 'auto',
    approval: 'ask',
  });
  assert.equal(resolveSessionReasoningEffort('high', {}, { modelId: 'gpt-5.6' }), 'high');
  assert.equal(resolveSessionReasoningEffort('high', {}, { modelId: 'llama3' }), null);
  assert.equal(resolveSessionReasoningEffort('medium', {}, { providerId: 'anthropic', modelId: 'claude-opus-4-8' }), 'medium');
  assert.equal(resolveSessionReasoningEffort('high', {}, { providerId: 'anthropic', modelId: 'claude-3-haiku' }), null);

  const ui = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/cqrClient.ts'), 'utf8');
  const workspace = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
  const orchestrator = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  const anthropic = readFileSync(path.join(root, 'core/src/providers/anthropic-messages.ts'), 'utf8');
  for (const marker of ['chat-execution-policy', 'chat-reasoning-level', 'chat-approval-level']) {
    assert.ok(ui.includes(marker), `chat policy UI marker missing: ${marker}`);
  }
  assert.match(client, /body\.execution_policy = opts\.execution_policy/);
  assert.match(workspace, /executionPolicy: \{ \.\.\.get\(\)\.activeExecutionPolicy \}/);
  assert.match(orchestrator, /type: 'execution_policy'/);
  assert.match(orchestrator, /approvalPolicy === 'autopilot'/);
  assert.match(orchestrator, /approvalPolicy === 'delegate'/);
  assert.match(anthropic, /body\.output_config = \{ effort \}/);
  assert.match(anthropic, /body\.thinking = \{ type: 'adaptive' \}/);
  console.log('session execution policy: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
