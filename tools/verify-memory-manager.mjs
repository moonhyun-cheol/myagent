import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMemoryStore } from '../core/dist/memory/user-memory-store.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-manager-'));
try {
  const store = new UserMemoryStore(dir);
  const a = store.add({ scope: 'global', text: 'global rule' });
  const b = store.add({ scope: 'session', session_id: 'chat', text: 'chat rule' });
  const foreign = store.add({ scope: 'project', project_id: 'other', text: 'private' });
  const snapshot = () => readFileSync(path.join(dir, 'user-memory.json'), 'utf8');
  const rejectsWithoutWrite = (input, code) => {
    const before = snapshot();
    assert.throws(() => store.batch(input), (err) => err.code === code);
    assert.equal(snapshot(), before);
  };
  rejectsWithoutWrite({ ids: [a.id, foreign.id], action: 'delete', project_id: 'current' }, 'STALE_SELECTION');
  rejectsWithoutWrite({ ids: [a.id, 'missing'], action: 'disable' }, 'STALE_SELECTION');
  rejectsWithoutWrite({ ids: [], action: 'delete' }, 'INVALID_BATCH');
  rejectsWithoutWrite({ ids: [a.id], action: 'bogus' }, 'INVALID_BATCH');
  rejectsWithoutWrite(null, 'INVALID_BATCH');
  rejectsWithoutWrite({ ids: [a.id], action: 'move', target_scope: 'project' }, 'INVALID_TARGET');
  assert.equal(store.batch({ ids: [a.id, a.id, b.id], action: 'disable', session_id: 'chat' }), 2);
  assert.equal(store.get(b.id).enabled, false);
  const created = store.get(b.id).created_at;
  assert.equal(store.batch({ ids: [a.id, b.id], action: 'move', target_scope: 'project', project_id: 'current', session_id: 'chat' }), 2);
  assert.equal(store.get(b.id).created_at, created);
  assert.equal(store.get(b.id).session_id, null);
  assert.equal(store.get(b.id).enabled, false);
  assert.equal(store.list('current', 'chat').session.length, 0);
  assert.equal(store.list('current', 'chat').project.length, 2);
  const duplicate = store.add({ scope: 'global', text: '  CHAT   rule ' });
  rejectsWithoutWrite({ ids: [b.id], action: 'move', project_id: 'current', target_scope: 'global' }, 'DUPLICATE_TEXT');
  rejectsWithoutWrite({ ids: [b.id, duplicate.id], action: 'move', project_id: 'current', session_id: 'chat', target_scope: 'session' }, 'DUPLICATE_TEXT');
  for (let i = 0; i < 100; i++) store.add({ scope: 'project', project_id: 'full', text: `full ${i}` });
  rejectsWithoutWrite({ ids: [duplicate.id], action: 'move', project_id: 'full', target_scope: 'project' }, 'SCOPE_FULL');
  assert.equal(store.batch({ ids: [a.id, b.id], action: 'enable', project_id: 'current' }), 2);
  assert.equal(store.get(a.id).enabled, true);
  assert.equal(store.batch({ ids: [a.id, b.id], action: 'delete', project_id: 'current' }), 2);
  assert.equal(store.get(a.id), null);
  assert.ok(store.get(foreign.id));
  assert.equal(new UserMemoryStore(dir).get(duplicate.id).text, 'CHAT   rule');
  console.log('PASS memory manager store: atomic validation, scope isolation, move identity/state, dedupe, capacity, batch enable/disable/delete, persistence');
} finally { rmSync(dir, { recursive: true, force: true }); }
