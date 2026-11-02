/**
 * Read-only aggregation of the local LLM usage log for the Settings usage page.
 * Counts only `finish` rows written by fetchWithUsage (one row per HTTP attempt). Rows come from the
 * SQLite store (indexed start-time range) once the JSONL migration succeeded, else from the JSONL files.
 * Billed cost = provider-reported `usage.cost` (OpenRouter); otherwise estimated from the price table.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isCountedUsageRow, mergeCostBackfill, rowMetrics, str, type RowMetrics } from './llm-usage-metrics.js';
import { llmUsageMismatchedDates, llmUsageStoreMode, readLlmUsageFinishRows } from './llm-usage-store.js';

export interface LlmUsageTotals {
  requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number;
  billed_cost_usd: number;
  estimated_cost_usd: number;
  /** Requests with tokens but neither billed cost nor a price table entry. */
  unpriced_requests: number;
  cache_savings_usd: number;
  /** Requests whose cache savings were computed (list price − actual input cost) rather than reported. */
  cache_savings_estimated_requests: number;
  cache_write_tokens: number;
}

/** One request that read or wrote the prompt cache (newest first in the summary). */
export interface LlmUsageCacheRequest {
  started_at: string;
  model: string;
  purpose: string;
  /** Conversation and question (chat turn) ids; absent on rows written before they were recorded. */
  session_id?: string;
  turn_id?: string;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  /** + = discount, − = cache-write premium exceeded the discount. */
  savings_usd: number;
  estimated: boolean;
}

export interface LlmUsageGroupRow extends LlmUsageTotals {
  key: string;
}

/** One AI call (one `finish` row) inside a question — the 3rd level 「작업」. */
export interface LlmUsageCall {
  started_at: string;
  duration_ms: number;
  model: string;
  purpose: string;
  failed: boolean;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  /** true = provider-reported charge, false = price-table estimate (or unpriced). */
  billed: boolean;
  unpriced: boolean;
  savings_usd: number;
}

/**
 * Every AI call made while answering one question (one chat run: agent steps, approvals, images,
 * videos, embeddings), newest first. Rows written before turn ids were recorded are not grouped.
 */
export interface LlmUsageTurn extends LlmUsageTotals {
  turn_id: string;
  session_id?: string;
  /** First request start / last request end in this question. */
  started_at: string;
  finished_at: string;
  /** Distinct models / purposes used, in first-use order. */
  models: string[];
  purposes: string[];
  /** Filled by the API from the conversation store (absent when the conversation was deleted). */
  session_title?: string;
  question?: string;
  /** Calls in start order (capped at MAX_TURN_CALLS); `calls_total` is the uncapped count. */
  calls: LlmUsageCall[];
  calls_total: number;
}

/**
 * One conversation (chat session): every counted call carrying its session id, including rows
 * written before question ids existed (`untracked_requests`). Most recent activity first.
 */
export interface LlmUsageSession extends LlmUsageTotals {
  session_id: string;
  started_at: string;
  last_at: string;
  /** Questions with an id in the window (all of them, not only those returned in `turns`). */
  turn_count: number;
  untracked_requests: number;
  models: string[];
  session_title?: string;
}

export interface LlmUsageDayPoint {
  tokens: number;
  cost_usd: number;
  requests: number;
}

type DayGroups = {
  models: Record<string, LlmUsageDayPoint>;
  providers: Record<string, LlmUsageDayPoint>;
  purposes: Record<string, LlmUsageDayPoint>;
  /** Keyed by session id; calls without one use NO_SESSION_KEY. */
  sessions: Record<string, LlmUsageDayPoint>;
};

/** Day-series key for calls outside any conversation (connection tests, model lists…). */
export const NO_SESSION_KEY = '';

export interface LlmUsageSummary {
  range: { from: string; to: string; days: number; tz_offset_minutes: number };
  logging_disabled: boolean;
  /** Where rows were read from: SQLite after the one-time JSONL migration, else the legacy JSONL files. */
  storage: 'sqlite' | 'jsonl';
  /** Legacy (pre-SQLite) dates whose imported totals differed from the JSONL files; omitted when none. */
  legacy_mismatch_dates?: string[];
  /** 「비용 추적」 switch state. No periods = never turned on → nothing is counted. */
  tracking: LlmUsageTracking;
  totals: LlmUsageTotals;
  models: LlmUsageGroupRow[];
  providers: LlmUsageGroupRow[];
  /** chat | approval | image | video | embedding (rows written before the field existed = chat). */
  purposes: LlmUsageGroupRow[];
  daily: Array<{ date: string } & DayGroups>;
  /** Cache-using requests in the window, newest first, capped at MAX_CACHE_REQUESTS. */
  cache_requests: LlmUsageCacheRequest[];
  cache_requests_total: number;
  /** Per-question totals, newest first, capped at MAX_TURNS. */
  turns: LlmUsageTurn[];
  turns_total: number;
  /** Counted requests without a question id (written before ids were recorded). */
  untracked_turn_requests: number;
  /** Per-conversation totals, most recent activity first, capped at MAX_SESSIONS. */
  sessions: LlmUsageSession[];
  sessions_total: number;
  /** Counted requests without a conversation id. */
  unsessioned_requests: number;
}

const MAX_CACHE_REQUESTS = 500;
const MAX_TURNS = 300;
const MAX_TURN_CALLS = 300;
const MAX_SESSIONS = 300;
const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

/** Non-chat purposes get their own 「모델별」 row so a model shared with chat is not merged. */
const PURPOSE_MODEL_SUFFIX: Record<string, string> = {
  approval: '승인 판단',
  image: '이미지 생성',
  video: '영상 생성',
  embedding: '임베딩',
};

export function usageModelGroupKey(modelKey: string, purposeKey: string): string {
  if (purposeKey === 'chat') return modelKey;
  return `${modelKey} (${PURPOSE_MODEL_SUFFIX[purposeKey] ?? purposeKey})`;
}

const PROVIDER_HOST_LABELS: Record<string, string> = {
  'openrouter.ai': 'OpenRouter',
  'api.openai.com': 'OpenAI',
  'api.anthropic.com': 'Anthropic',
  'generativelanguage.googleapis.com': 'Google',
};

/**
 * Provider column groups by where the request actually went (endpoint host), not by the
 * settings connection id — the same OpenRouter key is logged as `custom` inside agent runs and
 * only as its host elsewhere (connection test, model list). Older rows without a host keep the id.
 */
export function usageProviderGroupKey(endpointHost: string | undefined, providerId: string | undefined): string {
  const host = endpointHost?.toLowerCase();
  if (host) return PROVIDER_HOST_LABELS[host] ?? host;
  return providerId ?? '(알 수 없음)';
}

function emptyTotals(): LlmUsageTotals {
  return {
    requests: 0, failed_requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0,
    total_tokens: 0, cost_usd: 0, billed_cost_usd: 0, estimated_cost_usd: 0, unpriced_requests: 0, cache_savings_usd: 0,
    cache_savings_estimated_requests: 0, cache_write_tokens: 0,
  };
}

export function resolveLlmUsageLogDir(cqrRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MY_AGENT_LLM_USAGE_LOG_DIR || path.join(cqrRoot, 'data', 'logs', 'llm-usage'));
}

const TRACKING_FILE = 'tracking.json';
const MAX_PERIODS = 500;

export interface LlmUsageTrackingPeriod {
  from: string;
  /** null = still on. */
  to: string | null;
}

export interface LlmUsageTracking {
  enabled: boolean;
  /** Time the switch was first turned on (ISO); null = never. */
  first_started_at: string | null;
  /** On-intervals. Only requests started inside one of these are counted. */
  periods: LlmUsageTrackingPeriod[];
}

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

function normalizeTracking(raw: unknown): LlmUsageTracking {
  const list = Array.isArray((raw as { periods?: unknown })?.periods) ? (raw as { periods: unknown[] }).periods : [];
  const periods: LlmUsageTrackingPeriod[] = [];
  for (const p of list) {
    const from = isoOrNull((p as { from?: unknown })?.from);
    if (!from) continue;
    const to = isoOrNull((p as { to?: unknown })?.to);
    if (to && Date.parse(to) < Date.parse(from)) continue;
    periods.push({ from, to });
  }
  periods.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  // Only the last interval may stay open.
  for (let i = 0; i < periods.length - 1; i += 1) if (!periods[i].to) periods[i].to = periods[i + 1].from;
  const last = periods[periods.length - 1];
  return { enabled: Boolean(last && !last.to), first_started_at: periods[0]?.from ?? null, periods: periods.slice(-MAX_PERIODS) };
}

/** Persisted 「비용 추적」 switch; never turned on = no periods (nothing counted). */
export function readLlmUsageTracking(cqrRoot: string, env: NodeJS.ProcessEnv = process.env): LlmUsageTracking {
  try {
    return normalizeTracking(JSON.parse(readFileSync(path.join(resolveLlmUsageLogDir(cqrRoot, env), TRACKING_FILE), 'utf8')));
  } catch {
    return normalizeTracking(null);
  }
}

/**
 * Turn tracking on/off at the server's current time. Past points are never accepted, so requests
 * logged before the user opted in (or while it was off) never enter totals. No reset: data
 * collected so far stays viewable; turning it on again just opens a new interval.
 */
export function setLlmUsageTracking(
  cqrRoot: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): LlmUsageTracking {
  const current = readLlmUsageTracking(cqrRoot, env);
  if (current.enabled === enabled) return current;
  const iso = new Date(now).toISOString();
  const periods = current.periods.map((p) => ({ ...p }));
  if (enabled) periods.push({ from: iso, to: null });
  else periods[periods.length - 1].to = iso;
  const next = normalizeTracking({ periods });
  const dir = resolveLlmUsageLogDir(cqrRoot, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, TRACKING_FILE), JSON.stringify({ periods: next.periods, updated_at: iso }, null, 2) + '\n', 'utf8');
  return next;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));

function localDate(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function addTo(t: LlmUsageTotals, m: RowMetrics): void {
  t.requests += 1;
  if (m.failed) t.failed_requests += 1;
  t.input_tokens += m.input;
  t.output_tokens += m.output;
  t.cached_tokens += m.cached;
  t.reasoning_tokens += m.reasoning;
  t.total_tokens += m.input + m.output;
  if (m.billed !== undefined) t.billed_cost_usd += m.billed;
  if (m.estimated !== undefined) t.estimated_cost_usd += m.estimated;
  t.cost_usd += (m.billed ?? 0) + (m.estimated ?? 0);
  if (m.unpriced) t.unpriced_requests += 1;
  t.cache_savings_usd += m.savings;
  if (m.savingsEstimated) t.cache_savings_estimated_requests += 1;
  t.cache_write_tokens += m.write;
}

function addPoint(map: Record<string, LlmUsageDayPoint>, key: string, m: RowMetrics): void {
  const p = (map[key] ??= { tokens: 0, cost_usd: 0, requests: 0 });
  p.tokens += m.input + m.output;
  p.cost_usd += (m.billed ?? 0) + (m.estimated ?? 0);
  p.requests += 1;
}

export function summarizeLlmUsage(options: {
  cqrRoot: string;
  /** Number of local days ending today, or 'all' = from the first tracking day through today. */
  days?: number | 'all';
  /** Custom local-date window (YYYY-MM-DD, inclusive). Takes precedence over `days` when both are valid. */
  from?: string;
  to?: string;
  tzOffsetMinutes?: number;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** Overrides the persisted tracking state (tests). */
  tracking?: LlmUsageTracking;
}): LlmUsageSummary {
  const env = options.env ?? process.env;
  const tz = Math.max(-840, Math.min(840, Math.trunc(options.tzOffsetMinutes ?? 0) || 0));
  const now = options.now ?? Date.now();
  const today = localDate(now, tz);
  const tracking = options.tracking ? normalizeTracking(options.tracking) : readLlmUsageTracking(options.cqrRoot, env);
  const intervals = tracking.periods.map((p) => [Date.parse(p.from), p.to ? Date.parse(p.to) : Infinity] as const);
  const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  let to = today;
  let days: number;
  if (validDate(options.from) && validDate(options.to)) {
    const [a, b] = [options.from, options.to].sort();
    to = b;
    days = Math.round((dayMs(b) - dayMs(a)) / DAY_MS) + 1;
  } else if (options.days === 'all') {
    days = tracking.first_started_at
      ? Math.round((dayMs(today) - dayMs(localDate(Date.parse(tracking.first_started_at), tz))) / DAY_MS) + 1
      : 7;
  } else {
    days = Math.trunc(options.days ?? 30) || 30;
  }
  // Over-long custom windows keep the end date and drop the oldest days.
  days = Math.min(MAX_DAYS, Math.max(1, days));
  const fromMs = dayMs(to) - (days - 1) * DAY_MS;
  const dir = resolveLlmUsageLogDir(options.cqrRoot, env);

  const dateKeys: string[] = [];
  for (let i = 0; i < days; i += 1) dateKeys.push(new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10));
  type Bucket = { date: string } & DayGroups;
  const daily = new Map<string, Bucket>(dateKeys.map((date) => [date, { date, models: {}, providers: {}, purposes: {}, sessions: {} }]));
  const totals = emptyTotals();
  const models = new Map<string, LlmUsageGroupRow>();
  const providers = new Map<string, LlmUsageGroupRow>();
  const purposes = new Map<string, LlmUsageGroupRow>();
  const cacheRequests: LlmUsageCacheRequest[] = [];
  const turns = new Map<string, LlmUsageTurn>();
  const sessions = new Map<string, LlmUsageSession>();
  let untrackedTurnRequests = 0;
  let unsessionedRequests = 0;

  const consume = (row: Record<string, unknown>) => {
    if (!isCountedUsageRow(row)) return;
    const started = Date.parse(String(row.started_at ?? ''));
    if (!Number.isFinite(started)) return;
    if (!intervals.some(([a, b]) => started >= a && started < b)) return;
    const bucket = daily.get(localDate(started, tz));
    if (!bucket) return;
    const m = rowMetrics(row, env);
    const modelKey = str(row.response_model) ?? str(row.model) ?? '(알 수 없음)';
    const providerKey = usageProviderGroupKey(str(row.endpoint_host), str(row.provider_id));
    const purposeKey = str(row.purpose) ?? 'chat';
    const modelGroupKey = usageModelGroupKey(modelKey, purposeKey);
    addTo(totals, m);
    for (const [map, key] of [[models, modelGroupKey], [providers, providerKey], [purposes, purposeKey]] as const) {
      let g = map.get(key);
      if (!g) { g = { key, ...emptyTotals() }; map.set(key, g); }
      addTo(g, m);
    }
    addPoint(bucket.models, modelGroupKey, m);
    addPoint(bucket.providers, providerKey, m);
    addPoint(bucket.purposes, purposeKey, m);
    const turnId = str(row.turn_id);
    const sessionId = str(row.session_id);
    addPoint(bucket.sessions, sessionId ?? NO_SESSION_KEY, m);
    const finishedMs = Date.parse(String(row.finished_at ?? ''));
    const endMs = Number.isFinite(finishedMs) ? Math.max(finishedMs, started) : started;
    if (sessionId) {
      let s = sessions.get(sessionId);
      if (!s) {
        s = {
          session_id: sessionId, started_at: new Date(started).toISOString(), last_at: new Date(endMs).toISOString(),
          turn_count: 0, untracked_requests: 0, models: [], ...emptyTotals(),
        };
        sessions.set(sessionId, s);
      }
      if (started < Date.parse(s.started_at)) s.started_at = new Date(started).toISOString();
      if (endMs > Date.parse(s.last_at)) s.last_at = new Date(endMs).toISOString();
      if (!s.models.includes(modelKey)) s.models.push(modelKey);
      if (!turnId) s.untracked_requests += 1;
      addTo(s, m);
    } else {
      unsessionedRequests += 1;
    }
    if (turnId) {
      const end = endMs;
      // Same run id in two conversations is impossible in practice; key by both anyway.
      const turnKey = `${sessionId ?? ''}\u0000${turnId}`;
      let t = turns.get(turnKey);
      if (!t) {
        t = {
          turn_id: turnId, ...(sessionId ? { session_id: sessionId } : {}),
          started_at: new Date(started).toISOString(), finished_at: new Date(end).toISOString(),
          models: [], purposes: [], calls: [], calls_total: 0, ...emptyTotals(),
        };
        turns.set(turnKey, t);
        if (sessionId) sessions.get(sessionId)!.turn_count += 1;
      }
      if (started < Date.parse(t.started_at)) t.started_at = new Date(started).toISOString();
      if (end > Date.parse(t.finished_at)) t.finished_at = new Date(end).toISOString();
      if (!t.models.includes(modelKey)) t.models.push(modelKey);
      if (!t.purposes.includes(purposeKey)) t.purposes.push(purposeKey);
      addTo(t, m);
      t.calls_total += 1;
      t.calls.push({
        started_at: new Date(started).toISOString(), duration_ms: end - started, model: modelKey, purpose: purposeKey,
        failed: m.failed, input_tokens: m.input, output_tokens: m.output, cached_tokens: m.cached, cache_write_tokens: m.write,
        cost_usd: (m.billed ?? 0) + (m.estimated ?? 0), billed: m.billed !== undefined, unpriced: Boolean(m.unpriced),
        savings_usd: m.savings,
      });
    } else {
      untrackedTurnRequests += 1;
    }
    if (m.cached + m.write > 0) {
      cacheRequests.push({
        started_at: new Date(started).toISOString(), model: modelKey, purpose: purposeKey,
        ...(sessionId ? { session_id: sessionId } : {}), ...(turnId ? { turn_id: turnId } : {}),
        input_tokens: m.input, cached_tokens: m.cached, cache_write_tokens: m.write, savings_usd: m.savings, estimated: m.savingsEstimated,
      });
    }
  };

  // Never tracked → empty summary; rows outside the on-intervals are never mixed in.
  // One extra day on each side of the local-time window (rows/files are keyed by UTC start).
  const sqlite = intervals.length > 0 && llmUsageStoreMode(dir, env) === 'sqlite';
  if (sqlite) {
    for (const row of readLlmUsageFinishRows(dir, fromMs - DAY_MS, fromMs + (days + 1) * DAY_MS)) consume(row);
  }
  for (let i = -1; !sqlite && intervals.length > 0 && i <= days; i += 1) {
    const file = path.join(dir, `llm-usage-${new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10)}.jsonl`);
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    // Late OpenRouter generation-stats rows (same call_id, same file) fill fields the reply lacked.
    const backfills = new Map<string, Record<string, unknown>>();
    for (const line of lines) {
      if (!line.includes('"cost_backfill"')) continue;
      try {
        const fill = JSON.parse(line) as Record<string, unknown>;
        if (fill.event === 'cost_backfill' && typeof fill.call_id === 'string') backfills.set(fill.call_id, fill);
      } catch { /* skip */ }
    }
    for (const line of lines) {
      if (!line.includes('"finish"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (row.event !== 'finish') continue;
      const fill = typeof row.call_id === 'string' ? backfills.get(row.call_id) : undefined;
      if (fill) row = mergeCostBackfill(row, fill);
      consume(row);
    }
  }
  cacheRequests.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const turnList = [...turns.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  for (const t of turnList) {
    t.calls.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    if (t.calls.length > MAX_TURN_CALLS) t.calls = t.calls.slice(0, MAX_TURN_CALLS);
  }
  const sessionList = [...sessions.values()].sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));

  const sortRows = (rows: LlmUsageGroupRow[]) => rows.sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);
  return {
    range: { from: dateKeys[0], to, days, tz_offset_minutes: tz },
    logging_disabled: /^(0|off|false|no)$/i.test(env.MY_AGENT_LLM_USAGE_LOG ?? ''),
    storage: llmUsageStoreMode(dir, env),
    ...((): { legacy_mismatch_dates?: string[] } => {
      const dates = llmUsageMismatchedDates(dir, env);
      return dates.length ? { legacy_mismatch_dates: dates } : {};
    })(),
    tracking,
    totals,
    models: sortRows([...models.values()]),
    providers: sortRows([...providers.values()]),
    purposes: sortRows([...purposes.values()]),
    daily: dateKeys.map((date) => daily.get(date)!),
    cache_requests: cacheRequests.slice(0, MAX_CACHE_REQUESTS),
    cache_requests_total: cacheRequests.length,
    turns: turnList.slice(0, MAX_TURNS),
    turns_total: turnList.length,
    untracked_turn_requests: untrackedTurnRequests,
    sessions: sessionList.slice(0, MAX_SESSIONS),
    sessions_total: sessionList.length,
    unsessioned_requests: unsessionedRequests,
  };
}
