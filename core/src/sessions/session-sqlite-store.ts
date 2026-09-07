import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { SessionMessage, SessionRecord, SessionSummary } from './types.js';

type Row = { body: string; seq: number };
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
      if (version > 1) throw new Error('SESSION_DATABASE_VERSION_UNSUPPORTED');
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE IF NOT EXISTS legacy_imports (filename TEXT PRIMARY KEY);
        PRAGMA user_version = 1;
      `);
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
    });
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
    this.withDb((db) => this.transaction(db, () => this.saveRecord(db, rec)));
  }

  append(rec: SessionRecord, message: SessionMessage): void {
    this.withDb((db) => this.transaction(db, () => {
      const { messages: _messages, ...metadata } = rec;
      const updated = db.prepare('UPDATE sessions SET body = ? WHERE id = ?').run(JSON.stringify(metadata), rec.id);
      if (!Number(updated.changes)) throw new Error('SESSION_NOT_FOUND');
      db.prepare(`INSERT INTO messages(session_id, seq, body)
        SELECT ?, COALESCE(MAX(seq), 0) + 1, ? FROM messages WHERE session_id = ?`)
        .run(rec.id, JSON.stringify(message), rec.id);
    }));
  }

  load(id: string): SessionRecord | null {
    return this.withDb((db) => {
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
    return this.withDb((db) => {
      const rows = db.prepare(`SELECT s.body, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS count
        FROM sessions s`).all() as unknown as { body: string; count: number }[];
      return rows.map((row) => {
        const rec = JSON.parse(row.body) as SessionRecord;
        return { id: rec.id, title: rec.title, updated_at: rec.updated_at, message_count: row.count,
          project_id: rec.project_id ?? null, workspace_project_id: rec.workspace_project_id ?? null,
          preferred_model: rec.preferred_model, allowed_paths: rec.allowed_paths ?? [] };
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
    return this.withDb((db) => {
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
    return this.withDb((db) => {
      const rows = db.prepare('SELECT body FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
        .all(id, limit) as unknown as Row[];
      return rows.reverse().map((row) => JSON.parse(row.body) as SessionMessage);
    });
  }
}
