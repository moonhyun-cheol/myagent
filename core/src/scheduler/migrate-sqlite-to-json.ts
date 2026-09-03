import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  PersonalSchedulerTask,
  SchedulerFeedAttachment,
  SchedulerFeedItem,
  SchedulerMisfirePolicy,
  SchedulerRun,
  SchedulerRunSource,
  SchedulerTrigger,
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

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}

function hasJsonStore(schedulerRoot: string): boolean {
  const tasksDir = path.join(schedulerRoot, 'tasks');
  if (!existsSync(tasksDir)) return false;
  const taskFiles = readdirSync(tasksDir).filter((entry) => entry.endsWith('.json'));
  if (taskFiles.length > 0) return true;
  const runsPath = path.join(schedulerRoot, 'runs.json');
  if (!existsSync(runsPath)) return false;
  try {
    const doc = JSON.parse(readFileSync(runsPath, 'utf8')) as { runs?: unknown[] };
    return Array.isArray(doc.runs) && doc.runs.length > 0;
  } catch {
    return false;
  }
}

function archiveSqliteFiles(sqlitePath: string): void {
  const backupPath = `${sqlitePath}.bak`;
  if (existsSync(sqlitePath)) renameSync(sqlitePath, backupPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${sqlitePath}${suffix}`;
    if (existsSync(sidecar)) renameSync(sidecar, `${backupPath}${suffix}`);
  }
}

/** Migrate legacy SQLite scheduler data into the JSON document layout. Returns true when migrated. */
export function migrateSchedulerSqliteToJson(schedulerRoot: string): boolean {
  const sqlitePath = path.join(schedulerRoot, 'personal-scheduler.sqlite');
  if (!existsSync(sqlitePath) || hasJsonStore(schedulerRoot)) return false;

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const taskRows = db.prepare('SELECT * FROM scheduler_tasks').all() as Row[];
    const runRows = db.prepare('SELECT * FROM scheduler_runs ORDER BY created_at ASC').all() as Row[];
    const feedRows = db.prepare('SELECT * FROM scheduler_feed ORDER BY created_at ASC').all() as Row[];

    const tasksDir = path.join(schedulerRoot, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    for (const row of taskRows) {
      const task = taskFromRow(row);
      writeJsonAtomic(path.join(tasksDir, `${task.id}.json`), task);
    }

    const now = new Date().toISOString();
    writeJsonAtomic(path.join(schedulerRoot, 'runs.json'), {
      schema_version: 1,
      updated_at: now,
      runs: runRows.map(runFromRow),
    });
    writeJsonAtomic(path.join(schedulerRoot, 'feed.json'), {
      schema_version: 1,
      updated_at: now,
      items: feedRows.map(feedFromRow),
    });
    writeJsonAtomic(path.join(schedulerRoot, 'weekly-queue.json'), {
      schema_version: 1,
      updated_at: now,
      weeks: {},
    });
    writeJsonAtomic(path.join(schedulerRoot, 'weekly-completed.json'), {
      schema_version: 1,
      updated_at: now,
      weeks: {},
    });
  } finally {
    db.close();
  }

  archiveSqliteFiles(sqlitePath);
  return true;
}
