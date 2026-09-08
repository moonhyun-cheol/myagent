#!/usr/bin/env node
/**
 * Memory proposal + TODO authorship contract (authorship-audit MVP).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { UserMemoryStore } = await import('../core/dist/memory/user-memory-store.js');
const { CODE_AGENT_TOOLS } = await import('../core/dist/agent/agent-tool-definitions.js');
const { mergeTodoLedgerUpdate } = await import('../core/dist/agent/agent-todo-ledger.js');
const orchestratorSrc = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
const memoryStoreSrc = readFileSync(path.join(root, 'core/src/memory/user-memory-store.ts'), 'utf8');
const executeSrc = readFileSync(path.join(root, 'core/src/agent/agent-tool-execute.ts'), 'utf8');

assert.doesNotMatch(orchestratorSrc, /autoCaptureMemory\(/);
assert.match(memoryStoreSrc, /autoCapture\([\s\S]*?\{\s*return null;/);
assert.doesNotMatch(memoryStoreSrc, /AUTO_CAPTURE_CUES/);
assert.match(executeSrc, /case 'memory_propose'/);
assert.ok(CODE_AGENT_TOOLS.some((t) => t.function.name === 'memory_propose'), 'memory_propose tool registered');

const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-authorship-'));
try {
  const store = new UserMemoryStore(dir);
  const pending = store.propose({
    scope: 'global',
    text: 'Prefer TypeScript for new modules',
    reason: 'stated preference',
    source_session_id: 's1',
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.enabled, false);
  assert.equal(store.formatForPrompt(), '', 'pending must not enter prompt');

  const again = store.propose({ scope: 'global', text: 'Prefer TypeScript for new modules', reason: 'again' });
  assert.equal(again.id, pending.id, 'identical pending is not recreated');

  const approved = store.approve(pending.id, { text: 'Prefer TypeScript for new modules' });
  assert.ok(approved);
  assert.equal(approved.status, 'active');
  assert.equal(approved.enabled, true);
  assert.match(store.formatForPrompt(), /Prefer TypeScript/);

  assert.throws(
    () => store.propose({ scope: 'global', text: 'Prefer TypeScript for new modules', reason: 'dup active' }),
    (err) => err && err.code === 'DUPLICATE_TEXT',
  );

  const rejected = store.propose({
    scope: 'project',
    project_id: 'p1',
    text: 'Never commit secrets',
    reason: 'policy',
  });
  store.reject(rejected.id);
  assert.throws(
    () => store.propose({ scope: 'project', project_id: 'p1', text: 'Never commit secrets', reason: 'retry' }),
    (err) => err && err.code === 'REJECTED_DUPLICATE',
  );
  assert.doesNotMatch(store.formatForPrompt('p1'), /Never commit secrets/);

  assert.equal(store.autoCapture('이거 기억해줘 중요한 규칙입니다', 'p1'), null);
  assert.equal(store.list('p1').project.filter((e) => e.text.includes('기억해')).length, 0);

  const merged = mergeTodoLedgerUpdate(null, {
    todos: [{ id: 'T1', text: 'ship authorship', status: 'doing', evidenceRefs: [] }],
    retainEvidence: [],
    workingNotes: [],
  }, []);
  assert.equal(merged.todos[0].authoredBy, 'model');
  assert.match(readFileSync(path.join(root, 'core/src/agent/agent-todo-ledger.ts'), 'utf8'), /authoredBy:\s*'model'/);
  assert.doesNotMatch(
    readFileSync(path.join(root, 'ui/workspace/src/lib/useSessionTodos.ts'), 'utf8'),
    /numbered|split\(|\/\\d+\\./,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('verify-memory-todo-authorship: PASS');
