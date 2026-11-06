import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { assertWritablePath } from '../security/path-guard.js';
import type { ResponsesContinuationState, SessionMessage, SessionRecord, SessionSummary } from './types.js';

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

export interface SessionSqliteStoreOptions {
  /**
   * Skip the synchronous daily snapshot in the constructor. The API server sets this and
   * runs {@link SessionSqliteStore.runDailyBackupInBackground} after it starts listening:
   * `VACUUM INTO` + `quick_check` grows with the database and used to block boot for tens
   * of seconds. Migration backups (schema/state split) always stay synchronous.
   */
  deferDailyBackup?: boolean;
}

/** Per-phase wall time (ms) of the constructor, for `api-start.log` boot diagnostics. */
export interface SessionStoreStartupTimings {
  open_schema_ms: number;
  split_states_ms: number;
  legacy_scan_ms: number;
  legacy_files: number;
  legacy_imported: number;
  daily_backup_ms: number;
  daily_backup: 'sync' | 'deferred' | 'exists';
  drafts_ms: number;
  drafts_recovered: number;
  db_mb: number;
}

const DAILY_BACKUP_RE = /^sessions-daily-\d{4}-\d{2}-\d{2}\.sqlite$/;

// Runs in a worker thread so the API event loop keeps serving while the snapshot is written.
const BACKUP_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { renameSync, rmSync } = require('node:fs');
const { source, target, temporary } = workerData;
try {
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.prepare('VACUUM INTO ?').run(temporary);
  } finally { db.close(); }
  const snapshot = new DatabaseSync(temporary, { readOnly: true });
  try {
    if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SESSION_BACKUP_INTEGRITY_FAILED');
  } finally { snapshot.close(); }
  renameSync(temporary, target);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
} finally {
  try { rmSync(temporary, { force: true }); } catch {}
}
`;

/** Local-disk store. JSON files remain untouched as migration backups, never live fallbacks. */
export class SessionSqliteStore {
  readonly databasePath: string;
  readonly startupTimings: SessionStoreStartupTimings = {
    open_schema_ms: 0, split_states_ms: 0, legacy_scan_ms: 0, legacy_files: 0, legacy_imported: 0,
    daily_backup_ms: 0, daily_backup: 'sync', drafts_ms: 0, drafts_recovered: 0, db_mb: 0,
  };
  private dailyBackupRunning: Promise<{ created: boolean; ms: number }> | null = null;

  constructor(private readonly dir: string, private readonly root: string, opts: SessionSqliteStoreOptions = {}) {
    this.databasePath = path.join(dir, 'sessions.sqlite');
    assertWritablePath(this.databasePath, root);
    mkdirSync(dir, { recursive: true });
    const timings = this.startupTimings;
    let mark = performance.now();
    const lap = (): number => {
      const now = performance.now();
      const ms = Math.round(now - mark);
      mark = now;
      return ms;
    };
    try { timings.db_mb = Math.round(statSync(this.databasePath).size / 1048576); } catch { /* new database */ }
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
        CREATE TABLE IF NOT EXISTS responses_states (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          lane TEXT NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY (session_id, lane)
        );
        PRAGMA user_version = 2;
      `));
      timings.open_schema_ms = lap();
      this.splitResponsesStates(db);
      timings.split_states_ms = lap();
      // Fail closed: a corrupt source must not silently disappear from the live set (or GC).
      // Each file and its marker commit together; a restart resumes without duplicates.
      const legacyFiles = readdirSync(dir).filter((name) => name.endsWith('.json'));
      timings.legacy_files = legacyFiles.length;
      // One query instead of one lookup per file on every boot.
      const imported = legacyFiles.length
        ? new Set((db.prepare('SELECT filename FROM legacy_imports').all() as { filename: string }[]).map((r) => r.filename))
        : new Set<string>();
      for (const filename of legacyFiles) {
        if (imported.has(filename)) continue;
        timings.legacy_imported++;
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
      timings.legacy_scan_ms = lap();
      if (existsSync(this.dailyBackupTarget())) timings.daily_backup = 'exists';
      else if (opts.deferDailyBackup) timings.daily_backup = 'deferred';
      else this.backup(db, this.dailyBackupLabel());
      timings.daily_backup_ms = lap();
      this.transaction(db, () => {
        const drafts = db.prepare('SELECT * FROM assistant_drafts').all() as unknown as DraftRow[];
        for (const draft of drafts) {
          // A second store/process must never recover a still-running owner's work.
          if (!processIsAlive(draft.owner_pid)) {
            this.recoverDraft(db, draft);
            timings.drafts_recovered++;
          }
        }
      });
      timings.drafts_ms = lap();
    });
  }

  private dailyBackupLabel(): string {
    return `daily-${new Date().toISOString().slice(0, 10)}`;
  }

  private dailyBackupTarget(): string {
    return path.join(this.dir, 'backups', `sessions-${this.dailyBackupLabel()}.sqlite`);
  }

  private rotateDailyBackups(dir: string): void {
    // Daily snapshots rotate only after a verified replacement. Migration backups are retained.
    const daily = readdirSync(dir).filter((name) => DAILY_BACKUP_RE.test(name)).sort().reverse();
    for (const name of daily.slice(7)) rmSync(path.join(dir, name));
  }

  /**
   * Today's snapshot in a worker thread (same VACUUM INTO + quick_check + atomic rename as the
   * synchronous path). Single-flight; resolves `created: false` when today's file already exists.
   */
  runDailyBackupInBackground(): Promise<{ created: boolean; ms: number }> {
    if (this.dailyBackupRunning) return this.dailyBackupRunning;
    const started = performance.now();
    const run = async (): Promise<{ created: boolean; ms: number }> => {
      const target = this.dailyBackupTarget();
      const dir = path.dirname(target);
      assertWritablePath(target, this.root);
      mkdirSync(dir, { recursive: true });
      if (existsSync(target)) return { created: false, ms: Math.round(performance.now() - started) };
      const temporary = `${target}.${randomUUID()}.tmp`;
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(BACKUP_WORKER_SOURCE, {
          eval: true,
          workerData: { source: this.databasePath, target, temporary },
        });
        let settled = false;
        worker.once('message', (msg: { ok: boolean; error?: string }) => {
          settled = true;
          if (msg.ok) resolve();
          else reject(new Error(msg.error || 'SESSION_BACKUP_FAILED'));
        });
        worker.once('error', (error) => { settled = true; reject(error); });
        worker.once('exit', (code) => {
          if (!settled) reject(new Error(`SESSION_BACKUP_WORKER_EXIT_${code}`));
        });
      });
      this.rotateDailyBackups(dir);
      return { created: true, ms: Math.round(performance.now() - started) };
    };
    this.dailyBackupRunning = run().finally(() => { this.dailyBackupRunning = null; });
    return this.dailyBackupRunning;
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
    this.rotateDailyBackups(dir);
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

  /**
   * Provider continuation state (can be megabytes) lives in its own table so ordinary
   * metadata reads/writes and per-call state saves never rewrite or parse it with the
   * transcript. Idempotent: also moves state written into the body by an older build.
   * The schema version stays 2 (additive table) so an older build still opens the file.
   */
  private splitResponsesStates(db: DatabaseSync): void {
    const rows = db.prepare(`SELECT id, json_extract(body, '$.responses_state') AS chat,
        json_extract(body, '$.responses_states') AS lanes FROM sessions
      WHERE json_type(body, '$.responses_state') IS NOT NULL OR json_type(body, '$.responses_states') IS NOT NULL`)
      .all() as unknown as { id: string; chat: string | null; lanes: string | null }[];
    if (!rows.length) return;
    this.backup(db, 'before-responses-state-split');
    this.transaction(db, () => {
      const upsert = db.prepare(`INSERT INTO responses_states(session_id, lane, body) VALUES (?, ?, ?)
        ON CONFLICT(session_id, lane) DO UPDATE SET body = excluded.body`);
      for (const row of rows) {
        const lanes = row.lanes ? JSON.parse(row.lanes) as Record<string, unknown> : {};
        for (const [lane, state] of Object.entries(lanes)) {
          if (state && typeof state === 'object') upsert.run(row.id, lane, JSON.stringify(state));
        }
        if (row.chat && !(lanes && typeof lanes === 'object' && 'chat' in lanes)) upsert.run(row.id, 'chat', row.chat);
        db.prepare(`UPDATE sessions SET body = json_remove(body, '$.responses_state', '$.responses_states') WHERE id = ?`)
          .run(row.id);
      }
    });
  }

  private saveRecord(db: DatabaseSync, rec: SessionRecord): void {
    const { messages, responses_state: _chatState, responses_states: _laneStates, ...metadata } = rec;
    db.prepare(`INSERT INTO sessions(id, body) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run(rec.id, JSON.stringify(metadata));
    // Records loaded from this store never carry continuation state; an explicit one (legacy
    // import / tests) is written to its table instead of the metadata body.
    if (_laneStates) {
      for (const [lane, state] of Object.entries(_laneStates)) this.writeResponsesStateRow(db, rec.id, lane, state);
    }
    if (_chatState && !_laneStates?.chat) this.writeResponsesStateRow(db, rec.id, 'chat', _chatState);
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

  save(rec: SessionRecord, opts: { clearResponsesStates?: boolean } = {}): void {
    this.withDb((db) => this.transaction(db, () => {
      this.saveRecord(db, rec);
      if (opts.clearResponsesStates) db.prepare('DELETE FROM responses_states WHERE session_id = ?').run(rec.id);
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

  /** Last checkpoint of an in-flight assistant reply (read-only; null when none). */
  draft(id: string, runId: string): SessionMessage | null {
    return this.withDbReadOnly((db) => {
      const row = db.prepare('SELECT body FROM assistant_drafts WHERE session_id = ? AND run_id = ?')
        .get(id, runId) as { body: string } | undefined;
      return row ? JSON.parse(row.body) as SessionMessage : null;
    });
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
        rec.updated_at = new Date().toISOString();
        this.saveRecord(db, rec);
        db.prepare('DELETE FROM responses_states WHERE session_id = ?').run(draft.session_id);
      }
    }
    db.prepare('DELETE FROM assistant_drafts WHERE session_id = ? AND run_id = ?').run(draft.session_id, draft.run_id);
  }

  private writeResponsesStateRow(db: DatabaseSync, id: string, lane: string, state: ResponsesContinuationState): void {
    db.prepare(`INSERT INTO responses_states(session_id, lane, body) VALUES (?, ?, ?)
      ON CONFLICT(session_id, lane) DO UPDATE SET body = excluded.body`).run(id, lane, JSON.stringify(state));
  }

  responsesState(id: string, lane: string): ResponsesContinuationState | null {
    return this.withDbReadOnly((db) => {
      const row = db.prepare('SELECT body FROM responses_states WHERE session_id = ? AND lane = ?')
        .get(id, lane) as { body: string } | undefined;
      return row ? JSON.parse(row.body) as ResponsesContinuationState : null;
    });
  }

  /** Every lane of one session (diagnostics/tests). */
  responsesStates(id: string): Record<string, ResponsesContinuationState> {
    return this.withDbReadOnly((db) => Object.fromEntries(
      (db.prepare('SELECT lane, body FROM responses_states WHERE session_id = ?').all(id) as unknown as { lane: string; body: string }[])
        .map((row) => [row.lane, JSON.parse(row.body) as ResponsesContinuationState]),
    ));
  }

  /** One row write + updated_at bump; the transcript is not read. False when the session is missing. */
  saveResponsesState(id: string, lane: string, state: ResponsesContinuationState, updatedAt: string): boolean {
    return this.withDb((db) => this.transaction(db, () => {
      const updated = db.prepare(`UPDATE sessions SET body = json_set(body, '$.updated_at', ?) WHERE id = ?`).run(updatedAt, id);
      if (!Number(updated.changes)) return false;
      this.writeResponsesStateRow(db, id, lane, state);
      return true;
    }));
  }

  clearResponsesStates(id: string, lane: string | undefined, updatedAt: string): boolean {
    return this.withDb((db) => this.transaction(db, () => {
      const updated = db.prepare(`UPDATE sessions SET body = json_set(body, '$.updated_at', ?) WHERE id = ?`).run(updatedAt, id);
      if (!Number(updated.changes)) return false;
      if (lane) db.prepare('DELETE FROM responses_states WHERE session_id = ? AND lane = ?').run(id, lane);
      else db.prepare('DELETE FROM responses_states WHERE session_id = ?').run(id);
      return true;
    }));
  }

  /** Patch the newest assistant message row only (no full transcript rewrite). */
  setLastAssistantUsage(id: string, usage: SessionMessage['usage']): boolean {
    return this.withDb((db) => this.transaction(db, () => {
      const row = db.prepare(`SELECT seq, body FROM messages WHERE session_id = ?
          AND json_extract(body, '$.role') = 'assistant' ORDER BY seq DESC LIMIT 1`).get(id) as Row | undefined;
      if (!row) return false;
      const message = JSON.parse(row.body) as SessionMessage;
      message.usage = usage;
      db.prepare('UPDATE messages SET body = ? WHERE session_id = ? AND seq = ?').run(JSON.stringify(message), id, row.seq);
      return true;
    }));
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
      // Extract only the summary fields in SQLite: bodies can carry large Responses replay
      // state (responses_state*), and materializing it in JS for every row made the
      // workspace tree (and therefore "new chat") slow on long-lived installs.
      const rows = db.prepare(`SELECT json_extract(s.body, '$.id', '$.title', '$.updated_at', '$.project_id',
          '$.workspace_project_id', '$.preferred_model', '$.allowed_paths', '$.archived') AS fields,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS count
        FROM sessions s`).all() as unknown as { fields: string; count: number }[];
      return rows.map((row) => {
        const [id, title, updatedAt, projectId, workspaceProjectId, preferredModel, allowedPaths, archived] =
          JSON.parse(row.fields) as [string, string, string, string | null, string | null, string | null, unknown, unknown];
        return { id, title, updated_at: updatedAt, message_count: row.count,
          project_id: projectId ?? null, workspace_project_id: workspaceProjectId ?? null,
          preferred_model: preferredModel ?? undefined,
          allowed_paths: Array.isArray(allowedPaths) ? allowedPaths as string[] : [],
          // json_extract maps JSON true to integer 1 inside the returned array text: accept both.
          archived: archived === true || archived === 1 };
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

  /**
   * Latest messages with a window start aligned to `step` positions, so the first
   * history message stays the same for several turns instead of sliding every turn
   * (a sliding start rewrites the provider prompt-cache prefix). Returns between
   * `limit - step + 1` and `limit` messages once the session exceeds `limit`.
   */
  recentAligned(id: string, limit: number, step: number): SessionMessage[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const safeStep = Number.isSafeInteger(step) && step > 1 && step < limit ? step : 1;
    return this.withDbReadOnly((db) => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(id) as { n?: number } | undefined;
      const total = Number(row?.n ?? 0);
      if (total <= 0) return [];
      const start = Math.max(0, total - limit);
      const aligned = Math.min(total - 1, Math.ceil(start / safeStep) * safeStep);
      const rows = db.prepare('SELECT body FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
        .all(id, total - aligned, aligned) as unknown as Row[];
      return rows.map((r) => JSON.parse(r.body) as SessionMessage);
    });
  }

  /**
   * Question text (first `maxChars`) of the user messages that started the given runs, read only
   * inside the listed conversations, plus each message's position among all user messages of its
   * conversation (`question_no`, 1 = first). Used to label per-question usage rows.
   */
  userQuestions(sessionIds: string[], runIds: string[], maxChars = 160): Array<{ session_id: string; run_id: string; content: string; question_no: number }> {
    if (!sessionIds.length || !runIds.length) return [];
    return this.withDbReadOnly((db) => db.prepare(`WITH q AS (
        SELECT session_id, json_extract(body, '$.run_id') AS run_id, json_extract(body, '$.content') AS content,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS question_no
        FROM messages
        WHERE session_id IN (SELECT value FROM json_each(?))
          AND json_extract(body, '$.role') = 'user')
      SELECT session_id, run_id, substr(content, 1, ?) AS content, question_no
      FROM q
      WHERE run_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(sessionIds), maxChars, JSON.stringify(runIds)) as unknown as Array<{ session_id: string; run_id: string; content: string; question_no: number }>);
  }
}
