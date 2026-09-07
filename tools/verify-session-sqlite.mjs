import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { sweepSessionTemp } from '../core/dist/sessions/session-temp-gc.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'session-sqlite-'));
const dir = path.join(root, 'data', 'sessions');
mkdirSync(dir, { recursive: true });
const at = '2026-01-01T00:00:00.000Z';
const msg = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `기록 ${i} 🖼`, at });
const attachmentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const legacy = { id: 'legacy', title: '업무 기록', created_at: at, updated_at: at,
  project_id: 'project-a', workspace_project_id: 'workspace-a', preferred_model: 'test/model',
  messages: Array.from({ length: 120 }, (_, i) => msg(i)),
  responses_state: { version: 1, mode: 'client_replay', provider_id: 'p', model_id: 'm', next_message_index: 120, updated_at: at },
};
legacy.messages[0].attachments = [{ id: attachmentId, name: '원본.png', mime: 'image/png', url: `/attachments/${attachmentId}` }];
legacy.messages[1].image_urls = ['/outputs/images/legacy/old.png'];
legacy.messages[1].reasoning = { version: 1, format: 'public_summary', content: '공개 작업 요약' };
const original = JSON.stringify(legacy, null, 2);
writeFileSync(path.join(dir, 'legacy.json'), original);
const imageDir = path.join(root, 'data', 'outputs', 'images', 'legacy');
const attachmentDir = path.join(root, 'data', 'attachments', 'legacy');
mkdirSync(imageDir, { recursive: true }); mkdirSync(attachmentDir, { recursive: true });
writeFileSync(path.join(imageDir, 'old.png'), 'image fixture');
writeFileSync(path.join(attachmentDir, `${attachmentId}_original.png`), 'attachment fixture');
try {
  let store = new SessionStore(dir, root);
  assert.deepEqual(store.load('legacy').messages, legacy.messages);
  assert.deepEqual(store.load('legacy').responses_state, legacy.responses_state);
  assert.equal(readFileSync(path.join(dir, 'legacy.json'), 'utf8'), original);
  for (let i = 120; i < 282; i++) store.append('legacy', msg(i));
  store = new SessionStore(dir, root);
  assert.equal(store.load('legacy').messages.length, 282);
  assert.deepEqual(store.load('legacy').messages[0], legacy.messages[0]);
  assert.equal(store.list()[0].message_count, 282);
  assert.equal(store.list()[0].workspace_project_id, 'workspace-a');
  assert.equal(store.recentMessages('legacy', 20).length, 20);
  assert.equal(store.recentMessages('legacy', 0).length, 0);
  assert.equal(store.recentMessages('legacy', 1)[0].content, msg(281).content);
  assert.equal(store.publicRecord(store.load('legacy')).responses_state, undefined);
  console.log('PASS: JSON byte preservation, metadata/reasoning/attachment migration, 282-message retention, bounded recent');

  let before; let recovered = [];
  do {
    const page = store.messagePage('legacy', 37, before);
    recovered = [...page.messages, ...recovered];
    before = page.next_before;
    if (!page.has_more) break;
  } while (true);
  assert.deepEqual(recovered, store.load('legacy').messages);
  const first = store.messagePage('legacy', 50);
  store.append('legacy', msg(282));
  assert.equal(store.messagePage('legacy', 50, first.next_before).messages.at(-1).content, msg(231).content);
  assert.equal(store.messagePage('missing'), null);
  assert.throws(() => store.messagePage('legacy', 0), /INVALID_MESSAGE_PAGE/);
  assert.throws(() => store.messagePage('legacy', 201), /INVALID_MESSAGE_PAGE/);
  assert.throws(() => store.messagePage('legacy', 50, NaN), /INVALID_MESSAGE_PAGE/);
  console.log('PASS: complete cursor traversal, append between pages, invalid/empty queries');

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { SessionStore } from ${JSON.stringify(new URL('../core/dist/sessions/session-store.js', import.meta.url).href)};
    const s = new SessionStore(${JSON.stringify(dir)}, ${JSON.stringify(root)});
    assert.equal(s.load('legacy').messages.length, 283);
    assert.equal(s.load('legacy').messages[0].attachments[0].id, ${JSON.stringify(attachmentId)});
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  sweepSessionTemp(root, store.loadAll());
  assert.ok(existsSync(path.join(imageDir, 'old.png')));
  assert.ok(existsSync(path.join(attachmentDir, `${attachmentId}_original.png`)));
  console.log('PASS: separate-process restart and old image/attachment files survive GC');

  // Deliberate insert failure verifies metadata and message changes roll back together.
  const dbPath = path.join(dir, 'sessions.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TRIGGER reject_message BEFORE INSERT ON messages
    WHEN NEW.body LIKE '%FAIL_INJECT%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  const previous = store.load('legacy');
  assert.throws(() => store.append('legacy', { role: 'user', content: 'FAIL_INJECT', at }), /injected failure/);
  assert.deepEqual(store.load('legacy'), previous);
  db.exec('DROP TRIGGER reject_message');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  console.log('PASS: atomic rollback, integrity_check, foreign keys');

  store.ensure('policy', { execution_policy: { reasoning: 'high', autopilot: 'on', approval: 'autopilot' } });
  store.setExecutionPolicy('policy', { reasoning: 'medium', autopilot: 'auto', approval: 'delegate' });
  store.saveResponsesState('policy', legacy.responses_state);
  store.saveResponsesState('policy', { ...legacy.responses_state, model_id: 'agent-model' }, 'agent');
  const policyReload = new SessionStore(dir, root);
  assert.deepEqual(policyReload.load('policy').execution_policy, {
    reasoning: 'medium',
    autopilot: 'auto',
    approval: 'delegate',
    workspace_behavior: 'agent',
  });
  assert.deepEqual(policyReload.responsesState('policy', 'p', 'm', 'client_replay'), legacy.responses_state);
  assert.equal(policyReload.load('policy').responses_states.agent.model_id, 'agent-model');
  assert.equal(policyReload.publicRecord(policyReload.load('policy')).responses_states, undefined);
  policyReload.clearResponsesState('policy', 'agent');
  assert.equal(policyReload.load('policy').responses_states.agent, undefined);
  assert.deepEqual(policyReload.load('policy').responses_state, legacy.responses_state);
  console.log('PASS: execution policy and private continuation lanes persist independently');

  const imported = store.importPortable({ conversation: { title: '긴 기록', messages: Array.from({ length: 3000 }, (_, i) => msg(i)) } });
  assert.equal(store.load(imported.id).messages.length, 3000);
  store.rename(imported.id, '수정');
  assert.equal(store.load(imported.id).messages.length, 3000);
  assert.equal(store.popLastTurn(imported.id).removed, 2);
  assert.equal(store.load(imported.id).messages.length, 2998);
  store.replaceWithSummary(imported.id, '요약', '새 요약 챗');
  assert.equal(store.load(imported.id).messages.length, 1);
  assert.equal(store.load('legacy').messages.length, 283);
  assert.ok(store.delete('legacy'));
  store = new SessionStore(dir, root);
  assert.equal(store.load('legacy'), null);
  assert.equal(readFileSync(path.join(dir, 'legacy.json'), 'utf8'), original);
  assert.equal(existsSync(path.join(imageDir, 'old.png')), false);
  assert.equal(store.delete('legacy'), false);
  console.log('PASS: 3000-message import, metadata edits, explicit undo/summary, deletion without JSON resurrection');

  const brokenDir = path.join(root, 'broken'); mkdirSync(brokenDir);
  writeFileSync(path.join(brokenDir, 'bad.json'), '{broken');
  assert.throws(() => new SessionStore(brokenDir, root));
  assert.equal(readFileSync(path.join(brokenDir, 'bad.json'), 'utf8'), '{broken');
  writeFileSync(path.join(brokenDir, 'bad.json'), JSON.stringify({ ...legacy, id: 'bad' }));
  assert.equal(new SessionStore(brokenDir, root).load('bad').messages.length, 120);
  const futureDir = path.join(root, 'future'); mkdirSync(futureDir);
  const future = new DatabaseSync(path.join(futureDir, 'sessions.sqlite'));
  future.exec('PRAGMA user_version = 99'); future.close();
  assert.throws(() => new SessionStore(futureDir, root), /VERSION_UNSUPPORTED/);
  console.log('PASS: corrupt JSON fails closed, repair/retry, future schema refusal');

  // Execute the actual route branch in isolation; no live product data/server used.
  const source = readFileSync(new URL('../core/src/routes/dispatch.ts', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf('      const messagePageMatch ='), source.indexOf('      const sessionMatch ='));
  assert.ok(branch.includes('messagePage('));
  const js = ts.transpileModule(branch, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function('url', 'method', 'sessionStore', 'res', 'sendJson', js);
  const query = (suffix) => run(new URL(`http://test/sessions/${imported.id}/messages${suffix}`), 'GET', store, {}, (_, status, body) => ({ status, body }));
  assert.equal(query('?limit=1').status, 200);
  assert.equal(query('?limit=1').body.messages.length, 1);
  for (const suffix of ['?limit=0', '?limit=201', '?limit=no', '?before=-1', '?before=1.5']) assert.equal(query(suffix).status, 400);
  assert.equal(run(new URL('http://test/sessions/missing/messages'), 'GET', store, {}, (_, status) => status), 404);
  console.log('PASS: actual page route branch success/validation/404 (isolated, not HTTP E2E)');
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('verify-session-sqlite: PASS');
