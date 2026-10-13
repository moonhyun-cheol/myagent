#!/usr/bin/env node
// Prompt-cache contract: the system prefix must be byte-identical across turns
// (different user requests) and across steps (TODO ledger changes).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildAgentMessages } = await import('../core/dist/agent/agent-run-helpers.js');
const { prepareAgentContextForRequest, appendTurnContext, isTurnContextMessage } = await import(
  '../core/dist/agent/agent-context-assembler.js'
);
const { AgentEvidenceStore } = await import('../core/dist/agent/agent-evidence-store.js');
const { formatTodoLedgerTurnNote } = await import('../core/dist/agent/agent-todo-ledger.js');

const systemOf = (messages) => messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

const ws = mkdtempSync(path.join(os.tmpdir(), 'my-agent-prefix-'));
try {
  writeFileSync(path.join(ws, 'alpha.ts'), 'export function alphaWidget() { return 1; }\n', 'utf8');
  writeFileSync(path.join(ws, 'beta.ts'), 'export function betaGadget() { return 2; }\n', 'utf8');
  const build = (userMessage) => buildAgentMessages(
    { workspaceRoot: ws, cqrRoot: ws, userMessage, providerId: 'custom', providerStore: {}, sessionId: 'prefix-verify' },
    {}, ['list_directory', 'read_file'], false, null, '', false, false,
  );
  const a = build('alphaWidget 함수 설명해줘');
  const b = build('betaGadget 수정해줘');
  assert.equal(systemOf(a), systemOf(b), 'system prefix must not depend on the user request');
  assert.doesNotMatch(systemOf(a), /alpha\.ts|beta\.ts/, 'workspace snapshot must not be in the system prefix');
  const turnA = a.find(isTurnContextMessage);
  assert.ok(turnA, 'turn context message exists');
  assert.match(String(turnA.content), /alpha\.ts/, 'workspace snapshot moved into turn context');
  assert.equal(a.at(-1).role, 'user');
  assert.equal(a.at(-2), turnA, 'turn context sits right before the current request');

  appendTurnContext(a, formatTodoLedgerTurnNote({ version: 1, todos: [], retainEvidence: [], workingNotes: [], updatedAt: 'x' }));
  assert.match(String(a.find(isTurnContextMessage).content), /TODO ledger \(turn start\)/);
  assert.equal(a.filter(isTurnContextMessage).length, 1, 'sections merge into one turn context message');

  const store = new AgentEvidenceStore({ cqrRoot: ws, runId: 'prefix-verify' });
  const ledger = (n) => ({
    version: 1,
    todos: [{ id: 'T1', text: `task ${n}`, status: 'doing', evidenceRefs: [] }],
    retainEvidence: [], workingNotes: [], updatedAt: new Date(n).toISOString(),
  });
  const req = { userMessage: 'alphaWidget 함수 설명해줘', evidenceStore: store, modelId: 'openai/gpt-5.6-sol' };
  const step1 = prepareAgentContextForRequest({ ...req, phase: 'plan', messages: a, todoLedger: ledger(1) });
  const step2 = prepareAgentContextForRequest({ ...req, phase: 'work', messages: step1.messages, todoLedger: ledger(2) });
  assert.equal(step1.action, 'unchanged');
  assert.deepEqual(step1.messages, step2.messages, 'ledger change must leave the request byte-identical');
  assert.equal(step1.messages.filter((m) => m.role === 'system' && String(m.content).startsWith('## TODO')).length, 1);
  assert.doesNotMatch(systemOf(step2.messages), /task 2/, 'ledger JSON is not in the system prefix');

  const rebuilt = prepareAgentContextForRequest({ ...req, phase: 'retry', messages: step2.messages, todoLedger: ledger(3) });
  assert.equal(rebuilt.action, 'full_rebuild');
  assert.ok(rebuilt.messages.some(isTurnContextMessage), 'rebuild preserves turn context');
  console.log('verify-prompt-prefix-stability: ok');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
