/** Local, body-free accounting at the actual HTTP-attempt boundary. Not telemetry. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { providerErrorDiagnostics } from './provider-error-diagnostics.js';
import { lookupModelPricingAny } from '../models/model-pricing.js';

/** What the request was for, so the usage page can split chat from approvals/images/videos. */
export type LlmUsagePurpose = 'chat' | 'approval' | 'image' | 'video' | 'embedding';

export interface LlmUsageContext {
  cqrRoot?: string;
  sessionId?: string;
  runId?: string;
  providerId?: string;
  purpose?: LlmUsagePurpose;
  /** Version-check request (decision `latest` alias). Unknown-id 400s are excluded from the usage summary. */
  probe?: boolean;
  step?: () => number;
  /** Per-reply accumulator (image/video bubbles): each finished call's tokens and billed cost. */
  collect?: (usage: CollectedLlmUsage) => void;
}
export type CollectedLlmUsage = { input_tokens?: number; output_tokens?: number; cost_usd?: number };
/** Sums every finished call inside its context (retries included: they are billed too). */
export function createLlmUsageCollector(): { collect: (usage: CollectedLlmUsage) => void; result: () => CollectedLlmUsage | undefined } {
  const total: CollectedLlmUsage = {};
  const add = (key: keyof CollectedLlmUsage, v: number | undefined) => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total[key] = (total[key] ?? 0) + v;
  };
  return {
    collect: (u) => { add('input_tokens', u.input_tokens); add('output_tokens', u.output_tokens); add('cost_usd', u.cost_usd); },
    result: () => (Object.keys(total).length ? { ...total } : undefined),
  };
}
const context = new AsyncLocalStorage<LlmUsageContext>();
export function withLlmUsageContext<T>(value: LlmUsageContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...value }, work);
}
/** Current chat session id (agent runs), used only for OpenRouter sticky-routing pins. */
export function currentLlmUsageSessionId(): string | undefined {
  return context.getStore()?.sessionId;
}

type Wire = 'chat' | 'responses' | 'messages';
type Usage = Partial<Record<'input_tokens' | 'output_tokens' | 'cached_tokens' | 'cache_write_tokens' | 'reasoning_tokens', number>>;
const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** `~` covers OpenRouter latest aliases (`~typesafe/jev-latest`); still no spaces/quotes/secrets. */
const id = (v: unknown): string | undefined => typeof v === 'string' && /^~?[a-zA-Z0-9_./:-]{1,160}$/.test(v) && !/^(sk-|Bearer|eyJ)/i.test(v) ? v : undefined;
/** Upstream provider display names may contain spaces ("Google Vertex"). */
const providerName = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9 _.()-]{1,80}$/.test(v) && !/^(sk-|Bearer|eyJ)/i.test(v) ? v.trim() : undefined;
/** Safe identifier names only; values are never read here. */
const fieldNames = (names: string[]): string[] => [...new Set(names.filter((n) => /^[$a-zA-Z0-9_.-]{1,60}$/.test(n)))].sort().slice(0, 60);
const money = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
type CostFields = { cost?: number; cache_discount?: number; upstream_input_cost?: number };
/**
 * OpenRouter usage accounting: billed USD, cache discount (positive = saved, negative = write premium) and
 * `cost_details.upstream_inference_input_cost` (actual input cost after caching). Chat responses send no
 * cache_discount (checked via usage field names), so the summary derives savings from the input cost.
 */
function costFields(raw: unknown): CostFields {
  const u = record(raw);
  const input = record(u.input_tokens_details);
  const prompt = record(u.prompt_tokens_details);
  const cost = money(u.cost);
  const discount = money(u.cache_discount ?? input.cache_discount ?? prompt.cache_discount);
  const upstreamInput = money(record(u.cost_details).upstream_inference_input_cost);
  return {
    ...(cost === undefined ? {} : { cost }),
    ...(discount === undefined ? {} : { cache_discount: discount }),
    ...(upstreamInput === undefined ? {} : { upstream_input_cost: upstreamInput }),
  };
}
function normalize(raw: unknown): Usage {
  const u = record(raw);
  const input = record(u.input_tokens_details);
  const prompt = record(u.prompt_tokens_details);
  const output = record(u.output_tokens_details);
  const completion = record(u.completion_tokens_details);
  const candidates = {
    input_tokens: u.prompt_tokens ?? u.input_tokens,
    output_tokens: u.completion_tokens ?? u.output_tokens,
    cached_tokens: u.cached_tokens ?? prompt.cached_tokens ?? input.cached_tokens ?? u.cache_read_input_tokens,
    cache_write_tokens: u.cache_write_tokens ?? input.cache_write_tokens ?? u.cache_creation_input_tokens,
    reasoning_tokens: u.reasoning_tokens ?? output.reasoning_tokens ?? completion.reasoning_tokens,
  };
  return Object.fromEntries(Object.entries(candidates).flatMap(([k, v]) => token(v) === undefined ? [] : [[k, v]]));
}

function usageLogDir(ctx: LlmUsageContext | undefined): string {
  return path.resolve(process.env.MY_AGENT_LLM_USAGE_LOG_DIR || path.join(ctx?.cqrRoot ?? process.cwd(), 'data', 'logs', 'llm-usage'));
}

function requestPurpose(pathname: string, ctx: LlmUsageContext | undefined): LlmUsagePurpose {
  if (pathname.endsWith('/decisions')) return 'approval';
  if (pathname.endsWith('/embeddings')) return 'embedding';
  return ctx?.purpose ?? 'chat';
}

/** Name fallback for image generators (`google/gemini-3-pro-image`, `openai/gpt-image-1`, `imagen-4`, `flux.2-pro`). */
const IMAGE_MODEL_RE = /(?:^|[/_.:-])(?:image|gpt-image|dall-e|imagen|flux)(?:[-_.:]|$)/i;
/**
 * The provider's `/models` listing decides first (`architecture.output_modalities` includes "image", persisted
 * with the price table); the id pattern is used only for models that listing does not describe.
 */
export function isImageGenerationModelId(model: string | undefined, providerId?: string): boolean {
  if (typeof model !== 'string' || !model) return false;
  let outputs: string[] | undefined;
  try { outputs = lookupModelPricingAny(model.replace(/^~/, ''), providerId)?.outputs; } catch { outputs = undefined; }
  if (Array.isArray(outputs) && outputs.length) return outputs.includes('image');
  return IMAGE_MODEL_RE.test(model);
}
/** Explicit context wins; an unlabelled call to an image model is image generation, not chat. */
function resolvePurpose(pathname: string, ctx: LlmUsageContext | undefined, model: string | undefined): LlmUsagePurpose {
  const purpose = requestPurpose(pathname, ctx);
  return purpose === 'chat' && !ctx?.purpose && isImageGenerationModelId(model, ctx?.providerId) ? 'image' : purpose;
}

const SALVAGE_HEAD = 8_192;
const SALVAGE_TAIL = 65_536;
const keepTail = (s: string): string => s.length > SALVAGE_TAIL ? s.slice(-SALVAGE_TAIL) : s;
/** Balanced JSON object starting at `start` (`{`), string/escape aware. */
function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  return undefined;
}
/**
 * Oversized event/body (image models put the whole base64 image into `response.completed`): only its head and
 * tail were kept. `type`/`model` come from the head, the trailing `usage` object (tokens + `cost`) from the tail.
 */
export function salvageOversizedJson(head: string, tail: string): Record<string, unknown> | undefined {
  const doc: Record<string, unknown> = {};
  const type = /"type"\s*:\s*"([a-zA-Z_.]{1,60})"/.exec(head)?.[1];
  if (type) doc.type = type;
  const model = /"model"\s*:\s*"([^"\\]{1,160})"/.exec(head)?.[1];
  if (model) doc.model = model;
  const provider = /"provider"\s*:\s*"([^"\\]{1,80})"/.exec(tail)?.[1];
  if (provider) doc.provider = provider;
  let at = tail.lastIndexOf('"usage"');
  while (at >= 0) {
    const m = /^"usage"\s*:\s*\{/.exec(tail.slice(at, at + 64));
    const obj = m ? balancedObject(tail, at + m[0].length - 1) : undefined;
    if (obj) {
      try { doc.usage = JSON.parse(obj); break; } catch { /* keep searching earlier */ }
    }
    at = at > 0 ? tail.lastIndexOf('"usage"', at - 1) : -1;
  }
  return doc.usage !== undefined || doc.type !== undefined ? doc : undefined;
}

function backfillDelays(): number[] {
  const raw = process.env.MY_AGENT_LLM_USAGE_BACKFILL_DELAYS_MS;
  const parsed = raw ? raw.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 5) : [];
  return parsed.length ? parsed : [2_000, 6_000, 15_000];
}
const GENERATION_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const backfillDisabled = (): boolean => /^(0|off|false|no)$/i.test(process.env.MY_AGENT_LLM_USAGE_BACKFILL ?? '');
/** OpenRouter generation-stats URL next to the inference endpoint (`/api/v1/responses` → `/api/v1/generation`). */
function generationStatsUrl(url: string, generationId: string): string | undefined {
  if (!GENERATION_ID_RE.test(generationId)) return undefined;
  const u = new URL(url);
  const pathname = u.pathname.replace(/\/(responses|chat\/completions|messages)$/, '/generation');
  return pathname === u.pathname ? undefined : `${u.origin}${pathname}?id=${encodeURIComponent(generationId)}`;
}
type BackfillResult = { kind: 'filled'; row: Record<string, unknown> } | { kind: 'retry' } | { kind: 'stop' };
/** One generation-stats lookup. `retry` = not ready yet / transient; `stop` = will never answer (auth, bad id). */
async function fetchGenerationCost(target: string, authorization: string | null): Promise<BackfillResult> {
  try {
    const res = await fetch(target, { headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 429 || res.status >= 500) return { kind: 'retry' };
    if (!res.ok) return { kind: 'stop' };
    const data = record(record(await res.json()).data);
    const cost = money(data.total_cost);
    if (cost === undefined) return { kind: 'retry' };
    const input = token(data.native_tokens_prompt ?? data.tokens_prompt);
    return {
      kind: 'filled',
      row: {
        event: 'cost_backfill', backfill_source: 'generation', backfilled_at: new Date().toISOString(),
        provider_cost_usd: cost, cache_discount_usd: money(data.cache_discount) ?? null,
        input_tokens: input ?? null, total_input_tokens: input ?? null,
        output_tokens: token(data.native_tokens_completion ?? data.tokens_completion) ?? null,
        cached_tokens: token(data.native_tokens_cached) ?? null,
        reasoning_tokens: token(data.native_tokens_reasoning) ?? null,
        upstream_provider: providerName(data.provider_name) ?? null,
      },
    };
  } catch { return { kind: 'retry' }; }
}
/**
 * The reply carried no billed cost (usage lost/absent) but OpenRouter named the generation: ask its stats API
 * later and append a `cost_backfill` row (same call_id) that the summary merges. Never throws, never blocks.
 * Timers die with the app; the finish row keeps `generation_id` so recoverPendingCostBackfills can finish later.
 */
function scheduleCostBackfill(url: string, generationId: string, authorization: string | null, write: (row: Record<string, unknown>) => void): void {
  if (backfillDisabled()) return;
  const target = generationStatsUrl(url, generationId);
  if (!target) return;
  const delays = backfillDelays();
  const attempt = (i: number) => {
    const timer = setTimeout(async () => {
      const result = await fetchGenerationCost(target, authorization);
      if (result.kind === 'filled') write(result.row);
      else if (result.kind === 'retry' && i + 1 < delays.length) attempt(i + 1);
    }, delays[i]);
    timer.unref?.();
  };
  attempt(0);
}

const RECOVERY_MIN_INTERVAL_MS = 60_000;
/** Rows younger than this still have their in-process timers running. */
const RECOVERY_MIN_AGE_MS = 60_000;
const RECOVERY_MAX_ROWS = 20;
let lastRecoveryAt = 0;
const recoveryGaveUp = new Set<string>();
/**
 * Finish rows that kept `generation_id` but never got a cost (the app closed before the delayed lookup, or
 * the stats API was not ready): look them up once more. Called when the usage page loads; throttled, bounded,
 * OpenRouter hosts only. `authFor` returns the `authorization` header of the matching connection (never logged).
 */
export async function recoverPendingCostBackfills(options: {
  cqrRoot: string;
  authFor: (providerId: string | undefined, host: string) => string | null;
  now?: number;
  maxAgeDays?: number;
  /** Tests: skip the once-a-minute throttle. */
  force?: boolean;
  /** Tests: stats URL for a logged host (default `https://{host}/api/v1/generation?id=`). */
  statsUrlFor?: (host: string, generationId: string) => string;
}): Promise<number> {
  if (backfillDisabled() || /^(0|off|false|no)$/i.test(process.env.MY_AGENT_LLM_USAGE_LOG ?? '')) return 0;
  const now = options.now ?? Date.now();
  if (!options.force && now - lastRecoveryAt < RECOVERY_MIN_INTERVAL_MS) return 0;
  lastRecoveryAt = now;
  const dir = usageLogDir({ cqrRoot: options.cqrRoot });
  const days = Math.max(1, Math.min(7, options.maxAgeDays ?? 3));
  type Pending = { file: string; callId: string; generationId: string; host: string; providerId?: string };
  const pending: Pending[] = [];
  for (let i = 0; i <= days && pending.length < RECOVERY_MAX_ROWS; i += 1) {
    const file = path.join(dir, `llm-usage-${new Date(now - i * 86_400_000).toISOString().slice(0, 10)}.jsonl`);
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes('"generation_id"')) continue;
    const filled = new Set<string>();
    const candidates: Pending[] = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"cost_backfill"') && !line.includes('"generation_id"')) continue;
      let row: Record<string, unknown>;
      try { row = record(JSON.parse(line)); } catch { continue; }
      const callId = typeof row.call_id === 'string' ? row.call_id : '';
      if (!callId) continue;
      if (row.event === 'cost_backfill') { filled.add(callId); continue; }
      const generationId = typeof row.generation_id === 'string' ? row.generation_id : '';
      const host = typeof row.endpoint_host === 'string' ? row.endpoint_host.toLowerCase() : '';
      const finished = Date.parse(String(row.finished_at ?? ''));
      if (row.event !== 'finish' || row.provider_cost_usd != null || !GENERATION_ID_RE.test(generationId)) continue;
      if (host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) continue;
      if (!Number.isFinite(finished) || now - finished < RECOVERY_MIN_AGE_MS || recoveryGaveUp.has(callId)) continue;
      candidates.push({ file, callId, generationId, host, providerId: id(row.provider_id) });
    }
    for (const c of candidates) if (!filled.has(c.callId) && pending.length < RECOVERY_MAX_ROWS) pending.push(c);
  }
  let count = 0;
  for (const p of pending) {
    const target = options.statsUrlFor?.(p.host, p.generationId)
      ?? `https://${p.host}/api/v1/generation?id=${encodeURIComponent(p.generationId)}`;
    let authorization: string | null = null;
    try { authorization = options.authFor(p.providerId, p.host); } catch { authorization = null; }
    if (!authorization) { recoveryGaveUp.add(p.callId); continue; }
    const result = await fetchGenerationCost(target, authorization);
    if (result.kind === 'stop') recoveryGaveUp.add(p.callId);
    if (result.kind !== 'filled') continue;
    try {
      appendFileSync(p.file, JSON.stringify({ version: 1, call_id: p.callId, ...result.row, backfill_recovered: true }) + '\n', 'utf8');
      count += 1;
    } catch { /* best-effort */ }
  }
  return count;
}

/**
 * One `finish` row for provider jobs that are not a single streamed HTTP call (async video jobs).
 * Same body-free schema as fetchWithUsage; never throws.
 */
export function recordLlmUsageEvent(event: {
  model?: string;
  endpointHost?: string;
  outcome: string;
  costUsd?: number;
  startedAt?: number;
  httpStatus?: number;
  purpose?: LlmUsagePurpose;
}): void {
  if (/^(0|off|false|no)$/i.test(process.env.MY_AGENT_LLM_USAGE_LOG ?? '')) return;
  try {
    const ctx = context.getStore();
    const started = event.startedAt ?? Date.now();
    const dir = usageLogDir(ctx);
    const row = {
      version: 1, call_id: randomUUID(), event: 'finish', started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(), duration_ms: Math.max(0, Date.now() - started),
      session_id: id(ctx?.sessionId), run_id: id(ctx?.runId), provider_id: id(ctx?.providerId),
      purpose: event.purpose ?? ctx?.purpose ?? 'chat', wire_api: 'job', model: id(event.model), stream: false, attempt: 1,
      endpoint_host: event.endpointHost, http_status: event.httpStatus ?? null, outcome: event.outcome,
      usage_status: 'unavailable', input_tokens: null, output_tokens: null, cached_tokens: null,
      cache_write_tokens: null, reasoning_tokens: null, total_input_tokens: null,
      provider_cost_usd: money(event.costUsd) ?? null, cache_discount_usd: null, usage_source: 'provider',
    };
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `llm-usage-${new Date(started).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* logging must never break generation */ }
  try { context.getStore()?.collect?.({ cost_usd: money(event.costUsd) }); } catch { /* optional */ }
}

/** Same fetch contract; observes bytes only while the caller consumes them. No tee/background drain. */
export async function fetchWithUsage(url: string, init: RequestInit, attempt = 1): Promise<Response> {
  if (/^(0|off|false|no)$/i.test(process.env.MY_AGENT_LLM_USAGE_LOG ?? '')) return fetch(url, init);
  const ctx = context.getStore();
  const started = Date.now();
  let body: Record<string, unknown> = {};
  try { body = record(JSON.parse(typeof init.body === 'string' ? init.body : '{}')); } catch { /* counts unavailable */ }
  const wire: Wire = new URL(url).pathname.endsWith('/responses') ? 'responses' : new URL(url).pathname.endsWith('/messages') ? 'messages' : 'chat';
  const stream = body.stream === true;
  const callId = randomUUID();
  const dir = usageLogDir(ctx);
  const logPath = path.join(dir, `llm-usage-${new Date(started).toISOString().slice(0, 10)}.jsonl`);
  let step: number | undefined;
  try { step = token(ctx?.step?.()); } catch { /* optional context must not affect inference */ }
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const base = {
    version: 1, call_id: callId, started_at: new Date(started).toISOString(),
    session_id: id(ctx?.sessionId), run_id: id(ctx?.runId), provider_id: id(ctx?.providerId), step,
    wire_api: wire, purpose: resolvePurpose(new URL(url).pathname, ctx, id(body.model)), model: id(body.model), stream, attempt,
    ...(ctx?.probe === true ? { probe: true } : {}),
    endpoint_hash: createHash('sha256').update(new URL(url).origin + new URL(url).pathname).digest('hex').slice(0, 24),
    request_bytes: typeof init.body === 'string' ? Buffer.byteLength(init.body) : undefined,
    // Only the host: never URL credentials, paths, query parameters or request headers.
    endpoint_host: new URL(url).host,
    max_output_tokens: token(body.max_output_tokens) ?? null,
    max_completion_tokens: token(body.max_completion_tokens) ?? null,
    max_tokens: token(body.max_tokens) ?? null,
    input_items: items.length, tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
    instructions_chars: typeof body.instructions === 'string' ? body.instructions.length : 0,
    previous_response: typeof body.previous_response_id === 'string',
    // Presence only — the pin value itself is never logged.
    session_pinned: new Headers(init.headers).has('x-session-id') || typeof body.session_id === 'string',
  };
  const write = (row: Record<string, unknown>) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(logPath, JSON.stringify({ ...base, ...row }) + '\n', 'utf8');
    } catch { /* disk full/permission/logging errors must never break model calls */ }
  };
  write({ event: 'start' });
  let usage: Usage = {};
  let terminal = false;
  let providerFailed = false;
  let invalid = false;
  let truncated = false;
  /** Usage recovered from the tail of an oversized event/body. */
  let salvaged = false;
  let finished = false;
  let status: number | undefined;
  let responseModel: string | undefined;
  let upstreamProvider: string | undefined;
  /** Field/header NAMES only (never values) — diagnoses where upstream provider is reported. */
  let terminalFieldNames: string[] | undefined;
  let costs: CostFields = {};
  let errorDiagnostics: ReturnType<typeof providerErrorDiagnostics> | undefined;
  let responseHeaders: Headers | undefined;
  let removeAbort = () => {};
  const finish = (outcome: string) => {
    if (finished) return;
    finished = true;
    removeAbort();
    const generationHeader = responseHeaders?.get('x-generation-id') ?? '';
    const generationId = costs.cost === undefined && status !== undefined && status < 400 && GENERATION_ID_RE.test(generationHeader)
      ? generationHeader : undefined;
    const input = usage.input_tokens;
    const totalInput = wire === 'messages'
      ? (input !== undefined && usage.cached_tokens !== undefined && usage.cache_write_tokens !== undefined
        ? input + usage.cached_tokens + usage.cache_write_tokens : null)
      : input ?? null;
    write({
      event: 'finish', finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
      http_status: status ?? null, outcome, response_model: responseModel,
      usage_status: usage.input_tokens !== undefined && usage.output_tokens !== undefined ? 'reported' : Object.keys(usage).length ? 'partial' : 'unavailable',
      input_tokens: input ?? null, output_tokens: usage.output_tokens ?? null,
      cached_tokens: usage.cached_tokens ?? null, cache_write_tokens: usage.cache_write_tokens ?? null,
      reasoning_tokens: usage.reasoning_tokens ?? null, total_input_tokens: totalInput,
      input_semantics: wire === 'messages' ? 'excludes_cache' : 'includes_cache',
      upstream_provider: upstreamProvider ?? null,
      ...(upstreamProvider === undefined && status !== undefined && status < 400 ? {
        provider_probe: {
          terminal_fields: terminalFieldNames ?? null,
          header_names: fieldNames(responseHeaders ? [...responseHeaders.keys()].filter((h) => /^(x-|openrouter)/i.test(h)) : []),
        },
      } : {}),
      provider_cost_usd: costs.cost ?? null,
      cache_discount_usd: costs.cache_discount ?? null,
      upstream_input_cost_usd: costs.upstream_input_cost ?? null,
      usage_source: 'provider', observation_truncated: truncated,
      ...(salvaged ? { usage_salvaged: true } : {}),
      // Kept only when the cost is missing, so a later app start can still look it up.
      ...(generationId ? { generation_id: generationId } : {}),
      error_diagnostics: errorDiagnostics,
    });
    if (generationId) scheduleCostBackfill(url, generationId, new Headers(init.headers).get('authorization'), write);
    try { ctx?.collect?.({ input_tokens: input, output_tokens: usage.output_tokens, cost_usd: costs.cost }); } catch { /* optional */ }
  };
  const observe = (doc: Record<string, unknown>) => {
    const response = record(doc.response);
    const message = record(doc.message);
    const raw = doc.usage ?? response.usage ?? message.usage;
    // Providers send cumulative snapshots, not increments. Never add snapshots.
    usage = { ...usage, ...normalize(raw) };
    costs = { ...costs, ...costFields(raw) };
    responseModel = id(doc.model ?? response.model ?? message.model) ?? responseModel;
    upstreamProvider = providerName(doc.provider ?? response.provider ?? message.provider) ?? upstreamProvider;
    if (doc.error || response.error || ['error', 'response.failed', 'response.incomplete'].includes(String(doc.type)) || ['failed', 'incomplete'].includes(String(doc.status))) {
      providerFailed = true;
      errorDiagnostics = providerErrorDiagnostics(doc, { status: status ?? 200, headers: responseHeaders ?? new Headers() });
    }
    if (doc.type === 'response.completed' || doc.type === 'message_stop') terminal = true;
    if (doc.type === 'response.completed' || !stream) {
      terminalFieldNames = fieldNames([...Object.keys(doc).map((k) => `$.${k}`), ...Object.keys(response).map((k) => `response.${k}`)]);
    }
  };
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) {
    finish(init.signal?.aborted ? 'aborted' : 'network_error');
    throw error;
  }
  status = response.status;
  responseHeaders = response.headers;
  // Retryable HTTP errors may never be consumed. Record them now, with unknown usage.
  if (!response.ok) {
    errorDiagnostics = providerErrorDiagnostics(undefined, response);
    finish('http_error');
  }
  if (!response.body) { finish('no_body'); return response; }
  const abort = () => finish('aborted');
  if (!finished) init.signal?.addEventListener('abort', abort, { once: true });
  removeAbort = () => init.signal?.removeEventListener('abort', abort);
  if (init.signal?.aborted) abort();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const observingStream = response.ok && stream;
  const maxBuffer = !response.ok ? 32_768 : observingStream ? 1_048_576 : 8_388_608;
  let errorDetailWritten = false;
  const writeErrorDetail = (observation: string) => {
    if (response.ok || errorDetailWritten) return;
    errorDetailWritten = true;
    write({ event: 'http_error_detail', http_status: status, error_observation: observation,
      error_diagnostics: errorDiagnostics, observation_truncated: truncated });
  };
  let frameData = '';
  let skipFrame = false;
  /** A long line still arriving (no newline yet): only head + rolling tail are kept. */
  let longLine: { head: string; tail: string } | null = null;
  /** Current SSE frame overflowed: head + rolling tail of its data for usage salvage. */
  let salvageFrame: { head: string; tail: string } | null = null;
  /** Non-stream body over the cap. */
  let bodyHead = '';
  let bodyTail = '';
  const parse = (text: string) => {
    try { observe(record(JSON.parse(text))); } catch { invalid = true; }
  };
  const salvage = (head: string, tail: string) => {
    const doc = salvageOversizedJson(head, tail);
    if (!doc) return;
    if (doc.usage !== undefined) salvaged = true;
    observe(doc);
  };
  const overflowFrame = (data: string) => {
    truncated = true;
    skipFrame = true;
    frameData = '';
    if (!salvageFrame) salvageFrame = { head: data.slice(0, SALVAGE_HEAD), tail: keepTail(data) };
    else salvageFrame.tail = keepTail(salvageFrame.tail + '\n' + data);
  };
  const flushFrame = () => {
    if (salvageFrame) salvage(salvageFrame.head, salvageFrame.tail);
    else if (!skipFrame && frameData) {
      if (frameData.trim() === '[DONE]') terminal = true;
      else parse(frameData);
    }
    frameData = '';
    skipFrame = false;
    salvageFrame = null;
  };
  const longDataLine = (line: { head: string; tail: string }) => {
    truncated = true;
    const head = line.head.trimStart();
    if (!head.startsWith('data:') || (skipFrame && !salvageFrame)) { skipFrame = true; frameData = ''; return; }
    if (salvageFrame) salvageFrame.tail = keepTail(salvageFrame.tail + '\n' + line.tail);
    else {
      const start = (frameData ? frameData + '\n' : '') + head.slice(5).trimStart();
      salvageFrame = { head: start.slice(0, SALVAGE_HEAD), tail: line.tail };
    }
    skipFrame = true;
    frameData = '';
  };
  const feed = (text: string, eof = false) => {
    if (!observingStream) {
      if (!truncated) {
        if (buffer.length + text.length > maxBuffer) {
          truncated = true;
          const whole = buffer + text;
          bodyHead = whole.slice(0, SALVAGE_HEAD);
          bodyTail = keepTail(whole);
          buffer = '';
        } else buffer += text;
      } else bodyTail = keepTail(bodyTail + text);
      if (eof && truncated && response.ok) salvage(bodyHead, bodyTail);
      if (eof && !truncated) {
        if (response.ok) parse(buffer);
        else {
          try { errorDiagnostics = providerErrorDiagnostics(JSON.parse(buffer), response); } catch { invalid = true; }
        }
      }
      if (eof) writeErrorDetail(truncated ? 'truncated' : invalid ? 'invalid_json' : 'parsed');
      return;
    }
    if (longLine) {
      const nl = text.indexOf('\n');
      if (nl < 0) { longLine.tail = keepTail(longLine.tail + text); text = ''; }
      else {
        longLine.tail = keepTail(longLine.tail + text.slice(0, nl));
        const done = longLine;
        longLine = null;
        longDataLine(done);
        text = text.slice(nl + 1);
      }
    }
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) flushFrame();
      else if (line.length > maxBuffer) longDataLine({ head: line.slice(0, SALVAGE_HEAD), tail: keepTail(line) });
      else if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (skipFrame) { if (salvageFrame) salvageFrame.tail = keepTail(salvageFrame.tail + '\n' + data); }
        else if (frameData.length + data.length > maxBuffer) overflowFrame(frameData + (frameData ? '\n' : '') + data);
        else frameData += (frameData ? '\n' : '') + data;
      }
    }
    if (buffer.length > maxBuffer) {
      longLine = { head: buffer.slice(0, SALVAGE_HEAD), tail: keepTail(buffer) };
      buffer = '';
      truncated = true;
    }
    if (eof && (buffer || longLine)) { const tail = buffer; buffer = ''; feed(tail + '\n'); }
    if (eof) flushFrame();
  };
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          feed(decoder.decode(), true);
          finish(providerFailed ? 'provider_error' : invalid ? 'invalid_response' : stream && !terminal ? 'incomplete' : 'completed');
          reader.releaseLock();
          controller.close();
        } else {
          // Observation is diagnostic-only; parsing must not change byte delivery.
          try { feed(decoder.decode(value, { stream: true })); } catch { truncated = true; }
          controller.enqueue(value);
        }
      } catch (error) {
        writeErrorDetail('read_error');
        finish(init.signal?.aborted ? 'aborted' : 'read_error');
        try { reader.releaseLock(); } catch { /* keep original read error */ }
        controller.error(error);
      }
    },
    async cancel(reason) {
      writeErrorDetail('cancelled');
      finish(providerFailed ? 'provider_error' : terminal ? 'completed' : 'cancelled');
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  const result = new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(result, 'url', { value: response.url });
  return result;
}
