#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { CODE_AGENT_TOOLS } = await import('../core/dist/agent/agent-tool-definitions.js');
const {
  evidenceProjectionForm,
  mergeTodoLedgerUpdate,
} = await import('../core/dist/agent/agent-todo-ledger.js');
const { loadAgentRunMeta, setSessionTodoLedger } = await import('../core/dist/agent/agent-run-meta.js');

const todoTool = CODE_AGENT_TOOLS.find((tool) => tool.function.name === 'todo_update');
assert.ok(todoTool, 'todo_update must be registered');
const schemaText = JSON.stringify(todoTool.function.parameters);
assert.doesNotMatch(schemaText, /"(?:drop|discard|delete)"\s*:/i, 'schema must not expose evidence deletion');
assert.match(schemaText, /retainEvidence/);

const record = (id, observedByModel) => ({
  version: 1,
  evidenceId: id,
  runId: 'verify',
  tool: 'read_file',
  args: { path: `${id}.ts` },
  complete: true,
  fingerprint: id.padEnd(64, '0'),
  ok: true,
  at: new Date(0).toISOString(),
  bytes: 10,
  bodyFile: `data/evidence-runs/verify/${id}.txt`,
  observedByModel,
});
const records = [record('ev_new', false), record('ev_old', true), record('ev_pin', true)];
const current = {
  version: 1,
  todos: [{ id: 'T1', text: 'existing', status: 'doing', evidenceRefs: ['ev_old'] }],
  retainEvidence: [],
  workingNotes: [],
  updatedAt: new Date(0).toISOString(),
};
const merged = mergeTodoLedgerUpdate(current, {
  todos: [{ id: 'T2', text: 'next', status: 'pending', evidenceRefs: [] }],
  retainEvidence: [{ evidenceId: 'ev_pin', form: 'exact', reason: 'needed for mutation' }],
  workingNotes: [{ text: 'comparison note', supports: ['ev_pin'] }],
}, records);
assert.deepEqual(merged.todos.map((todo) => todo.id), ['T1', 'T2'], 'omitted unfinished TODO survives');
assert.equal(evidenceProjectionForm(records[0], merged), 'exact', 'new evidence gets one exact observation');
assert.equal(evidenceProjectionForm(records[1], merged), 'reference', 'unselected observed evidence is only demoted');
assert.equal(evidenceProjectionForm(records[2], merged), 'exact', 'retained evidence follows model hint');

const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-todo-'));
try {
  setSessionTodoLedger(root, 'session', merged);
  assert.deepEqual(loadAgentRunMeta(root, 'session').todoLedger.todos.map((todo) => todo.id), ['T1', 'T2']);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('verify-todo-ledger: ok');
