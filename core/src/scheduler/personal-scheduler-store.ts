import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  PersonalSchedulerTask,
  SchedulerFeedAttachment,
  SchedulerFeedItem,
  SchedulerMisfirePolicy,
  SchedulerRun,
  SchedulerRunSource,
  SchedulerTaskInput,
  SchedulerTrigger,
  SchedulerWeeklyQueue,
  SchedulerWeeklyQueueItem,
} from './types.js';

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(asText(value)) as T;
  } catch {
    return fallback;
  }
}

function taskFromRow(row: Row): PersonalSchedulerTask {
  return {
    id: asText(row.id),
    name: asText(row.name),
    description: asText(row.description),
    instruction: asText(row.instruction),
    triggers: parseJson<SchedulerTrigger[]>(row.triggers_json, []),
    enabled: Number(row.enabled) === 1,
    next_run_at: row.next_run_at == null ? null : asText(row.next_run_at),
    misfire_policy: asText(row.misfire_policy) as SchedulerMisfirePolicy,
    created_at: asText(row.created_at),
    updated_at: asText(row.updated_at),
    last_run_at: row.last_run_at == null ? null : asText(row.last_run_at),
  };
}

function runFromRow(row: Row): SchedulerRun {
  return {
    id: asText(row.id),
    task_id: asText(row.task_id),
    source: asText(row.source) as SchedulerRunSource,
    status: asText(row.status) as SchedulerRun['status'],
    started_at: row.started_at == null ? null : asText(row.started_at),
    finished_at: row.finished_at == null ? null : asText(row.finished_at),
    result_text: row.result_text == null ? null : asText(row.result_text),
    error: row.error == null ? null : asText(row.error),
    created_at: asText(row.created_at),
  };
}

function feedFromRow(row: Row): SchedulerFeedItem {
  return {
    id: asText(row.id),
    run_id: row.run_id == null ? null : asText(row.run_id),
    task_id: asText(row.task_id),
    kind: asText(row.kind) as SchedulerFeedItem['kind'],
    title: asText(row.title),
    message: asText(row.message),
    attachments: parseJson<SchedulerFeedAttachment[]>(row.attachments_json, []),
    created_at: asText(row.created_at),
    read_at: row.read_at == null ? null : asText(row.read_at),
  };
}

export class PersonalSchedulerStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instruction TEXT NOT NULL,
        triggers_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT,
        misfire_policy TEXT NOT NULL DEFAULT 'skip',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_due
        ON scheduler_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS scheduler_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES scheduler_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_runs_created
        ON scheduler_runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS scheduler_feed (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        read_at TEXT,
        FOREIGN KEY(task_id) REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES scheduler_runs(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_feed_created
        ON scheduler_feed(created_at DESC);
      CREATE TABLE IF NOT EXISTS scheduler_week_queues (
        week_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduler_week_queue_items (
        week_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(week_key, task_id),
        FOREIGN KEY(week_key) REFERENCES scheduler_week_queues(week_key) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES scheduler_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_week_queue_ready
        ON scheduler_week_queue_items(week_key, available_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  listTasks(): PersonalSchedulerTask[] {
    return (this.db.prepare('SELECT * FROM scheduler_tasks ORDER BY updated_at DESC').all() as Row[])
      .map(taskFromRow);
  }

  getTask(id: string): PersonalSchedulerTask | null {
    const row = this.db.prepare('SELECT * FROM scheduler_tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? taskFromRow(row) : null;
  }

  saveTask(input: SchedulerTaskInput, nextRunAt: string | null, id?: string): PersonalSchedulerTask {
    const now = new Date().toISOString();
    const taskId = id || randomUUID();
    const existing = this.getTask(taskId);
    this.db.prepare(`
      INSERT INTO scheduler_tasks (
        id, name, description, instruction, triggers_json, enabled,
        next_run_at, misfire_policy, created_at, updated_at, last_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        instruction=excluded.instruction, triggers_json=excluded.triggers_json,
        enabled=excluded.enabled, next_run_at=excluded.next_run_at,
        misfire_policy=excluded.misfire_policy, updated_at=excluded.updated_at
    `).run(
      taskId,
      input.name,
      input.description ?? '',
      input.instruction,
      JSON.stringify(input.triggers),
      input.enabled === false ? 0 : 1,
      nextRunAt,
      input.misfire_policy ?? 'skip',
      existing?.created_at ?? now,
      now,
      existing?.last_run_at ?? null,
    );
    return this.getTask(taskId)!;
  }

  setTaskEnabled(id: string, enabled: boolean, nextRunAt: string | null): PersonalSchedulerTask | null {
    this.db.prepare(`
      UPDATE scheduler_tasks
      SET enabled = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, enabled ? nextRunAt : null, new Date().toISOString(), id);
    return this.getTask(id);
  }

  setNextRun(id: string, nextRunAt: string | null, lastRunAt?: string): void {
    this.db.prepare(`
      UPDATE scheduler_tasks
      SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ?
      WHERE id = ?
    `).run(nextRunAt, lastRunAt ?? null, new Date().toISOString(), id);
  }

  deleteTask(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM scheduler_tasks WHERE id = ?').run(id).changes) > 0;
  }

  dueTasks(nowIso: string): PersonalSchedulerTask[] {
    return (this.db.prepare(`
      SELECT * FROM scheduler_tasks
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(nowIso) as Row[]).map(taskFromRow);
  }

  createRun(taskId: string, source: SchedulerRunSource): SchedulerRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduler_runs (id, task_id, source, status, created_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(id, taskId, source, createdAt);
    return this.getRun(id)!;
  }

  getRun(id: string): SchedulerRun | null {
    const row = this.db.prepare('SELECT * FROM scheduler_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? runFromRow(row) : null;
  }

  listRuns(limit = 50): SchedulerRun[] {
    return (this.db.prepare('SELECT * FROM scheduler_runs ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Math.trunc(limit)))) as Row[]).map(runFromRow);
  }

  markRunRunning(id: string): void {
    this.db.prepare(`UPDATE scheduler_runs SET status='running', started_at=? WHERE id=?`)
      .run(new Date().toISOString(), id);
  }

  completeRun(id: string, resultText: string): void {
    this.db.prepare(`
      UPDATE scheduler_runs
      SET status='succeeded', result_text=?, error=NULL, finished_at=?
      WHERE id=?
    `).run(resultText, new Date().toISOString(), id);
  }

  failRun(id: string, error: string): void {
    this.db.prepare(`
      UPDATE scheduler_runs
      SET status='failed', error=?, finished_at=?
      WHERE id=?
    `).run(error, new Date().toISOString(), id);
  }

  addFeedItem(input: Omit<SchedulerFeedItem, 'id' | 'created_at' | 'read_at'>): SchedulerFeedItem {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduler_feed (
        id, run_id, task_id, kind, title, message, attachments_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.run_id,
      input.task_id,
      input.kind,
      input.title,
      input.message,
      JSON.stringify(input.attachments),
      createdAt,
    );
    return feedFromRow(this.db.prepare('SELECT * FROM scheduler_feed WHERE id = ?').get(id) as Row);
  }

  listFeed(limit = 50): SchedulerFeedItem[] {
    return (this.db.prepare('SELECT * FROM scheduler_feed ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Math.trunc(limit)))) as Row[]).map(feedFromRow);
  }

  ensureWeeklyQueue(
    weekKey: string,
    items: Array<{ taskId: string; availableAt: string }>,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare('SELECT 1 FROM scheduler_week_queues WHERE week_key = ?')
        .get(weekKey);
      if (exists) {
        this.db.exec('COMMIT');
        return false;
      }
      const createdAt = new Date().toISOString();
      this.db.prepare('INSERT INTO scheduler_week_queues (week_key, created_at) VALUES (?, ?)')
        .run(weekKey, createdAt);
      const insert = this.db.prepare(`
        INSERT INTO scheduler_week_queue_items (week_key, task_id, available_at, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const item of items) insert.run(weekKey, item.taskId, item.availableAt, createdAt);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getWeeklyQueue(weekKey: string): SchedulerWeeklyQueue | null {
    const header = this.db.prepare('SELECT * FROM scheduler_week_queues WHERE week_key = ?')
      .get(weekKey) as Row | undefined;
    if (!header) return null;
    const remaining = this.db.prepare(`
      SELECT week_key, task_id, available_at, created_at
      FROM scheduler_week_queue_items
      WHERE week_key = ?
      ORDER BY available_at, task_id
    `).all(weekKey) as Row[];
    return {
      week_key: asText(header.week_key),
      created_at: asText(header.created_at),
      remaining: remaining.map((row): SchedulerWeeklyQueueItem => ({
        week_key: asText(row.week_key),
        task_id: asText(row.task_id),
        available_at: asText(row.available_at),
        created_at: asText(row.created_at),
      })),
    };
  }

  claimReadyWeeklyItem(weekKey: string, nowIso: string): SchedulerWeeklyQueueItem | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT week_key, task_id, available_at, created_at
        FROM scheduler_week_queue_items
        WHERE week_key = ? AND available_at <= ?
        ORDER BY available_at, task_id
        LIMIT 1
      `).get(weekKey, nowIso) as Row | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare('DELETE FROM scheduler_week_queue_items WHERE week_key = ? AND task_id = ?')
        .run(weekKey, asText(row.task_id));
      this.db.exec('COMMIT');
      return {
        week_key: asText(row.week_key),
        task_id: asText(row.task_id),
        available_at: asText(row.available_at),
        created_at: asText(row.created_at),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
