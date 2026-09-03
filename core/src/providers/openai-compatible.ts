import { logLlmWireRequest, logLlmWireResponse } from './llm-wire-log.js';
import type { ProviderWireApi } from './types.js';
import type { ResponsesContinuationState } from '../sessions/types.js';
import {
  responsesCompletion,
  responsesCompletionStream,
  responsesCompletionWithTools,
} from './responses-compatible.js';
import {
  messagesCompletion,
  messagesCompletionStream,
  messagesCompletionWithTools,
} from './anthropic-messages.js';
import {
  compilePromptContext,
  type PromptContextMetadata,
} from './prompt-context-cache.js';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ChatContentPart[];
  tool_calls?: AgentToolCallPayload[];
  tool_call_id?: string;
  /**
   * Volatile per-step guidance kept outside the stable cacheable prefix. It is a
   * user-tail message for Chat Completions/Anthropic and is promoted to native
   * instructions by the Responses adapter. The flag is never sent on the wire.
   */
  ephemeral?: boolean;
}

/** Flatten multimodal content to plain text (for agent loops / logging). */
export function chatContentToText(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === 'text') chunks.push(part.text);
    else if (part.type === 'image_url' && part.image_url?.url) {
      chunks.push('[image]');
    }
  }
  return chunks.join('\n');
}

export interface AgentToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolCompletionResult {
  content: string | null;
  tool_calls: AgentToolCallPayload[];
  model: string;
  finish_reason?: string | null;
  /** Model chain-of-thought when provider exposes reasoning_content / reasoning. */
  reasoning?: string | null;
  response_id?: string;
  usage?: CompletionUsage;
}

export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage?: CompletionUsage;
  response_id?: string;
}

export type StreamTokenHandler = (text: string) => void;
export type ThoughtTokenHandler = (text: string) => void;

export interface ToolStreamHandlers {
  onThought?: ThoughtTokenHandler;
  onContent?: StreamTokenHandler;
}

export interface ChatCompletionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  toolChoice?: 'auto' | 'required' | 'none';
  /** Ask providers that support it to emit multiple independent tool calls. */
  parallelToolCalls?: boolean;
  stream?: boolean;
  /** Merged into chat/completions JSON body (e.g. provider-specific knobs). */
  extraBody?: Record<string, unknown>;
  /** OpenAI-style reasoning_effort when set (omit when undefined/null). */
  reasoningEffort?: string | null;
  /** Public reasoning/thinking delta explicitly exposed by the provider. */
  onThought?: ThoughtTokenHandler;
  /** Responses is primary when selected; Chat Completions remains the compatibility fallback. */
  wireApi?: ProviderWireApi;
  /** Mutable, session-owned Responses chain state. Ignored by other transports. */
  responsesState?: ResponsesContinuationState;
  /** Persist only after a completed response; incomplete/failed streams never advance. */
  onResponsesState?: (state: ResponsesContinuationState) => void;
  /** Default automatic. `off` disables provider-side prompt cache hints. */
  promptCacheMode?: 'automatic' | 'off';
  /** Produced locally after deterministic prefix compilation. */
  promptContext?: PromptContextMetadata;
}

export function normalizeCompletionUsage(raw: unknown): CompletionUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const number = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;
  return {
    prompt_tokens: number(usage.prompt_tokens ?? usage.input_tokens),
    completion_tokens: number(usage.completion_tokens ?? usage.output_tokens),
    reasoning_tokens: number(usage.reasoning_tokens),
    cached_tokens: number(
      usage.cached_tokens
      ?? promptDetails?.cached_tokens
      ?? inputDetails?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_content_token_count,
    ),
    cache_write_tokens: number(
      usage.cache_write_tokens
      ?? inputDetails?.cache_write_tokens
      ?? usage.cache_creation_input_tokens,
    ),
  };
}

/** Merge model/messages/stream/tools with optional harness extras. */
export function buildChatCompletionBody(
  base: Record<string, unknown>,
  opts?: ChatCompletionOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...base };
  if (opts?.extraBody && typeof opts.extraBody === 'object') {
    Object.assign(body, opts.extraBody);
  }
  const effort = opts?.reasoningEffort?.trim();
  if (effort) body.reasoning_effort = effort;
  if (opts?.parallelToolCalls !== undefined && Array.isArray(body.tools) && body.tools.length > 0) {
    body.parallel_tool_calls = opts.parallelToolCalls;
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const { ephemeral: _ephemeral, ...wireMessage } = message as ChatMessage;
      return wireMessage;
    });
  }
  return body;
}

/** Normalize OWUI / OpenAI assistant message (string or multimodal parts). */
export function extractAssistantContent(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { content?: unknown };
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  const chunks: string[] = [];
  for (const part of m.content) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string; image_url?: { url?: string } };
    if (p.type === 'text' && typeof p.text === 'string') chunks.push(p.text);
    if (p.type === 'image_url' && p.image_url?.url) {
      const url = p.image_url.url;
      const existing = chunks.join('\n');
      // Skip redundant inline data URL when OWUI file refs are already in text parts.
      if (url.startsWith('data:image/') && /\/api\/v1\/files\/[a-f0-9-]+\/content/i.test(existing)) {
        continue;
      }
      const fileIdMatch = url.match(/\/api\/v1\/files\/([a-f0-9-]+)\/content/i);
      if (fileIdMatch && existing.includes(fileIdMatch[1])) {
        continue;
      }
      chunks.push(`![image](${url})`);
    }
  }
  return chunks.join('\n');
}

function extractApiError(data: unknown, status: number, text: string): string {
  if (data && typeof data === 'object') {
    const doc = data as Record<string, unknown>;
    if (doc.detail != null) return String(doc.detail);
    const err = doc.error as { message?: string } | undefined;
    if (err?.message) return err.message;
  }
  return formatHttpBodyError(status, text);
}

function isHtmlErrorBody(text: string): boolean {
  const t = text.trimStart().toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html');
}

/** Turn gateway HTML pages into stable error codes for UI formatting. */
export function formatHttpBodyError(status: number, text: string): string {
  if (status === 504 || status === 502 || status === 503) {
    if (isHtmlErrorBody(text)) {
      return `OWUI_GATEWAY_TIMEOUT (${status})`;
    }
  }
  if (isHtmlErrorBody(text)) {
    return `UPSTREAM_HTML_ERROR (${status})`;
  }
  return `HTTP ${status}: ${text.slice(0, 200)}`;
}

function throwIfInvalidJsonBody(status: number, text: string): never {
  throw new Error(formatHttpBodyError(status, text));
}

export function isOwuiPassthroughDisabled(message: string): boolean {
  return /OPENAI_API_PASSTHROUGH|passthrough is disabled/i.test(message);
}

/** True when native API tool_calls should fall back to TOOL_CALL text protocol. */
export function shouldFallbackToClientToolProtocol(message: string): boolean {
  return (
    isOwuiPassthroughDisabled(message) ||
    message.includes('CHAT_TOOLS_FAILED') ||
    message.includes('EMPTY_COMPLETION') ||
    /AbortError|aborted|timed?\s*out|timeout|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT/i.test(message) ||
    /Tool not found/i.test(message) ||
    /Unknown tool/i.test(message) ||
    /도구를\s*찾을\s*수\s*없/i.test(message) ||
    /tools?\s*(are\s*)?(not\s*)?(supported|available|disabled)/i.test(message) ||
    (/function[\s_-]?call/i.test(message) && /not\s+support|unsupported|disabled/i.test(message))
  );
}

/**
 * Sticky TEXT TOOL_CALL after a real API-tools failure.
 * TTL-bounded so OWUI/custom providers can re-try native tools (Cursor-like).
 * 10m (was 30m) — long sticky forces TEXT TOOL_CALL tax after a single probe miss.
 */
const clientToolProtocolSticky = new Map<string, { reason: string; at: number }>();
const CLIENT_TOOL_STICKY_TTL_MS = 10 * 60 * 1000;

export function clientToolProtocolCacheKey(
  providerId: string,
  baseUrl: string,
  modelId: string,
): string {
  return `${providerId}|${baseUrl.replace(/\/$/, '')}|${modelId}`;
}

export function rememberClientToolProtocol(key: string, reason: string): void {
  // Do not sticky speculative / preference reasons — only real API-tool failures.
  if (/IDE-style|prefer|first/i.test(reason) && !/fail|empty|passthrough|CHAT_TOOLS|no tool_calls/i.test(reason)) {
    return;
  }
  clientToolProtocolSticky.set(key, { reason: reason.slice(0, 160), at: Date.now() });
}

export function peekedClientToolProtocolReason(key: string): string | null {
  const entry = clientToolProtocolSticky.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CLIENT_TOOL_STICKY_TTL_MS) {
    clientToolProtocolSticky.delete(key);
    return null;
  }
  return entry.reason;
}

/** Clear sticky when native API tools succeed again. */
export function clearClientToolProtocol(key: string): void {
  clientToolProtocolSticky.delete(key);
}

export function describeToolProtocolFallback(message: string): string {
  if (isOwuiPassthroughDisabled(message)) {
    return 'OpenAI 호환 게이트웨이 passthrough 비활성';
  }
  if (message.includes('EMPTY_COMPLETION')) {
    return 'API tools 응답 비어 있음';
  }
  if (message.includes('CHAT_TOOLS_FAILED')) {
    return 'API tools 엔드포인트 실패';
  }
  if (/Tool not found|Unknown tool|도구를\s*찾을\s*수\s*없/i.test(message)) {
    return 'API/게이트웨이 Tool not found';
  }
  if (/AbortError|aborted|timed?\s*out|timeout|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT/i.test(message)) {
    return 'API tools 타임아웃(probe)';
  }
  return message.replace(/\s+/g, ' ').slice(0, 100);
}

/** Status line after sticky TEXT memory (debug + UX). */
export function formatStickyClientProtocolStatus(reason: string | null | undefined): string {
  const r = String(reason || '').trim();
  if (!r) return '툴 프로토콜: TEXT TOOL_CALL';
  return `툴 프로토콜: TEXT TOOL_CALL (sticky: ${r.slice(0, 80)})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxAttempts?: number; baseDelayMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < max; i++) {
    throwIfAborted(opts.signal);
    try {
      const signals: AbortSignal[] = [];
      if (opts.signal) signals.push(opts.signal);
      if (opts.timeoutMs) signals.push(AbortSignal.timeout(opts.timeoutMs));
      const signal =
        signals.length === 0
          ? undefined
          : signals.length === 1
            ? signals[0]
            : AbortSignal.any(signals);
      const res = await fetch(url, { ...init, signal });
      if (
        (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) &&
        i < max - 1
      ) {
        await sleep(base * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < max - 1) await sleep(base * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function candidateChatBases(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/$/, '');
  const bases = new Set<string>([base]);
  try {
    const u = new URL(base);
    const origin = u.origin;
    bases.add(`${origin}/api`);
    bases.add(`${origin}/openai/v1`);
    if (base.endsWith('/api/v1')) bases.add(`${origin}/api`);
  } catch {
    /* ignore */
  }
  return [...bases];
}

/** Prefer Open WebUI /openai/v1 passthrough so OWUI does not execute client-side tools. */
export function candidateToolChatBases(baseUrl: string): string[] {
  const all = candidateChatBases(baseUrl);
  const passthrough = all.filter((b) => /\/openai\/v1$/i.test(b.replace(/\/$/, '')));
  const rest = all.filter((b) => !passthrough.includes(b));
  return [...passthrough, ...rest];
}

async function chatCompletionAt(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildChatCompletionBody({ model, messages, stream: false }, opts);
  const reqId = logLlmWireRequest({
    url,
    model,
    messages,
    stream: false,
    kind: 'chat.completions',
    promptContext: opts?.promptContext,
  });
  const t0 = Date.now();
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: opts?.timeoutMs ?? 120_000, signal: opts?.signal },
  );

  const text = await res.text();
  let data: {
    error?: { message?: string };
    detail?: string;
    choices?: { message?: unknown }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(text);
  } catch {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      error: `invalid JSON: ${text.slice(0, 240)}`,
      durationMs: Date.now() - t0,
    });
    throwIfInvalidJsonBody(res.status, text);
  }

  if (!res.ok) {
    const err = extractApiError(data, res.status, text);
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      error: err,
      durationMs: Date.now() - t0,
    });
    throw new Error(err);
  }

  const content = extractAssistantContent(data.choices?.[0]?.message);
  if (!content) {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      model: data.model ?? model,
      error: 'EMPTY_COMPLETION',
      durationMs: Date.now() - t0,
    });
    throw new Error('EMPTY_COMPLETION');
  }
  logLlmWireResponse(reqId, {
    ok: true,
    status: res.status,
    model: data.model ?? model,
    content,
    usage: data.usage,
    durationMs: Date.now() - t0,
  });
  return { content, model: data.model ?? model, usage: normalizeCompletionUsage(data.usage) };
}

export async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const compiled = compilePromptContext(messages);
  const compiledOpts = { ...opts, promptContext: compiled.metadata };
  if (opts?.wireApi === 'responses') {
    return responsesCompletion(baseUrl, apiKey, model, compiled.messages, compiledOpts);
  }
  if (opts?.wireApi === 'messages') {
    return messagesCompletion(baseUrl, apiKey, model, compiled.messages, compiledOpts);
  }
  let lastErr: Error | null = null;
  for (const base of candidateChatBases(baseUrl)) {
    try {
      return await chatCompletionAt(base, apiKey, model, compiled.messages, compiledOpts);
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (!isOwuiPassthroughDisabled(lastErr.message)) break;
    }
  }
  throw lastErr ?? new Error('CHAT_FAILED');
}

export async function chatCompletionStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: StreamTokenHandler,
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const compiled = compilePromptContext(messages);
  const compiledOpts = { ...opts, promptContext: compiled.metadata };
  if (opts?.wireApi === 'responses') {
    return responsesCompletionStream(baseUrl, apiKey, model, compiled.messages, onToken, compiledOpts);
  }
  if (opts?.wireApi === 'messages') {
    return messagesCompletionStream(baseUrl, apiKey, model, compiled.messages, onToken, compiledOpts);
  }
  let lastErr: Error | null = null;
  for (const base of candidateChatBases(baseUrl)) {
    try {
      return await chatCompletionStreamAt(base, apiKey, model, compiled.messages, onToken, compiledOpts);
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (!isOwuiPassthroughDisabled(lastErr.message)) break;
    }
  }
  throw lastErr ?? new Error('CHAT_STREAM_FAILED');
}

async function chatCompletionStreamAt(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: StreamTokenHandler,
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const reqId = logLlmWireRequest({
    url,
    model,
    messages,
    stream: true,
    kind: 'chat.completions.stream',
    promptContext: opts?.promptContext,
  });
  const t0 = Date.now();
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionBody({ model, messages, stream: true }, opts)),
    },
    { timeoutMs: opts?.timeoutMs ?? 300_000, signal: opts?.signal },
  );

  if (!res.ok) {
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      logLlmWireResponse(reqId, {
        ok: false,
        status: res.status,
        stream: true,
        error: text.slice(0, 240),
        durationMs: Date.now() - t0,
      });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
    const err = extractApiError(data, res.status, text);
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      stream: true,
      error: err,
      durationMs: Date.now() - t0,
    });
    throw new Error(err);
  }

  if (!res.body) {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      stream: true,
      error: 'NO_RESPONSE_BODY',
      durationMs: Date.now() - t0,
    });
    throw new Error('NO_RESPONSE_BODY');
  }

  let full = '';
  let resolvedModel = model;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    throwIfAborted(opts?.signal);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as {
          model?: string;
          choices?: { delta?: unknown }[];
        };
        if (chunk.model) resolvedModel = chunk.model;
        const delta = extractStreamDelta(chunk.choices?.[0]?.delta);
        if (delta.thought) opts?.onThought?.(delta.thought);
        if (delta.content) {
          full += delta.content;
          onToken(delta.content);
        }
      } catch {
        /* skip malformed chunk */
      }
    }
  }

  if (!full) {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      model: resolvedModel,
      stream: true,
      error: 'EMPTY_COMPLETION',
      durationMs: Date.now() - t0,
    });
    throw new Error('EMPTY_COMPLETION');
  }
  logLlmWireResponse(reqId, {
    ok: true,
    status: res.status,
    model: resolvedModel,
    content: full,
    stream: true,
    durationMs: Date.now() - t0,
  });
  return { content: full, model: resolvedModel };
}

export async function testConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  wireApi: ProviderWireApi = 'chat_completions',
): Promise<{ ok: boolean; note: string; chat_base_url?: string }> {
  if (apiKey.startsWith('stub:')) {
    return { ok: true, note: 'STUB_KEY_OK' };
  }
  if (wireApi !== 'chat_completions') {
    try {
      await chatCompletion(baseUrl, apiKey, model, [{ role: 'user', content: 'ping' }], { wireApi });
      return {
        ok: true,
        note: wireApi === 'responses' ? 'OK · Responses 고정' : 'OK · Anthropic Messages 고정',
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, note: message.slice(0, 240) };
    }
  }
  const preferred = baseUrl.replace(/\/$/, '');
  let lastErr: string | null = null;
  for (const base of candidateChatBases(baseUrl)) {
    try {
      await chatCompletion(base, apiKey, model, [{ role: 'user', content: 'ping' }], { wireApi });
      if (base !== preferred) {
        return {
          ok: true,
          note: `OK · chat uses ${base} (gateway passthrough disabled on /openai/v1)`,
          chat_base_url: base,
        };
      }
      return {
        ok: true,
        note: 'OK · Chat Completions 고정',
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;
      if (!isOwuiPassthroughDisabled(msg)) break;
    }
  }
  return { ok: false, note: (lastErr ?? 'Connection failed').slice(0, 240) };
}

/**
 * Configuration-time native tool probe. Runtime never uses this as a fallback.
 * The model must return the required synthetic function call through the selected wire API.
 */
export async function testNativeToolConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  wireApi: ProviderWireApi,
): Promise<{ ok: boolean; note: string }> {
  if (apiKey.startsWith('stub:')) {
    return { ok: true, note: 'OK · native tools (stub)' };
  }
  try {
    const result = await chatCompletionWithTools(
      baseUrl,
      apiKey,
      model,
      [{ role: 'user', content: 'Call cqr_native_tool_probe exactly once with value="ok".' }],
      [
        {
          type: 'function',
          function: {
            name: 'cqr_native_tool_probe',
            description: 'Configuration-only probe for native function calling.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string', enum: ['ok'] } },
              required: ['value'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      ],
      { wireApi, stream: false, toolChoice: 'required', timeoutMs: 30_000 },
    );
    const call = result.tool_calls.find((row) => row.function.name === 'cqr_native_tool_probe');
    if (!call) return { ok: false, note: 'Native tools probe returned no function_call.' };
    return { ok: true, note: 'OK · native function tools' };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, note: message.slice(0, 240) };
  }
}

export interface RemoteModelInfo {
  id: string;
  /** Context window when the provider exposes it. */
  context_length?: number;
  /** Provider catalog publication time (Unix seconds when supplied by OpenRouter). */
  created_at?: number;
}

function extractContextLength(row: Record<string, unknown>): number | undefined {
  const direct = [
    row.context_length,
    row.context_window,
    row.max_context_length,
    row.max_model_len,
    row.max_tokens,
  ];
  for (const v of direct) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 1_024) return Math.floor(n);
  }
  const meta = row.meta;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    for (const key of ['context_length', 'context_window', 'max_context_length'] as const) {
      const n = typeof m[key] === 'number' ? (m[key] as number) : Number(m[key]);
      if (Number.isFinite(n) && n >= 1_024) return Math.floor(n);
    }
  }
  return undefined;
}

function remoteModelRows(data: unknown): unknown[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    const doc = data as Record<string, unknown>;
    if (Array.isArray(doc.items)) return doc.items;
    if (Array.isArray(doc.data)) return doc.data;
    if (Array.isArray(doc.models)) return doc.models;
  }
  return [];
}

/** Parse OpenAI/OWUI /models payloads into id + optional context_length. */
export function parseRemoteModels(data: unknown): RemoteModelInfo[] {
  const out: RemoteModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of remoteModelRows(data)) {
    if (typeof row === 'string') {
      if (!row || seen.has(row)) continue;
      seen.add(row);
      out.push({ id: row });
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const m = row as Record<string, unknown>;
    const idRaw = m.id ?? m.name ?? m.model;
    const id = typeof idRaw === 'string' ? idRaw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const context_length = extractContextLength(m);
    const createdRaw = m.created ?? m.created_at;
    const created_at = typeof createdRaw === 'number'
      ? createdRaw
      : typeof createdRaw === 'string' && createdRaw.trim() && Number.isFinite(Number(createdRaw))
        ? Number(createdRaw)
        : undefined;
    out.push({
      id,
      ...(context_length ? { context_length } : {}),
      ...(created_at != null ? { created_at } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function parseRemoteModelIds(data: unknown): string[] {
  return parseRemoteModels(data).map((m) => m.id);
}

export { parseRemoteModelIds };

function candidateModelBases(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/$/, '');
  const bases = new Set<string>([base]);
  try {
    const u = new URL(base);
    const origin = u.origin;
    bases.add(`${origin}/openai/v1`);
    bases.add(`${origin}/api`);
    if (base.endsWith('/api/v1')) bases.add(`${origin}/api`);
  } catch {
    /* ignore invalid URL */
  }
  return [...bases];
}

function remoteModelListUrls(baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const base of candidateModelBases(baseUrl)) {
    urls.add(`${base}/models`);
  }
  return [...urls];
}

async function fetchModelsDetailedFromUrl(url: string, apiKey: string): Promise<RemoteModelInfo[]> {
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!contentType.includes('application/json')) {
    throw new Error(`NON_JSON_RESPONSE (${res.status} ${contentType}): ${text.slice(0, 120)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`INVALID_MODELS_RESPONSE (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err =
      data && typeof data === 'object' && 'detail' in data
        ? String((data as { detail?: unknown }).detail)
        : data && typeof data === 'object' && 'error' in data
          ? String((data as { error?: { message?: string } }).error?.message ?? '')
          : `HTTP ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(err);
  }
  return parseRemoteModels(data);
}

export async function listRemoteModelsDetailed(
  baseUrl: string,
  apiKey: string,
): Promise<RemoteModelInfo[]> {
  if (apiKey.startsWith('stub:')) {
    return [
      { id: 'stub-model-a', context_length: 128_000 },
      { id: 'stub-model-b', context_length: 128_000 },
    ];
  }
  const urls = remoteModelListUrls(baseUrl);
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const models = await fetchModelsDetailedFromUrl(url, apiKey);
      if (models.length > 0) {
        const { rememberRemoteModelContext } = await import('./model-context-limits.js');
        for (const m of models) {
          if (m.context_length) rememberRemoteModelContext(m.id, m.context_length);
        }
        return models;
      }
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

export async function listRemoteModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const models = await listRemoteModelsDetailed(baseUrl, apiKey);
  return models.map((m) => m.id);
}

export async function chatCompletionStreamOrStub(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: StreamTokenHandler,
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  if (apiKey.startsWith('stub:')) {
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const text = `[stub stream · ${model}]\n${user}`;
    onToken(text);
    return { content: text, model };
  }
  return chatCompletionStream(baseUrl, apiKey, model, messages, onToken, opts);
}

/** OWUI / OpenAI / OpenRouter reasoning text that the provider explicitly exposes. */
export function extractAssistantReasoning(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as {
    reasoning_content?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    reasoning_details?: unknown;
  };
  for (const key of ['reasoning_content', 'reasoning', 'thinking'] as const) {
    const v = m[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (Array.isArray(m.reasoning_details)) {
    return m.reasoning_details
      .map((detail) => {
        if (typeof detail === 'string') return detail;
        if (!detail || typeof detail !== 'object') return '';
        const row = detail as { text?: unknown; summary?: unknown; content?: unknown };
        for (const value of [row.text, row.summary, row.content]) {
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
}

function parseAssistantMessage(message: unknown): {
  content: string | null;
  tool_calls: AgentToolCallPayload[];
  reasoning: string | null;
} {
  if (!message || typeof message !== 'object') {
    return { content: '', tool_calls: [], reasoning: null };
  }
  const m = message as {
    content?: unknown;
    tool_calls?: unknown;
  };
  let content: string | null = null;
  if (typeof m.content === 'string') content = m.content;
  else if (m.content == null) content = null;
  else content = extractAssistantContent(message);
  const reasoning = extractAssistantReasoning(message) || null;
  // Reasoning models sometimes leave `content` empty and put the answer in reasoning_*.
  if (!content?.trim() && reasoning) content = reasoning;
  const tool_calls = normalizeToolCallPayloads(m.tool_calls);
  return { content, tool_calls, reasoning };
}

/** Normalize OpenAI / OWUI / Ollama tool_call shapes into AgentToolCallPayload[]. */
export function normalizeToolCallPayloads(raw: unknown): AgentToolCallPayload[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: AgentToolCallPayload[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i];
    if (!row || typeof row !== 'object') continue;
    const tc = row as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
      name?: unknown;
      arguments?: unknown;
    };
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : null;
    const nameRaw = fn?.name ?? tc.name;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (!name) continue;
    let args = '';
    const argsRaw = fn?.arguments ?? tc.arguments;
    if (typeof argsRaw === 'string') args = argsRaw;
    else if (argsRaw != null) {
      try {
        args = JSON.stringify(argsRaw);
      } catch {
        args = String(argsRaw);
      }
    }
    const id =
      typeof tc.id === 'string' && tc.id.trim()
        ? tc.id.trim()
        : `call_${i}_${name}`;
    out.push({
      id,
      type: 'function',
      function: { name, arguments: args || '{}' },
    });
  }
  return out;
}

async function chatCompletionWithToolsAt(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
  opts?: ChatCompletionOptions,
): Promise<ToolCompletionResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const stream = opts?.stream ?? false;
  const toolChoice = opts?.toolChoice ?? 'auto';
  const reqId = logLlmWireRequest({
    url,
    model,
    messages,
    tools,
    toolChoice,
    stream,
    kind: 'chat.completions.tools',
    promptContext: opts?.promptContext,
  });
  const t0 = Date.now();
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(
        buildChatCompletionBody(
          { model, messages, tools, tool_choice: toolChoice, stream },
          opts,
        ),
      ),
    },
    // Keep retries light — multi-minute 4×180s backoff made "large fetch" feel stuck.
    { maxAttempts: 2, baseDelayMs: 800, timeoutMs: opts?.timeoutMs ?? 180_000, signal: opts?.signal },
  );

  const text = await res.text();
  let data: {
    error?: { message?: string };
    detail?: string;
    choices?: { message?: unknown; finish_reason?: string }[];
    model?: string;
  };
  try {
    data = JSON.parse(text);
  } catch {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      error: `invalid JSON: ${text.slice(0, 240)}`,
      durationMs: Date.now() - t0,
    });
    throwIfInvalidJsonBody(res.status, text);
  }
  if (!res.ok) {
    const err = extractApiError(data, res.status, text);
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      error: err,
      durationMs: Date.now() - t0,
    });
    throw new Error(err);
  }

  const choice = data.choices?.[0];
  const parsed = parseAssistantMessage(choice?.message);
  if (!parsed.content && parsed.tool_calls.length === 0) {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      model: data.model ?? model,
      finishReason: choice?.finish_reason ?? null,
      error: 'EMPTY_COMPLETION',
      durationMs: Date.now() - t0,
    });
    throw new Error('EMPTY_COMPLETION');
  }
  logLlmWireResponse(reqId, {
    ok: true,
    status: res.status,
    model: data.model ?? model,
    finishReason: choice?.finish_reason ?? null,
    content: parsed.content,
    toolCalls: parsed.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    durationMs: Date.now() - t0,
  });
  return {
    content: parsed.content,
    tool_calls: parsed.tool_calls,
    model: data.model ?? model,
    finish_reason: choice?.finish_reason ?? null,
    reasoning: parsed.reasoning,
  };
}

function extractStreamDelta(delta: unknown): {
  content?: string;
  thought?: string;
  tool_calls?: { index: number; id?: string; name?: string; arguments?: string }[];
} {
  if (!delta || typeof delta !== 'object') return {};
  const d = delta as Record<string, unknown>;
  const out: ReturnType<typeof extractStreamDelta> = {};
  if (typeof d.content === 'string' && d.content) out.content = d.content;
  const thought = extractAssistantReasoning(d);
  if (thought) out.thought = thought;
  if (Array.isArray(d.tool_calls)) {
    out.tool_calls = d.tool_calls
      .map((tc, fallbackIndex) => {
        if (!tc || typeof tc !== 'object') return null;
        const row = tc as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string | Record<string, unknown> };
          name?: string;
          arguments?: string | Record<string, unknown>;
        };
        // OWUI/Ollama often omit index when only one tool call is streamed.
        const index = typeof row.index === 'number' && Number.isFinite(row.index)
          ? row.index
          : fallbackIndex;
        const name =
          typeof row.function?.name === 'string'
            ? row.function.name
            : typeof row.name === 'string'
              ? row.name
              : undefined;
        let args: string | undefined;
        const argsRaw = row.function?.arguments ?? row.arguments;
        if (typeof argsRaw === 'string') args = argsRaw;
        else if (argsRaw != null && typeof argsRaw === 'object') {
          try {
            args = JSON.stringify(argsRaw);
          } catch {
            args = undefined;
          }
        }
        return {
          index,
          id: typeof row.id === 'string' ? row.id : undefined,
          name,
          arguments: args,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
  }
  return out;
}

function mergeToolCallDeltas(
  acc: Map<number, AgentToolCallPayload>,
  deltas: { index: number; id?: string; name?: string; arguments?: string }[],
): void {
  for (const d of deltas) {
    const prev = acc.get(d.index) ?? {
      id: d.id ?? '',
      type: 'function' as const,
      function: { name: d.name ?? '', arguments: '' },
    };
    if (d.id) prev.id = d.id;
    if (d.name) prev.function.name = d.name;
    if (d.arguments) prev.function.arguments += d.arguments;
    acc.set(d.index, prev);
  }
}

function finalizeStreamedToolCalls(
  toolAcc: Map<number, AgentToolCallPayload>,
): AgentToolCallPayload[] {
  return [...toolAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, tc], i) => {
      const name = (tc.function.name || '').trim();
      if (!name) return null;
      const id = (tc.id || '').trim() || `call_${index}_${name || i}`;
      return {
        id,
        type: 'function' as const,
        function: {
          name,
          arguments: tc.function.arguments || '{}',
        },
      };
    })
    .filter((tc): tc is AgentToolCallPayload => tc != null);
}

async function chatCompletionWithToolsStreamAt(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
  handlers: ToolStreamHandlers,
  opts?: ChatCompletionOptions,
): Promise<ToolCompletionResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const toolChoice = opts?.toolChoice ?? 'auto';
  const stream = opts?.stream ?? true;
  const reqId = logLlmWireRequest({
    url,
    model,
    messages,
    tools,
    toolChoice,
    stream,
    kind: 'chat.completions.tools.stream',
    promptContext: opts?.promptContext,
  });
  const t0 = Date.now();
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(
        buildChatCompletionBody(
          { model, messages, tools, tool_choice: toolChoice, stream },
          opts,
        ),
      ),
    },
    { timeoutMs: opts?.timeoutMs ?? 180_000, signal: opts?.signal },
  );

  if (!res.ok) {
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      logLlmWireResponse(reqId, {
        ok: false,
        status: res.status,
        stream: true,
        error: text.slice(0, 240),
        durationMs: Date.now() - t0,
      });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
    const err = extractApiError(data, res.status, text);
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      stream: true,
      error: err,
      durationMs: Date.now() - t0,
    });
    throw new Error(err);
  }
  if (!res.body) {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      stream: true,
      error: 'NO_RESPONSE_BODY',
      durationMs: Date.now() - t0,
    });
    throw new Error('NO_RESPONSE_BODY');
  }

  let content = '';
  let thoughtAcc = '';
  let resolvedModel = model;
  let finishReason: string | null = null;
  const toolAcc = new Map<number, AgentToolCallPayload>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    throwIfAborted(opts?.signal);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as {
          model?: string;
          choices?: { delta?: unknown; finish_reason?: string }[];
        };
        if (chunk.model) resolvedModel = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = extractStreamDelta(choice?.delta);
        if (delta.thought) {
          thoughtAcc += delta.thought;
          handlers.onThought?.(delta.thought);
        }
        if (delta.content) {
          content += delta.content;
          handlers.onContent?.(delta.content);
        }
        if (delta.tool_calls?.length) mergeToolCallDeltas(toolAcc, delta.tool_calls);
      } catch {
        /* skip malformed chunk */
      }
    }
  }

  const tool_calls = finalizeStreamedToolCalls(toolAcc);

  if (!content.trim() && thoughtAcc.trim() && tool_calls.length === 0) {
    content = thoughtAcc.trim();
    handlers.onContent?.(content);
  }

  if (!content && tool_calls.length === 0) {
    logLlmWireResponse(reqId, {
      ok: false,
      status: res.status,
      model: resolvedModel,
      finishReason,
      stream: true,
      error: 'EMPTY_COMPLETION',
      durationMs: Date.now() - t0,
    });
    throw new Error('EMPTY_COMPLETION');
  }
  logLlmWireResponse(reqId, {
    ok: true,
    status: res.status,
    model: resolvedModel,
    finishReason,
    content: content || null,
    toolCalls: tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    stream: true,
    durationMs: Date.now() - t0,
  });
  return {
    content: content || null,
    tool_calls,
    model: resolvedModel,
    finish_reason: finishReason,
    reasoning: thoughtAcc.trim() || null,
  };
}

/** Remember last working chat/tools base per configured origin to skip slow fallbacks. */
const stickyToolChatBase = new Map<string, string>();

function stickyKeyForBase(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/$/, '');
  }
}

function publishToolReasoning(
  handlers: ToolStreamHandlers | undefined,
  reasoning: string | null | undefined,
): void {
  const text = reasoning?.trim();
  if (!handlers?.onThought || !text) return;
  handlers.onThought(text);
}

export async function chatCompletionWithTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
  opts?: ChatCompletionOptions,
  handlers?: ToolStreamHandlers,
): Promise<ToolCompletionResult> {
  if (apiKey.startsWith('stub:')) {
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return {
      content: `[stub tools · ${model}]\n${user}`,
      tool_calls: [],
      model,
      finish_reason: 'stop',
    };
  }
  const compiled = compilePromptContext(messages, tools);
  const compiledOpts = { ...opts, promptContext: compiled.metadata };
  if (opts?.wireApi === 'responses') {
    return responsesCompletionWithTools(baseUrl, apiKey, model, compiled.messages, compiled.tools, compiledOpts, handlers);
  }
  if (opts?.wireApi === 'messages') {
    return messagesCompletionWithTools(baseUrl, apiKey, model, compiled.messages, compiled.tools, compiledOpts, handlers);
  }
  let lastErr: Error | null = null;
  const stickyKey = stickyKeyForBase(baseUrl);
  const sticky = stickyToolChatBase.get(stickyKey);
  const basesRaw = candidateToolChatBases(baseUrl);
  const bases =
    sticky && basesRaw.includes(sticky)
      ? [sticky, ...basesRaw.filter((b) => b !== sticky)]
      : basesRaw;
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    try {
      const useStream = opts?.stream !== false && Boolean(handlers?.onThought || handlers?.onContent);
      if (useStream) {
        try {
          const result = await chatCompletionWithToolsStreamAt(
            base,
            apiKey,
            model,
            compiled.messages,
            compiled.tools,
            handlers!,
            compiledOpts,
          );
          stickyToolChatBase.set(stickyKey, base);
          return result;
        } catch (streamErr: unknown) {
          const streamMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          // Stream parsers / gateways often drop tool_calls → false EMPTY. Retry non-stream once.
          if (streamMsg.includes('EMPTY_COMPLETION')) {
            const result = await chatCompletionWithToolsAt(base, apiKey, model, compiled.messages, compiled.tools, {
              ...compiledOpts,
              stream: false,
            });
            publishToolReasoning(handlers, result.reasoning);
            stickyToolChatBase.set(stickyKey, base);
            return result;
          }
          throw streamErr;
        }
      }
      const result = await chatCompletionWithToolsAt(base, apiKey, model, compiled.messages, compiled.tools, compiledOpts);
      publishToolReasoning(handlers, result.reasoning);
      stickyToolChatBase.set(stickyKey, base);
      return result;
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message;
      const tryNext =
        i < bases.length - 1
        && (isOwuiPassthroughDisabled(msg)
          || msg.includes('EMPTY_COMPLETION')
          || /HTTP 40[04]\b/.test(msg)
          || /not\s+found/i.test(msg));
      if (!tryNext) break;
    }
  }
  throw lastErr ?? new Error('CHAT_TOOLS_FAILED');
}
