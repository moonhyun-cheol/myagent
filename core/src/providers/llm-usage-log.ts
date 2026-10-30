/** Local, body-free accounting at the actual HTTP-attempt boundary. Not telemetry. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { providerErrorDiagnostics } from './provider-error-diagnostics.js';

/** What the request was for, so the usage page can split chat from approvals/images/videos. */
export type LlmUsagePurpose = 'chat' | 'approval' | 'image' | 'video' | 'embedding';

export interface LlmUsageContext {
  cqrRoot?: string;
  sessionId?: string;
  runId?: string;
  providerId?: string;
  purpose?: LlmUsagePurpose;
  step?: () => number;
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
const id = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(v) && !/^(sk-|Bearer|eyJ)/i.test(v) ? v : undefined;
/** Upstream provider display names may contain spaces ("Google Vertex"). */
const providerName = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9 _.()-]{1,80}$/.test(v) && !/^(sk-|Bearer|eyJ)/i.test(v) ? v.trim() : undefined;
/** Safe identifier names only; values are never read here. */
const fieldNames = (names: string[]): string[] => [...new Set(names.filter((n) => /^[$a-zA-Z0-9_.-]{1,60}$/.test(n)))].sort().slice(0, 60);
const money = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** OpenRouter usage accounting: billed USD and cache discount (positive = saved, negative = write premium). */
function costFields(raw: unknown): { cost?: number; cache_discount?: number } {
  const u = record(raw);
  const input = record(u.input_tokens_details);
  const prompt = record(u.prompt_tokens_details);
  const cost = money(u.cost);
  const discount = money(u.cache_discount ?? input.cache_discount ?? prompt.cache_discount);
  return { ...(cost === undefined ? {} : { cost }), ...(discount === undefined ? {} : { cache_discount: discount }) };
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
    wire_api: wire, purpose: requestPurpose(new URL(url).pathname, ctx), model: id(body.model), stream, attempt,
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
  let finished = false;
  let status: number | undefined;
  let responseModel: string | undefined;
  let upstreamProvider: string | undefined;
  /** Field/header NAMES only (never values) — diagnoses where upstream provider is reported. */
  let terminalFieldNames: string[] | undefined;
  let costs: { cost?: number; cache_discount?: number } = {};
  let errorDiagnostics: ReturnType<typeof providerErrorDiagnostics> | undefined;
  let responseHeaders: Headers | undefined;
  let removeAbort = () => {};
  const finish = (outcome: string) => {
    if (finished) return;
    finished = true;
    removeAbort();
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
      usage_source: 'provider', observation_truncated: truncated,
      error_diagnostics: errorDiagnostics,
    });
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
  let skipLine = false;
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
  const parse = (text: string) => {
    try { observe(record(JSON.parse(text))); } catch { invalid = true; }
  };
  const flushFrame = () => {
    if (!skipFrame && frameData) {
      if (frameData.trim() === '[DONE]') terminal = true;
      else parse(frameData);
    }
    frameData = '';
    skipFrame = false;
  };
  const feed = (text: string, eof = false) => {
    if (!observingStream) {
      if (!truncated) {
        if (buffer.length + text.length > maxBuffer) { truncated = true; buffer = ''; }
        else buffer += text;
      }
      if (eof && !truncated) {
        if (response.ok) parse(buffer);
        else {
          try { errorDiagnostics = providerErrorDiagnostics(JSON.parse(buffer), response); } catch { invalid = true; }
        }
      }
      if (eof) writeErrorDetail(truncated ? 'truncated' : invalid ? 'invalid_json' : 'parsed');
      return;
    }
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (skipLine) { skipLine = false; continue; }
      if (!line) flushFrame();
      else if (line.length > maxBuffer) { truncated = true; skipFrame = true; frameData = ''; }
      else if (line.startsWith('data:') && !skipFrame) {
        const data = line.slice(5).trim();
        if (frameData.length + data.length > maxBuffer) { truncated = true; skipFrame = true; frameData = ''; }
        else frameData += (frameData ? '\n' : '') + data;
      }
    }
    if (buffer.length > maxBuffer) { buffer = ''; skipLine = true; truncated = true; skipFrame = true; frameData = ''; }
    if (eof && buffer && !skipLine) { const tail = buffer; buffer = ''; feed(tail + '\n'); }
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
