#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { prepareAgentContextForRequest } = await import(
  '../core/dist/agent/agent-context-assembler.js'
);
const { AgentEvidenceStore } = await import('../core/dist/agent/agent-evidence-store.js');

const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-context-'));
try {
  const store = new AgentEvidenceStore({ cqrRoot: root, runId: 'verify' });
  const old = store.record({
    tool: 'read_file',
    args: { path: 'old.ts' },
    output: 'old exact body',
    ok: true,
  });
  const pinned = store.record({
    tool: 'read_file',
    args: { path: 'pinned.ts' },
    output: 'PINNED_EXACT_BODY',
    ok: true,
  });
  const failure = store.record({
    tool: 'run_tests',
    args: {},
    output: 'TEST_FAILURE_MUST_SURVIVE',
    ok: false,
  });
  store.markObserved([old.evidenceId, pinned.evidenceId, failure.evidenceId]);
  const ledger = {
    version: 1,
    todos: [{ id: 'T1', text: 'repair context assembly', status: 'doing', evidenceRefs: [pinned.evidenceId], nextAction: 'edit assembler' }],
    retainEvidence: [{ evidenceId: pinned.evidenceId, form: 'exact', todoId: 'T1' }],
    workingNotes: [{ todoId: 'T1', text: 'old source is only a reference', supports: [old.evidenceId] }],
    updatedAt: new Date(0).toISOString(),
  };
  const filler = 'x'.repeat(400_000);
  const messages = [
    { role: 'system', content: 'SYSTEM_SECURITY_MUST_SURVIVE' },
    { role: 'user', content: 'original request' },
    { role: 'assistant', content: filler },
    { role: 'tool', tool_call_id: 'old', content: filler },
  ];
  const result = prepareAgentContextForRequest({
    phase: 'retry',
    messages,
    userMessage: 'original request',
    todoLedger: ledger,
    evidenceStore: store,
    modelId: 'openai/gpt-5.6-sol',
  });
  const text = result.messages.map((message) => String(message.content || '')).join('\n');
  assert.equal(result.action, 'full_rebuild');
  assert.match(text, /SYSTEM_SECURITY_MUST_SURVIVE/);
  assert.match(text, /original request/);
  assert.match(text, /repair context assembly/);
  assert.match(text, /PINNED_EXACT_BODY/);
  assert.match(text, /TEST_FAILURE_MUST_SURVIVE/);
  assert.match(text, new RegExp(old.evidenceId));
  assert.doesNotMatch(text, /x{10000}/, 'blind accumulated transcript must not survive rebuild');
  assert.equal(readFileSync(path.join(root, old.bodyFile), 'utf8'), 'old exact body', 'projection never deletes evidence');
  assert.ok(result.projectedEvidenceIds.includes(pinned.evidenceId));
  assert.ok(result.usedChars < filler.length * 2);

  const resumed = prepareAgentContextForRequest({
    phase: 'plan',
    messages: [
      { role: 'system', content: 'SYSTEM_SECURITY_MUST_SURVIVE' },
      { role: 'user', content: '이어서' },
    ],
    userMessage: '이어서',
    todoLedger: ledger,
    evidenceStore: store,
    modelId: 'openai/gpt-5.6-sol',
    forceRebuild: true,
  });
  const resumedText = resumed.messages.map((message) => String(message.content || '')).join('\n');
  assert.equal(resumed.action, 'full_rebuild', 'resume must rebuild even below the utilization threshold');
  assert.match(resumedText, /Runtime context view/);
  assert.match(resumedText, /repair context assembly/);
  assert.match(resumedText, /PINNED_EXACT_BODY/);
  assert.match(resumedText, /TEST_FAILURE_MUST_SURVIVE/);
  console.log('verify-context-assembler: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
