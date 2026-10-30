/**
 * Read-only aggregation of local llm-usage JSONL logs for the Settings usage page.
 * Counts only `finish` rows written by fetchWithUsage (one row per HTTP attempt).
 * Billed cost = provider-reported `usage.cost` (OpenRouter); otherwise estimated from the price table.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { calculateLlmUsageCost } from '../agent/llm-usage-cost.js';

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

export interface LlmUsageDayPoint {
  tokens: number;
  cost_usd: number;
  requests: number;
}

type DayGroups = { models: Record<string, LlmUsageDayPoint>; providers: Record<string, LlmUsageDayPoint>; purposes: Record<string, LlmUsageDayPoint> };

export interface LlmUsageSummary {
  range: { from: string; to: string; days: number; tz_offset_minutes: number };
  logging_disabled: boolean;
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
}

const MAX_CACHE_REQUESTS = 500;
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

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : undefined);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

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

interface RowMetrics {
  failed: boolean;
  input: number;
  output: number;
  cached: number;
  write: number;
  reasoning: number;
  billed?: number;
  estimated?: number;
  unpriced: boolean;
  savings: number;
  savingsEstimated: boolean;
}

function rowMetrics(row: Record<string, unknown>, env: NodeJS.ProcessEnv): RowMetrics {
  const failed = row.outcome !== 'completed';
  const cached = num(row.cached_tokens);
  const write = num(row.cache_write_tokens);
  // total_input_tokens already includes cache reads/writes for every wire.
  let input = num(row.total_input_tokens);
  if (!input && row.input_tokens != null) {
    input = num(row.input_tokens) + (row.input_semantics === 'excludes_cache' ? cached + write : 0);
  }
  const output = num(row.output_tokens);
  const metrics: RowMetrics = { failed, input, output, cached, write, reasoning: num(row.reasoning_tokens), unpriced: false, savings: 0, savingsEstimated: false };
  const modelId = str(row.response_model) ?? str(row.model) ?? 'default';
  const billed = finite(row.provider_cost_usd);
  if (billed !== undefined) {
    metrics.billed = Math.max(0, billed);
    const discount = finite(row.cache_discount_usd);
    const actualInput = finite(row.upstream_input_cost_usd);
    if (discount !== undefined) metrics.savings = discount;
    else if (actualInput !== undefined && cached + write > 0) {
      // Savings = what the input would cost at the list rate − what it actually cost (reads discounted,
      // writes at a premium, so it can be negative). Only the list rate comes from the price table.
      const list = calculateLlmUsageCost({ prompt_tokens: input, completion_tokens: 0 }, modelId, env, str(row.provider_id));
      if (list.pricing_status === 'priced' && list.input_cost_microusd !== undefined) {
        metrics.savings = list.input_cost_microusd / 1_000_000 - actualInput;
        metrics.savingsEstimated = true;
      }
    }
    return metrics;
  }
  if (input + output === 0) {
    // Completed but nothing to price (video jobs without a reported cost, usage-less replies).
    metrics.unpriced = !failed;
    return metrics;
  }
  const cost = calculateLlmUsageCost(
    { prompt_tokens: input, completion_tokens: output, cached_tokens: cached, cache_write_tokens: write },
    modelId,
    env,
    str(row.provider_id),
  );
  if (cost.pricing_status === 'priced' && cost.total_cost_microusd !== undefined) {
    metrics.estimated = cost.total_cost_microusd / 1_000_000;
    metrics.savings = (cost.cache_net_savings_microusd ?? 0) / 1_000_000;
    metrics.savingsEstimated = cached + write > 0;
  } else {
    metrics.unpriced = true;
  }
  return metrics;
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
  const daily = new Map<string, Bucket>(dateKeys.map((date) => [date, { date, models: {}, providers: {}, purposes: {} }]));
  const totals = emptyTotals();
  const models = new Map<string, LlmUsageGroupRow>();
  const providers = new Map<string, LlmUsageGroupRow>();
  const purposes = new Map<string, LlmUsageGroupRow>();
  const cacheRequests: LlmUsageCacheRequest[] = [];

  // Files are split by UTC start date; read one extra day on each side of the local-time window.
  // Never tracked → empty summary; rows outside the on-intervals are never mixed in.
  for (let i = -1; intervals.length > 0 && i <= days; i += 1) {
    const file = path.join(dir, `llm-usage-${new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10)}.jsonl`);
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"finish"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (row.event !== 'finish') continue;
      // Decision version checks: an unknown id answers a free 400 — not usage, not a failure.
      // A probe that hit an existing id is a real billed decision and stays counted.
      if (row.probe === true && row.http_status === 400) continue;
      const started = Date.parse(String(row.started_at ?? ''));
      if (!Number.isFinite(started)) continue;
      if (!intervals.some(([a, b]) => started >= a && started < b)) continue;
      const bucket = daily.get(localDate(started, tz));
      if (!bucket) continue;
      const m = rowMetrics(row, env);
      const modelKey = str(row.response_model) ?? str(row.model) ?? '(알 수 없음)';
      const providerKey = str(row.provider_id) ?? str(row.endpoint_host) ?? '(알 수 없음)';
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
      if (m.cached + m.write > 0) {
        cacheRequests.push({
          started_at: new Date(started).toISOString(), model: modelKey, purpose: purposeKey, input_tokens: m.input,
          cached_tokens: m.cached, cache_write_tokens: m.write, savings_usd: m.savings, estimated: m.savingsEstimated,
        });
      }
    }
  }
  cacheRequests.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

  const sortRows = (rows: LlmUsageGroupRow[]) => rows.sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);
  return {
    range: { from: dateKeys[0], to, days, tz_offset_minutes: tz },
    logging_disabled: /^(0|off|false|no)$/i.test(env.MY_AGENT_LLM_USAGE_LOG ?? ''),
    tracking,
    totals,
    models: sortRows([...models.values()]),
    providers: sortRows([...providers.values()]),
    purposes: sortRows([...purposes.values()]),
    daily: dateKeys.map((date) => daily.get(date)!),
    cache_requests: cacheRequests.slice(0, MAX_CACHE_REQUESTS),
    cache_requests_total: cacheRequests.length,
  };
}
