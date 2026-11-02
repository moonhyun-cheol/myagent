/**
 * SQLite home of the local LLM usage log: one row per finished HTTP attempt or provider job.
 *
 * Daily `llm-usage-YYYY-MM-DD.jsonl` files are the legacy store. On first open they are imported
 * once inside a transaction, then each log date is recomputed from both sides (requests, tokens,
 * cost, cache savings). The import is committed and JSONL writing stops either way: dates whose
 * totals differ are only recorded (`mismatched_dates`, surfaced as a notice on the usage page) so
 * one odd legacy day can never pin new records to JSONL. Only an unusable DB (open/import error)
 * keeps the JSONL store, retried next app start. The JSONL files are never deleted.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  addReconcile, isCountedUsageRow, mergeCostBackfill, rowMetrics, type UsageReconcileTotals,
} from './llm-usage-metrics.js';

export type LlmUsageStoreMode = 'sqlite' | 'jsonl';

export const LLM_USAGE_DB_FILE = 'llm-usage.sqlite';
const JSONL_FILE_RE = /^llm-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const IMPORT_META_KEY = 'jsonl_import';

export interface LlmUsageMigrationReport {
  status: 'done' | 'mismatch' | 'error';
  at: string;
  files: number;
  rows: number;
  /** Dates whose recomputed totals differed (mismatch only). */
  mismatched_dates?: Array<{ date: string; jsonl: UsageReconcileTotals; sqlite: UsageReconcileTotals }>;
  /** Count of differing dates (the list above is capped). */
  mismatched_count?: number;
  /** The import was committed (done, or mismatch recorded and accepted). */
  imported?: boolean;
  error?: string;
  duration_ms?: number;
}

/** Test seam: runs inside the import transaction after rows are inserted, before reconciliation. */
export interface LlmUsageStoreTestHooks { afterImport?: (db: DatabaseSync) => void }

/** `migratedNow` = this process attempted the JSONL import (not an earlier, already-finished one). */
type Handle = { mode: LlmUsageStoreMode; db?: DatabaseSync; report?: LlmUsageMigrationReport; migratedNow?: boolean };
const handles = new Map<string, Handle>();

const forcedJsonl = (env: NodeJS.ProcessEnv): boolean => /^jsonl$/i.test(env.MY_AGENT_LLM_USAGE_STORE ?? '');
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const ms = (v: unknown): number | null => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};
const realOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

function openDb(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT,
      log_date TEXT NOT NULL,
      started_ms INTEGER,
      finished_ms INTEGER,
      session_id TEXT,
      turn_id TEXT,
      run_id TEXT,
      purpose TEXT,
      model TEXT,
      endpoint_host TEXT,
      provider_id TEXT,
      provider_cost_usd REAL,
      generation_id TEXT,
      source TEXT NOT NULL,
      row_json TEXT NOT NULL,
      backfill_json TEXT,
      error_detail_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_started ON llm_usage(started_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage(session_id, started_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_turn ON llm_usage(turn_id);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_call ON llm_usage(call_id);
  `);
  return db;
}

function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}
function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function insertRow(db: DatabaseSync, row: Record<string, unknown>, logDate: string, source: 'live' | 'jsonl',
  extra?: { callId?: string; backfill?: Record<string, unknown>; errorDetail?: Record<string, unknown> }): void {
  db.prepare(`INSERT INTO llm_usage(call_id, log_date, started_ms, finished_ms, session_id, turn_id, run_id, purpose, model,
      endpoint_host, provider_id, provider_cost_usd, generation_id, source, row_json, backfill_json, error_detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    extra?.callId ?? text(row.call_id), logDate, ms(row.started_at), ms(row.finished_at),
    text(row.session_id), text(row.turn_id), text(row.run_id), text(row.purpose), text(row.model),
    text(row.endpoint_host), text(row.provider_id), realOrNull(row.provider_cost_usd), text(row.generation_id),
    source, JSON.stringify(row),
    extra?.backfill ? JSON.stringify(extra.backfill) : null,
    extra?.errorDetail ? JSON.stringify(extra.errorDetail) : null,
  );
}

const emptyReconcile = (): UsageReconcileTotals => ({ requests: 0, tokens: 0, cost_usd: 0, cache_savings_usd: 0 });
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const sameTotals = (a: UsageReconcileTotals, b: UsageReconcileTotals) =>
  a.requests === b.requests && a.tokens === b.tokens && close(a.cost_usd, b.cost_usd) && close(a.cache_savings_usd, b.cache_savings_usd);

/** Same parse/merge rules the legacy JSONL summary uses (backfills and error details join within one file). */
function parseJsonlFile(content: string): Array<{ row: Record<string, unknown>; fill?: Record<string, unknown>; detail?: Record<string, unknown> }> {
  const lines = content.split('\n');
  const fills = new Map<string, Record<string, unknown>>();
  const details = new Map<string, Record<string, unknown>>();
  const finishes: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.includes('"finish"') && !line.includes('"cost_backfill"') && !line.includes('"http_error_detail"')) continue;
    let row: Record<string, unknown>;
    try { row = record(JSON.parse(line)); } catch { continue; }
    const callId = typeof row.call_id === 'string' ? row.call_id : undefined;
    if (row.event === 'cost_backfill' && callId) fills.set(callId, row);
    else if (row.event === 'http_error_detail' && callId) details.set(callId, row);
    else if (row.event === 'finish') finishes.push(row);
  }
  return finishes.map((row) => {
    const callId = typeof row.call_id === 'string' ? row.call_id : undefined;
    return { row, fill: callId ? fills.get(callId) : undefined, detail: callId ? details.get(callId) : undefined };
  });
}

function migrateJsonl(db: DatabaseSync, dir: string, env: NodeJS.ProcessEnv, hooks?: LlmUsageStoreTestHooks): LlmUsageMigrationReport {
  const started = Date.now();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => JSONL_FILE_RE.test(f)).sort() : [];
  const expected = new Map<string, UsageReconcileTotals>();
  let rows = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Leftovers of an interrupted attempt never survive (each attempt runs in one transaction anyway).
    db.exec("DELETE FROM llm_usage WHERE source = 'jsonl'");
    for (const file of files) {
      const date = JSONL_FILE_RE.exec(file)![1];
      const content = readFileSync(path.join(dir, file), 'utf8');
      parseJsonlFile(content).forEach(({ row, fill, detail }, index) => {
        // Rows without a call id (very old/hand-made) get a stable synthetic one.
        const callId = typeof row.call_id === 'string' && row.call_id ? row.call_id : `legacy:${date}:${index}`;
        insertRow(db, row, date, 'jsonl', { callId, backfill: fill, errorDetail: detail });
        rows += 1;
        const merged = fill ? mergeCostBackfill(row, fill) : row;
        if (!isCountedUsageRow(merged)) return;
        const t = expected.get(date) ?? emptyReconcile();
        addReconcile(t, rowMetrics(merged, env));
        expected.set(date, t);
      });
    }
    hooks?.afterImport?.(db);
    // Recompute every date from what SQLite actually holds (JSON round trip included).
    const actual = new Map<string, UsageReconcileTotals>();
    for (const r of db.prepare("SELECT log_date, row_json, backfill_json FROM llm_usage WHERE source = 'jsonl' ORDER BY id").all() as Array<{ log_date: string; row_json: string; backfill_json: string | null }>) {
      const merged = hydrate(r.row_json, r.backfill_json);
      if (!isCountedUsageRow(merged)) continue;
      const t = actual.get(r.log_date) ?? emptyReconcile();
      addReconcile(t, rowMetrics(merged, env));
      actual.set(r.log_date, t);
    }
    const mismatched: NonNullable<LlmUsageMigrationReport['mismatched_dates']> = [];
    for (const date of new Set([...expected.keys(), ...actual.keys()])) {
      const a = expected.get(date) ?? emptyReconcile();
      const b = actual.get(date) ?? emptyReconcile();
      if (!sameTotals(a, b)) mismatched.push({ date, jsonl: a, sqlite: b });
    }
    const report: LlmUsageMigrationReport = {
      status: mismatched.length ? 'mismatch' : 'done', at: new Date().toISOString(), files: files.length, rows,
      ...(mismatched.length ? { mismatched_dates: mismatched.slice(0, 20), mismatched_count: mismatched.length } : {}),
      imported: true, duration_ms: Date.now() - started,
    };
    // Mismatches are recorded, not fatal: new records move to SQLite regardless.
    metaSet(db, IMPORT_META_KEY, JSON.stringify(report));
    db.exec('COMMIT');
    return report;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw error;
  }
}

function hydrate(rowJson: string, backfillJson: string | null): Record<string, unknown> {
  const row = record(JSON.parse(rowJson));
  return backfillJson ? mergeCostBackfill(row, record(JSON.parse(backfillJson))) : row;
}

/**
 * Store for a usage log directory, migrating the legacy JSONL files on first use in this process.
 * Never throws: any SQLite problem keeps the JSONL store.
 */
export function prepareLlmUsageStore(dir: string, env: NodeJS.ProcessEnv = process.env, hooks?: LlmUsageStoreTestHooks): Handle {
  const key = path.resolve(dir);
  const cached = handles.get(key);
  if (cached) return cached;
  let handle: Handle;
  if (forcedJsonl(env)) handle = { mode: 'jsonl' };
  else {
    let db: DatabaseSync | undefined;
    try {
      db = openDb(path.join(key, LLM_USAGE_DB_FILE));
      const prior = metaGet(db, IMPORT_META_KEY);
      const priorReport = prior ? JSON.parse(prior) as LlmUsageMigrationReport : undefined;
      // A committed import (clean or with recorded mismatches) is final; anything else is retried.
      const finished = priorReport?.status === 'done' || (priorReport?.status === 'mismatch' && priorReport.imported === true);
      const migratedNow = !finished;
      const report = migratedNow ? migrateJsonl(db, key, env, hooks) : priorReport!;
      // The import (tens of MB) leaves an equally large -wal file that is only reused, never shrunk,
      // while the app keeps the DB open. Fold it into the DB once per start; cheap when already small.
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy reader: retried next start */ }
      handle = { mode: 'sqlite', db, report, migratedNow };
    } catch (error) {
      try { db?.close(); } catch { /* ignore */ }
      handle = { mode: 'jsonl', migratedNow: true, report: { status: 'error', at: new Date().toISOString(), files: 0, rows: 0, error: String((error as Error)?.message ?? error).slice(0, 300) } };
    }
  }
  handles.set(key, handle);
  return handle;
}

export function llmUsageStoreMode(dir: string, env: NodeJS.ProcessEnv = process.env): LlmUsageStoreMode {
  return prepareLlmUsageStore(dir, env).mode;
}

export function llmUsageMigrationReport(dir: string, env: NodeJS.ProcessEnv = process.env): LlmUsageMigrationReport | undefined {
  return prepareLlmUsageStore(dir, env).report;
}

/** Legacy dates whose imported totals differed from the JSONL files (empty when the import was clean). */
export function llmUsageMismatchedDates(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const report = prepareLlmUsageStore(dir, env).report;
  return report?.status === 'mismatch' ? (report.mismatched_dates ?? []).map((d) => d.date) : [];
}

/** Tests: forget cached handles (closes connections). */
export function resetLlmUsageStoresForTest(): void {
  for (const h of handles.values()) { try { h.db?.close(); } catch { /* ignore */ } }
  handles.clear();
}

const sqliteDb = (dir: string): DatabaseSync | undefined => {
  const h = prepareLlmUsageStore(dir);
  return h.mode === 'sqlite' ? h.db : undefined;
};

/** Live `finish` row. Log date = UTC start date (same as the JSONL file name). */
export function insertLlmUsageFinish(dir: string, row: Record<string, unknown>): boolean {
  const db = sqliteDb(dir);
  if (!db) return false;
  const started = ms(row.started_at) ?? Date.now();
  insertRow(db, row, new Date(started).toISOString().slice(0, 10), 'live');
  return true;
}

/** Late generation-stats cost for an earlier call (fills only what the reply lacked, at read time). */
export function updateLlmUsageBackfill(dir: string, callId: string, fill: Record<string, unknown>): boolean {
  const db = sqliteDb(dir);
  if (!db) return false;
  db.prepare('UPDATE llm_usage SET backfill_json = ? WHERE call_id = ?').run(JSON.stringify(fill), callId);
  return true;
}

export function updateLlmUsageErrorDetail(dir: string, callId: string, detail: Record<string, unknown>): boolean {
  const db = sqliteDb(dir);
  if (!db) return false;
  db.prepare('UPDATE llm_usage SET error_detail_json = ? WHERE call_id = ?').run(JSON.stringify(detail), callId);
  return true;
}

/** Finish rows started in [fromMs, toMs), backfill merged, in write order (same order as the JSONL files). */
export function readLlmUsageFinishRows(dir: string, fromMs: number, toMs: number): Array<Record<string, unknown>> {
  const db = sqliteDb(dir);
  if (!db) return [];
  const out: Array<Record<string, unknown>> = [];
  const rows = db.prepare('SELECT row_json, backfill_json FROM llm_usage WHERE started_ms >= ? AND started_ms < ? ORDER BY id')
    .all(fromMs, toMs) as Array<{ row_json: string; backfill_json: string | null }>;
  for (const r of rows) {
    try { out.push(hydrate(r.row_json, r.backfill_json)); } catch { /* skip corrupt row */ }
  }
  return out;
}

export interface PendingBackfillRow { callId: string; generationId: string; host: string; providerId?: string; finishedMs: number }
/** Finished calls still missing a billed cost that kept their OpenRouter generation id. */
export function pendingLlmUsageBackfills(dir: string, sinceMs: number, limit: number): PendingBackfillRow[] {
  const db = sqliteDb(dir);
  if (!db) return [];
  const rows = db.prepare(`SELECT call_id, generation_id, endpoint_host, provider_id, finished_ms FROM llm_usage
    WHERE generation_id IS NOT NULL AND provider_cost_usd IS NULL AND backfill_json IS NULL AND call_id IS NOT NULL
      AND finished_ms >= ? ORDER BY finished_ms DESC LIMIT ?`).all(sinceMs, Math.max(1, limit * 5)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    callId: String(r.call_id), generationId: String(r.generation_id), host: String(r.endpoint_host ?? '').toLowerCase(),
    ...(typeof r.provider_id === 'string' ? { providerId: r.provider_id } : {}), finishedMs: Number(r.finished_ms),
  }));
}

/** Tests/diagnostics: every stored finish row with its join columns. */
export function readAllLlmUsageRows(dir: string): Array<Record<string, unknown> & { _source: string; _log_date: string; _call_id: string | null }> {
  const db = sqliteDb(dir);
  if (!db) return [];
  return (db.prepare('SELECT call_id, log_date, source, row_json, backfill_json, error_detail_json FROM llm_usage ORDER BY id').all() as Array<Record<string, string | null>>)
    .map((r) => ({
      ...hydrate(String(r.row_json), r.backfill_json),
      ...(r.error_detail_json ? { _error_detail: JSON.parse(r.error_detail_json) } : {}),
      _source: String(r.source), _log_date: String(r.log_date), _call_id: r.call_id ?? null,
    }));
}
