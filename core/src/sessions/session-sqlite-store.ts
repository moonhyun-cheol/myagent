import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { SessionMessage, SessionRecord, SessionSummary } from './types.js';

type Row = { body: string; seq: number };
type DraftRow = { session_id: string; run_id: string; owner_pid: number; body: string };

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export interface MessagePage {
  messages: SessionMessage[];
  /** Exclusive sequence cursor, scoped to this session. */
  next_before: number | null;
  has_more: boolean;
}

/** Local-disk store. JSON files remain untouched as migration backups, never live fallbacks. */
export class SessionSqliteStore {
  readonly databasePath: string;

  constructor(private readonly dir: string, private readonly root: string) {
    this.databasePath = path.join(dir, 'sessions.sqlite');
    assertWritablePath(this.databasePath, root);
    mkdirSync(dir, { recursive: true });
    this.withDb((db) => {
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > 2) throw new Error('SESSION_DATABASE_VERSION_UNSUPPORTED');
      if (version > 0 && version < 2) this.backup(db, `before-v${version}-to-v2-${randomUUID()}`);
      db.exec('PRAGMA journal_mode = WAL;');
      this.transaction(db, () => db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE IF NOT EXISTS legacy_imports (filename TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS assistant_drafts (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY (session_id, run_id)
        );
        PRAGMA user_version = 2;
      `));
      // Fail closed: a corrupt source must not silently disappear from the live set (or GC).
      // Each file and its marker commit together; a restart resumes without duplicates.
      for (const filename of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        if (db.prepare('SELECT 1 FROM legacy_imports WHERE filename = ?').get(filename)) continue;
        const rec = JSON.parse(readFileSync(path.join(dir, filename), 'utf8')) as SessionRecord;
        if (!rec || rec.id !== filename.slice(0, -5) || !/^[a-zA-Z0-9_-]{1,64}$/.test(rec.id)
          || !Array.isArray(rec.messages) || typeof rec.title !== 'string'
          || typeof rec.created_at !== 'string' || typeof rec.updated_at !== 'string'
          || rec.messages.some((m) => !m || !['user', 'assistant'].includes(m.role)
            || typeof m.content !== 'string' || typeof m.at !== 'string')) {
          throw new Error(`INVALID_LEGACY_SESSION: ${filename}`);
        }
        this.transaction(db, () => {
          if (!db.prepare('SELECT 1 FROM legacy_imports WHERE filename = ?').get(filename)) {
            if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(rec.id)) this.saveRecord(db, rec);
            db.prepare('INSERT INTO legacy_imports(filename) VALUES (?)').run(filename);
          }
        });
      }
      this.backup(db, `daily-${new Date().toISOString().slice(0, 10)}`);
      this.transaction(db, () => {
        const drafts = db.prepare('SELECT * FROM assistant_drafts').all() as unknown as DraftRow[];
        for (const draft of drafts) {
          // A second store/process must never recover a still-running owner's work.
          if (!processIsAlive(draft.owner_pid)) this.recoverDraft(db, draft);
        }
      });
    });
  }

  /** Consistent WAL-aware snapshot; never copy only the live .sqlite file. Fail closed on backup errors. */
  private backup(db: DatabaseSync, label: string): void {
    const dir = path.join(this.dir, 'backups');
    const target = path.join(dir, `sessions-${label}.sqlite`);
    assertWritablePath(target, this.root);
    mkdirSync(dir, { recursive: true });
    if (existsSync(target)) return;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      db.prepare('VACUUM INTO ?').run(temporary);
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      try {
        if ((snapshot.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') {
          throw new Error('SESSION_BACKUP_INTEGRITY_FAILED');
        }
      } finally { snapshot.close(); }
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
    // Daily snapshots rotate only after a verified replacement. Migration backups are retained.
    const daily = readdirSync(dir).filter((name) => /^sessions-daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort().reverse();
    for (const name of daily.slice(7)) rmSync(path.join(dir, name));
  }

  // Operation-scoped handles avoid leaked locks and allow offline backup after shutdown.
  private withDb<T>(run: (db: DatabaseSync) => T): T {
    assertWritablePath(this.databasePath, this.root);
    const db = new DatabaseSync(this.databasePath);
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      return run(db);
    } finally { db.close(); }
  }

  // Pure reads open read-only so they take no write lock and never mutate/spawn
  // WAL sidecars. Some WAL states (no -shm yet / recovery needed) reject a
  // read-only open or query; these reads are idempotent, so fall back to the
  // writable handle rather than fail a load/list/page spuriously.
  private withDbReadOnly<T>(run: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 5000;'); } catch { /* read-only may reject some pragmas */ }
      return run(db);
    } catch {
      return this.withDb(run);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  private transaction<T>(db: DatabaseSync, run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  private saveRecord(db: DatabaseSync, rec: SessionRecord): void {
    const { messages, ...metadata } = rec;
    db.prepare(`INSERT INTO sessions(id, body) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run(rec.id, JSON.stringify(metadata));
    // Unchanged rows are never rewritten. Explicit undo/summary replacement can remove rows.
    const previous = db.prepare('SELECT seq, body FROM messages WHERE session_id = ? ORDER BY seq').all(rec.id) as unknown as Row[];
    const upsert = db.prepare(`INSERT INTO messages(session_id, seq, body) VALUES (?, ?, ?)
      ON CONFLICT(session_id, seq) DO UPDATE SET body = excluded.body`);
    messages.forEach((message, index) => {
      const body = JSON.stringify(message);
      if (previous[index]?.body !== body) upsert.run(rec.id, index + 1, body);
    });
    db.prepare('DELETE FROM messages WHERE session_id = ? AND seq > ?').run(rec.id, messages.length);
  }

  save(rec: SessionRecord): void {
    this.withDb((db) => this.transaction(db, () => {
      this.saveRecord(db, rec);
      const drafts = db.prepare('SELECT run_id FROM assistant_drafts WHERE session_id = ?').all(rec.id) as { run_id: string }[];
      for (const { run_id } of drafts) {
        if (!rec.messages.some((m) => m.role === 'user' && m.run_id === run_id)
          || rec.messages.some((m) => m.role === 'assistant' && m.run_id === run_id)) {
          db.prepare('DELETE FROM assistant_drafts WHERE session_id = ? AND run_id = ?').run(rec.id, run_id);
        }
      }
    }));
  }

  append(rec: SessionRecord, message: SessionMessage): void {
    this.withDb((db) => this.transaction(db, () => {
      const { messages: _messages, ...metadata } = rec;
      const updated = db.prepare('UPDATE sessions SET body = ? WHERE id = ?').run(JSON.stringify(metadata), rec.id);
      if (!Number(updated.changes)) throw new Error('SESSION_NOT_FOUND');
      db.prepare(`INSERT INTO messages(session_id, seq, body)
        SELECT ?, COALESCE(MAX(seq), 0) + 1, ? FROM messages WHERE session_id = ?`)
        .run(rec.id, JSON.stringify(message), rec.id);
      if (message.run_id) {
        if (message.role === 'user') {
          const draft: SessionMessage = { role: 'assistant', content: '', at: message.at,
            run_id: message.run_id, reply_to_run_id: message.run_id, mode: message.mode };
          db.prepare('INSERT OR IGNORE INTO assistant_drafts(session_id, run_id, owner_pid, body) VALUES (?, ?, ?, ?)')
            .run(rec.id, message.run_id, process.pid, JSON.stringify(draft));
        } else {
          db.prepare('DELETE FROM assistant_drafts WHERE session_id = ? AND run_id = ?').run(rec.id, message.run_id);
        }
      }
    }));
  }

  checkpointDraft(id: string, runId: string, message: SessionMessage): void {
    // UPDATE only: a delayed token cannot resurrect a completed/deleted/undone turn.
    this.withDb((db) => {
      db.prepare('UPDATE assistant_drafts SET body = ? WHERE session_id = ? AND run_id = ? AND owner_pid = ?')
        .run(JSON.stringify(message), id, runId, process.pid);
    });
  }

  finishDraft(id: string, runId: string): void {
    this.withDb((db) => this.transaction(db, () => {
      const draft = db.prepare('SELECT * FROM assistant_drafts WHERE session_id = ? AND run_id = ? AND owner_pid = ?')
        .get(id, runId, process.pid) as DraftRow | undefined;
      if (draft) this.recoverDraft(db, draft);
    }));
  }

  private recoverDraft(db: DatabaseSync, draft: DraftRow): void {
    const row = db.prepare('SELECT body FROM sessions WHERE id = ?').get(draft.session_id) as { body: string } | undefined;
    if (row) {
      const messages = (db.prepare('SELECT body FROM messages WHERE session_id = ? ORDER BY seq').all(draft.session_id) as unknown as Row[])
        .map((m) => JSON.parse(m.body) as SessionMessage);
      if (messages.some((m) => m.role === 'user' && m.run_id === draft.run_id)
        && !messages.some((m) => m.role === 'assistant' && m.run_id === draft.run_id)) {
        const partial = JSON.parse(draft.body) as SessionMessage;
        const recovered: SessionMessage = { ...partial, role: 'assistant', status: 'stopped', model_exclude: true,
          content: partial.content.trim() || '(응답 중단 — 저장된 본문 없음)',
          ...(partial.tool_activity ? { tool_activity: partial.tool_activity.map((activity) => activity.state === 'running'
            ? { ...activity, state: 'cancelled' as const, updatedAt: Date.now(), finishedAt: Date.now(),
                output: `${activity.output}\n[실행 기록 중단: 실제 작업 결과는 별도 확인이 필요합니다.]`.slice(-12_000) }
            : activity) } : {}),
          application_notice: { kind: 'failure', title: '중단된 응답 복구',
            message: '응답이 완료되지 않아 마지막 저장 내용을 복구했습니다. 도구 작업은 자동 재실행하지 않습니다.' } };
        const rec = { ...JSON.parse(row.body), messages: [...messages, recovered] } as SessionRecord;
        delete rec.responses_state;
        delete rec.responses_states;
        rec.updated_at = new Date().toISOString();
        this.saveRecord(db, rec);
      }
    }
    db.prepare('DELETE FROM assistant_drafts WHERE session_id = ? AND run_id = ?').run(draft.session_id, draft.run_id);
  }

  load(id: string): SessionRecord | null {
    return this.withDbReadOnly((db) => {
      // A read transaction keeps metadata and message rows from different commits apart.
      db.exec('BEGIN');
      try {
        const row = db.prepare('SELECT body FROM sessions WHERE id = ?').get(id) as { body: string } | undefined;
        if (!row) return null;
        const messages = db.prepare('SELECT body FROM messages WHERE session_id = ? ORDER BY seq').all(id) as unknown as Row[];
        return { ...JSON.parse(row.body), messages: messages.map((m) => JSON.parse(m.body)) } as SessionRecord;
      } finally { db.exec('COMMIT'); }
    });
  }

  list(): SessionSummary[] {
    return this.withDbReadOnly((db) => {
      const rows = db.prepare(`SELECT s.body, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS count
        FROM sessions s`).all() as unknown as { body: string; count: number }[];
      return rows.map((row) => {
        const rec = JSON.parse(row.body) as SessionRecord;
        return { id: rec.id, title: rec.title, updated_at: rec.updated_at, message_count: row.count,
          project_id: rec.project_id ?? null, workspace_project_id: rec.workspace_project_id ?? null,
          preferred_model: rec.preferred_model, allowed_paths: rec.allowed_paths ?? [],
          archived: rec.archived === true };
      }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }

  delete(id: string): boolean {
    return this.withDb((db) => this.transaction(db, () => {
      // Keep a tombstone even for new sessions: preserved JSON must never resurrect a deletion.
      db.prepare('INSERT OR IGNORE INTO legacy_imports(filename) VALUES (?)').run(`${id}.json`);
      return Number(db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
    }));
  }

  page(id: string, limit = 50, before?: number): MessagePage | null {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) {
      throw new Error('INVALID_MESSAGE_PAGE');
    }
    return this.withDbReadOnly((db) => {
      db.exec('BEGIN');
      try {
        if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) return null;
        const rows = db.prepare(`SELECT seq, body FROM messages WHERE session_id = ? AND seq < ?
          ORDER BY seq DESC LIMIT ?`).all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as Row[];
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit).reverse();
        return { messages: page.map((row) => JSON.parse(row.body) as SessionMessage),
          has_more: hasMore, next_before: hasMore ? page[0].seq : null };
      } finally { db.exec('COMMIT'); }
    });
  }

  recent(id: string, limit: number): SessionMessage[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    return this.withDbReadOnly((db) => {
      const rows = db.prepare('SELECT body FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
        .all(id, limit) as unknown as Row[];
      return rows.reverse().map((row) => JSON.parse(row.body) as SessionMessage);
    });
  }
}
