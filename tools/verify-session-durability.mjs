import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { beginChatRun, executeChatRun, cancelChatRun, hasActiveChatRuns } from '../core/dist/chat/chat-runs.js';
import { sseEvent } from '../core/dist/chat/sse.js';

const at = '2026-01-01T00:00:00.000Z';
const message = (role, content) => ({ role, content, at });
const response = () => ({ destroyed: false, writableEnded: false, write() {} });
const activity = { id: 'tool-1', tool: 'run_tests', target: 'fixture', state: 'success',
  startedAt: 1, updatedAt: 2, finishedAt: 2, output: 'PASS (public)', truncated: false };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === '--crash-child') {
  const root = process.argv[3];
  const store = new SessionStore(path.join(root, 'sessions'), root);
  const run = beginChatRun('crash', 'crash-run');
  await executeChatRun(run, undefined, async () => {
    store.beginAssistantThought('crash');
    store.append('crash', message('user', 'crash fixture'));
    store.saveResponsesState('crash', { version: 1, mode: 'client_replay', provider_id: 'p', model_id: 'm', next_message_index: 1, updated_at: at });
    sseEvent(response(), { type: 'token', text: 'obsolete' });
    store.appendAssistantThought('crash', '공개 작업 로그');
    store.appendToolActivity('crash', activity);
    store.appendToolActivity('crash', { ...activity, id: 'tool-2', state: 'running', output: 'in flight' });
    sseEvent(response(), { type: 'content_replace', text: '교체된 본문' });
    sseEvent(response(), { type: 'token', text: ' + 마지막 토큰' });
    // No subsequent SSE: the trailing timer must save the final burst during an idle tool gap.
    await delay(1200);
    process.send({ ready: true });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }, (stopped) => store.finalizeStoppedRun(stopped));
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-durability-'));
  const dir = path.join(root, 'sessions');
  const withDb = (fn, dbPath = path.join(dir, 'sessions.sqlite')) => {
    const db = new DatabaseSync(dbPath);
    try { return fn(db); } finally { db.close(); }
  };
  const drafts = () => withDb((db) => Number(db.prepare('SELECT COUNT(*) AS n FROM assistant_drafts').get().n));
  let child;
  try {
    let store = new SessionStore(dir, root);
    const runCase = async (sid, work, onStopped = (r) => store.finalizeStoppedRun(r)) => {
      const run = beginChatRun(sid, `${sid}-run`);
      await executeChatRun(run, undefined, async () => {
        store.beginAssistantThought(sid);
        store.append(sid, message('user', sid));
        await work(run);
      }, onStopped);
      return run;
    };
    await runCase('normal', async () => {
      sseEvent(response(), { type: 'token', text: 'draft' });
      store.appendAssistantThought('normal', 'normal log');
      store.appendToolActivity('normal', activity);
      assert.equal(store.load('normal').messages.length, 1, 'draft leaked into live model history');
      assert.equal(new SessionStore(dir, root).load('normal').messages.length, 1, 'live owner recovered');
      store.append('normal', message('assistant', 'final'));
      sseEvent(response(), { type: 'token', text: 'late presentation event' });
    });
    assert.equal(drafts(), 0);
    assert.equal(store.load('normal').messages.length, 2);
    assert.equal(store.load('normal').messages[1].status, 'completed');
    assert.equal(store.load('normal').messages[1].reasoning.content, 'normal log');
    assert.deepEqual(store.load('normal').messages[1].tool_activity, [activity]);
    await delay(1100);
    assert.equal(drafts(), 0, 'late timer resurrected a completed draft');
    console.log('PASS: live-owner isolation, draft/context separation, normal commit, late SSE/timer suppression');

    await runCase('cancel', async (run) => {
      sseEvent(response(), { type: 'token', text: 'cancel partial' });
      store.appendAssistantThought('cancel', 'cancel log');
      store.appendToolActivity('cancel', activity);
      cancelChatRun(run.sessionId, run.runId);
    });
    const stopped = store.load('cancel').messages[1];
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.model_exclude, true);
    assert.equal(stopped.content, 'cancel partial');
    assert.deepEqual(stopped.tool_activity, [activity]);
    assert.equal(drafts(), 0);
    await assert.rejects(runCase('failed', async () => {
      sseEvent(response(), { type: 'token', text: 'failed partial' });
      throw new Error('provider failure fixture');
    }), /provider failure fixture/);
    assert.equal(store.load('failed').messages[1].content, 'failed partial');
    assert.equal(store.load('failed').messages[1].model_exclude, true);
    await runCase('no-final', async () => {});
    assert.equal(store.load('no-final').messages[1].status, 'stopped');
    assert.equal(drafts(), 0);
    console.log('PASS: cancellation, thrown failure and missing-final response finalize once');

    await runCase('deleted', async () => {
      sseEvent(response(), { type: 'token', text: 'must not revive' });
      store.delete('deleted');
      sseEvent(response(), { type: 'token', text: 'late' });
    });
    assert.equal(store.load('deleted'), null);
    await runCase('undo', async () => {
      sseEvent(response(), { type: 'token', text: 'must not revive' });
      store.popLastTurn('undo');
    });
    assert.equal(store.load('undo').messages.length, 0);
    assert.equal(drafts(), 0);
    console.log('PASS: deletion and undo cannot resurrect drafts');

    await assert.rejects(runCase('disk-error', async () => {
      sseEvent(response(), { type: 'token', text: 'safe partial' });
      store.appendAssistantThought('disk-error', 'retained log');
      withDb((db) => db.exec(`CREATE TRIGGER reject_finish BEFORE INSERT ON messages
        WHEN NEW.session_id = 'disk-error' AND json_extract(NEW.body, '$.role') = 'assistant'
        BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END;`));
      store.append('disk-error', message('assistant', 'cannot commit'));
    }), /disk failure fixture/);
    assert.equal(hasActiveChatRuns(), false, 'persistence failure leaked admission lock');
    withDb((db) => {
      const row = db.prepare("SELECT body FROM assistant_drafts WHERE session_id = 'disk-error'").get();
      assert.equal(JSON.parse(row.body).reasoning.content, 'retained log');
      db.exec('DROP TRIGGER reject_finish');
      // Simulate a dead owner only for the deliberate failed-write fixture.
      db.prepare("UPDATE assistant_drafts SET owner_pid = ? WHERE session_id = 'disk-error'").run(2147483647);
    });
    store = new SessionStore(dir, root);
    assert.equal(store.load('disk-error').messages.length, 2);
    assert.equal(drafts(), 0);
    console.log('PASS: failed commit retains logs/draft; lock cleanup and later recovery');

    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child', root], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`child exited early: ${code} ${stderr}`); }),
      delay(15000).then(() => { throw new Error(`child readiness timeout: ${stderr}`); }),
    ]);
    assert.equal(ready[0].ready, true);
    assert.equal(new SessionStore(dir, root).load('crash').messages.length, 1, 'another live process recovered');
    withDb((db) => {
      const draft = JSON.parse(db.prepare("SELECT body FROM assistant_drafts WHERE session_id = 'crash'").get().body);
      assert.equal(draft.content, '교체된 본문 + 마지막 토큰', 'trailing checkpoint lost final burst');
    });
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    child = undefined;
    withDb((db) => db.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON messages
      WHEN NEW.session_id = 'crash' AND json_extract(NEW.body, '$.role') = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'recovery failure fixture'); END;`));
    assert.throws(() => new SessionStore(dir, root), /recovery failure fixture/);
    assert.equal(drafts(), 1, 'failed recovery deleted durable draft');
    assert.equal(store.load('crash').messages.length, 1);
    withDb((db) => db.exec('DROP TRIGGER reject_recovery'));
    store = new SessionStore(dir, root);
    const recovered = store.load('crash');
    assert.equal(recovered.messages.length, 2);
    assert.equal(recovered.messages[1].content, '교체된 본문 + 마지막 토큰');
    assert.equal(recovered.messages[1].reasoning.content, '공개 작업 로그');
    assert.deepEqual(recovered.messages[1].tool_activity[0], activity);
    assert.equal(recovered.messages[1].tool_activity[1].state, 'cancelled');
    assert.match(recovered.messages[1].tool_activity[1].output, /실제 작업 결과는 별도 확인/);
    assert.equal(recovered.messages[1].status, 'stopped');
    assert.equal(recovered.messages[1].model_exclude, true);
    assert.equal(recovered.messages[1].application_notice.kind, 'failure');
    assert.equal(recovered.responses_state, undefined);
    assert.equal(recovered.responses_states, undefined);
    assert.equal(new SessionStore(dir, root).load('crash').messages.length, 2);
    assert.equal(drafts(), 0);
    console.log('PASS: actual forced-process termination, trailing token/log/tool recovery, atomic rollback, no duplicate on restart');

    const migrationDir = path.join(root, 'migration');
    mkdirSync(migrationDir);
    const migrationDb = path.join(migrationDir, 'sessions.sqlite');
    withDb((db) => {
      db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, seq));
        CREATE TABLE legacy_imports (filename TEXT PRIMARY KEY); PRAGMA user_version = 1;`);
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run('v1', JSON.stringify({ id: 'v1', title: 'v1', created_at: at, updated_at: at }));
      db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run('v1', 1, JSON.stringify(message('user', 'v1 data')));
      // Keep the original WAL handle open throughout backup/migration.
      assert.equal(new SessionStore(migrationDir, root).load('v1').messages[0].content, 'v1 data');
    }, migrationDb);
    const backupDir = path.join(migrationDir, 'backups');
    const backups = readdirSync(backupDir);
    assert.equal(backups.filter((name) => name.includes('before-v1-to-v2')).length, 1);
    assert.equal(backups.filter((name) => name.includes('daily-')).length, 1);
    const beforePath = path.join(backupDir, backups.find((name) => name.includes('before-v1-to-v2')));
    withDb((db) => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(JSON.parse(db.prepare('SELECT body FROM messages').get().body).content, 'v1 data');
    }, beforePath);
    new SessionStore(migrationDir, root);
    assert.deepEqual(readdirSync(backupDir), backups, 'same-day startup made redundant backups');
    const restoreDir = path.join(root, 'restored'); mkdirSync(restoreDir);
    copyFileSync(beforePath, path.join(restoreDir, 'sessions.sqlite'));
    assert.equal(new SessionStore(restoreDir, root).load('v1').messages[0].content, 'v1 data');
    const rotationDir = path.join(root, 'rotation');
    mkdirSync(path.join(rotationDir, 'backups'), { recursive: true });
    for (let i = 1; i <= 10; i++) {
      copyFileSync(beforePath, path.join(rotationDir, 'backups', `sessions-daily-2001-01-${String(i).padStart(2, '0')}.sqlite`));
    }
    new SessionStore(rotationDir, root);
    assert.equal(readdirSync(path.join(rotationDir, 'backups')).length, 7);
    console.log('PASS: WAL-aware pre-migration snapshot, daily deduplication/7-snapshot retention, actual offline restore');

    const blockedDir = path.join(root, 'blocked-backup'); mkdirSync(blockedDir);
    const blockedDb = path.join(blockedDir, 'sessions.sqlite');
    copyFileSync(beforePath, blockedDb);
    writeFileSync(path.join(blockedDir, 'backups'), 'not a directory');
    assert.throws(() => new SessionStore(blockedDir, root));
    withDb((db) => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1), blockedDb);
    withDb((db) => {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    assert.equal(hasActiveChatRuns(), false);
    console.log('PASS: failed pre-migration backup blocks schema change, integrity/foreign keys');
  } finally {
    if (child) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    rmSync(root, { recursive: true, force: true });
  }
  console.log('verify-session-durability: PASS');
}
