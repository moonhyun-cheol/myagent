import { createHash } from 'node:crypto';
import { fetchWithUsage } from './llm-usage-log.js';
import { logResponsesBoundary } from './llm-wire-log.js';
import type {
  AgentToolCallPayload,
  ChatCompletionOptions,
  ChatContentPart,
  ChatMessage,
  CompletionResult,
  ToolCompletionResult,
  ToolStreamHandlers,
} from './openai-compatible.js';
import type { ResponsesContinuationState } from '../sessions/types.js';

export type ResponsesReasoningSummaryPolicy = 'detailed' | 'receive_only' | 'omit';

/**
 * Resolve an explicit Responses summary contract from configured provider/model identity.
 * Unknown and non-OpenAI models omit the request field; returned summaries are still parsed.
 */
export function resolveResponsesReasoningSummaryPolicy(
  providerId: string,
  modelId: string,
): ResponsesReasoningSummaryPolicy {
  const provider = providerId.trim().toLowerCase();
  const model = modelId.trim().toLowerCase();
  const vendor = model.includes('/') ? model.slice(0, model.indexOf('/')) : '';

  if (provider === 'openai' || vendor === 'openai' || model.startsWith('openai:')) return 'detailed';
  if (vendor === 'moonshotai' || vendor === 'moonshot' || /(^|[/:_-])kimi([/:_.-]|$)/.test(model)) {
    return 'receive_only';
  }
  return 'omit';
}

class ResponsesHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ResponsesHttpError';
  }
}

type ResponseReasoningPart = {
  type?: string;
  text?: string;
};

type ResponseOutputItem = {
  type?: string;
  role?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<ResponseReasoningPart | string>;
  summary?: Array<ResponseReasoningPart | string>;
};

type ResponsesDocument = {
  id?: string;
  model?: string;
  output_text?: string;
  output?: ResponseOutputItem[];
  reasoning?: { context?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  status?: string;
  error?: { message?: string; code?: unknown; type?: unknown; metadata?: { raw?: unknown } };
  detail?: unknown;
};

type PreparedResponseBody = {
  body: Record<string, unknown>;
  requestItems: unknown[];
  fullItems: unknown[];
  settingsHash: string;
};

function fingerprint(value: unknown): string {
  const normalize = (row: unknown): unknown => {
    if (Array.isArray(row)) return row.map(normalize);
    if (row && typeof row === 'object') return Object.fromEntries(
      Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalize(val)]),
    );
    return row;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function invalidateResponsesState(opts: ChatCompletionOptions | undefined, reason: string): void {
  const state = opts?.responsesState;
  if (!state) return;
  delete state.previous_response_id;
  delete state.replay_items;
  delete state.request_contract;
  delete state.reasoning_context;
  delete state.usage;
  state.next_message_index = 0;
  state.invalidation_reason = reason;
  state.updated_at = new Date().toISOString();
  opts?.onResponsesState?.(structuredClone(state));
}

/** Validate complete visible history, not just a provider-state delta. Never synthesize results. */
function validateToolPairs(items: unknown[]): void {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const raw of items) {
    const item = raw as { type?: string; call_id?: string };
    if (item.type === 'function_call') {
      if (!item.call_id || seen.has(item.call_id)) throw new Error('RESPONSES_TOOL_PAIR_INVALID: duplicate/missing call id');
      seen.add(item.call_id);
      pending.add(item.call_id);
    } else if (item.type === 'function_call_output') {
      if (!item.call_id || !pending.delete(item.call_id)) throw new Error('RESPONSES_TOOL_PAIR_INVALID: orphan/duplicate output');
    }
  }
  if (pending.size) throw new Error('RESPONSES_TOOL_PAIR_INVALID: missing tool result; automatic re-execution disabled');
}

function alignResponsesStateToolSchema(opts: ChatCompletionOptions | undefined): void {
  const state = opts?.responsesState;
  const currentHash = opts?.promptContext?.tool_schema_hash;
  if (!state || !currentHash || state.tool_schema_hash === currentHash) return;

  const hadCachedChain = Boolean(
    state.previous_response_id
    || state.replay_items?.length
    || state.next_message_index > 0,
  );
  state.tool_schema_hash = currentHash;
  if (hadCachedChain) {
    invalidateResponsesState(opts, 'tool_schema_changed');
  }
  state.updated_at = new Date().toISOString();
  // Persist invalidation before the network request so a failed request cannot
  // resurrect an incompatible provider/replay chain on the next attempt.
  opts?.onResponsesState?.(structuredClone(state));
}

function responseBase(baseUrl: string): string {
  // The endpoint contract is fixed during configuration. Runtime must never
  // rewrite a direct OpenRouter/OpenAI base into the former OWUI passthrough.
  return baseUrl.replace(/\/$/, '');
}

function contentParts(content: ChatMessage['content'], role: ChatMessage['role']): unknown {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((part: ChatContentPart) => {
    if (part.type === 'image_url' && role === 'user') {
      return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail };
    }
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.type === 'text' ? part.text : '[image]' };
  });
}

/** Convert Chat Completions history into stateless Responses input items. */
export function buildResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      });
      continue;
    }
    if (message.content != null && (typeof message.content !== 'string' || message.content.length > 0)) {
      input.push({ role: message.role, content: contentParts(message.content, message.role) });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

function responseInstructions(messages: ChatMessage[]): string | undefined {
  const instructions = messages
    // Ephemeral user-tail guidance is native Responses instruction metadata, not
    // a durable conversation item. This keeps continuation chains free of phase notes.
    .filter((message) => message.role === 'system' || message.ephemeral === true)
    .map((message) => typeof message.content === 'string' ? message.content.trim() : '')
    .filter(Boolean)
    .join('\n\n');
  return instructions || undefined;
}

export function buildResponsesTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    const row = tool as {
      type?: string;
      function?: { name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
    const fn = row.function ?? row;
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters ?? { type: 'object', properties: {} },
      ...(fn.strict == null ? {} : { strict: fn.strict }),
    };
  });
}

function buildBody(
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions | undefined,
  tools: unknown[] | undefined,
  boundary: { baseUrl: string; apiKey: string },
): PreparedResponseBody {
  alignResponsesStateToolSchema(opts);
  const state = opts?.responsesState;
  const fullItems = buildResponsesInput(messages.filter((message) => message.role !== 'system' && message.ephemeral !== true));
  validateToolPairs(fullItems);
  const body: Record<string, unknown> = {
    model,
    input: fullItems,
    stream: opts?.stream === true,
    store: state?.mode === 'provider_state',
  };
  const instructions = responseInstructions(messages);
  if (instructions) body.instructions = instructions;
  if (state?.mode === 'client_replay') {
    body.include = ['reasoning.encrypted_content'];
  }
  if (tools?.length) {
    body.tools = buildResponsesTools(tools);
    body.tool_choice = opts?.toolChoice ?? 'auto';
    if (opts?.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = opts.parallelToolCalls;
    }
  }
  if (opts?.extraBody) Object.assign(body, opts.extraBody);
  delete body.messages;
  delete body.reasoning_effort;
  const reasoningEffort = opts?.reasoningEffort?.trim();
  const configured = body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
    ? body.reasoning as Record<string, unknown>
    : {};
  const reasoning: Record<string, unknown> = {
    ...configured,
    ...(reasoningEffort ? { effort: reasoningEffort } : {}),
  };
  // Summary generation is a model capability, not a consequence of using the
  // Responses wire protocol. Receive-only/unknown models may still return a
  // summary item, which the response parser preserves without requesting one.
  delete reasoning.summary;
  if (opts?.reasoningSummary === 'detailed') reasoning.summary = 'detailed';
  body.reasoning = reasoning;
  // Extra options cannot replace protocol-owned history or storage policy.
  body.input = fullItems;
  body.store = state?.mode === 'provider_state';
  body.stream = opts?.stream === true;
  delete body.previous_response_id;
  const { input: _input, ...settings } = body;
  const settingsHash = fingerprint({
    settings,
    endpoint: boundary.baseUrl.replace(/\/$/, ''),
    account: fingerprint(boundary.apiKey),
    provider: state?.provider_id,
    mode: state?.mode,
  });
  const contract = state?.request_contract;
  const cached = Boolean(state?.previous_response_id || state?.replay_items?.length);
  let reason: string | undefined;
  if (cached) {
    if (contract?.version !== 1) reason = 'legacy_contract';
    else if (contract.settings_hash !== settingsHash) reason = 'settings_changed';
    else if (!Number.isInteger(contract.prefix_items) || contract.prefix_items < 0 || contract.prefix_items > fullItems.length) reason = 'prefix_range';
    else if (contract.prefix_hash !== fingerprint(fullItems.slice(0, contract.prefix_items))) reason = 'prefix_changed';
    else if (state?.mode === 'client_replay' && contract.replay_hash !== fingerprint(state.replay_items)) reason = 'replay_changed';
    else if (state?.mode === 'provider_state' && !state.previous_response_id) reason = 'missing_response_id';
  }
  if (reason) invalidateResponsesState(opts, reason);
  if (cached && !reason && contract) {
    const delta = fullItems.slice(contract.prefix_items);
    body.input = state?.mode === 'client_replay' ? [...(state.replay_items ?? []), ...delta] : delta;
    if (state?.mode === 'provider_state') body.previous_response_id = state.previous_response_id;
  }
  return { body, requestItems: body.input as unknown[], fullItems, settingsHash };
}

function usageFrom(doc: ResponsesDocument) {
  return {
    prompt_tokens: doc.usage?.input_tokens,
    completion_tokens: doc.usage?.output_tokens,
    reasoning_tokens: doc.usage?.output_tokens_details?.reasoning_tokens,
    cached_tokens: doc.usage?.input_tokens_details?.cached_tokens,
    cache_write_tokens: doc.usage?.input_tokens_details?.cache_write_tokens,
  };
}

function advanceResponsesState(
  doc: ResponsesDocument,
  messages: ChatMessage[],
  prepared: PreparedResponseBody,
  opts?: ChatCompletionOptions,
  assistant?: ChatMessage,
): void {
  const current = opts?.responsesState;
  if (!current) return;
  if (!doc.id) {
    invalidateResponsesState(opts, 'missing_response_id');
    return;
  }
  const visibleOutput = buildResponsesInput([assistant ?? {
    role: 'assistant', content: outputText(doc) || null, tool_calls: outputToolCalls(doc),
  }]);
  const expectedItems = [...prepared.fullItems, ...visibleOutput];
  const next: ResponsesContinuationState = {
    ...current,
    tool_schema_hash: opts?.promptContext?.tool_schema_hash ?? current.tool_schema_hash,
    previous_response_id: doc.id,
    // The completed response becomes one assistant ChatMessage before the next call.
    // Count only durable non-system messages. Kept for legacy observability,
    // never used to authorize reuse; request_contract validates normalized items.
    next_message_index: messages.filter(
      (message) => message.role !== 'system' && message.ephemeral !== true,
    ).length + 1,
    index_basis: 'dynamic',
    reasoning_context: doc.reasoning?.context ?? current.reasoning_context,
    usage: {
      input_tokens: doc.usage?.input_tokens,
      output_tokens: doc.usage?.output_tokens,
      reasoning_tokens: doc.usage?.output_tokens_details?.reasoning_tokens,
      cached_tokens: doc.usage?.input_tokens_details?.cached_tokens,
      cache_write_tokens: doc.usage?.input_tokens_details?.cache_write_tokens,
    },
    updated_at: new Date().toISOString(),
  };
  if (current.mode === 'client_replay') {
    // Gateways emitting only deltas/output_text cannot supply a complete encrypted replay.
    if (!doc.output?.length) {
      invalidateResponsesState(opts, 'missing_output_items');
      return;
    }
    next.replay_items = [...prepared.requestItems, ...doc.output];
  } else {
    delete next.replay_items;
  }
  next.request_contract = {
    version: 1,
    settings_hash: prepared.settingsHash,
    prefix_items: expectedItems.length,
    prefix_hash: fingerprint(expectedItems),
    ...(next.replay_items ? { replay_hash: fingerprint(next.replay_items) } : {}),
  };
  delete next.invalidation_reason;
  delete current.invalidation_reason;
  Object.assign(current, next);
  opts?.onResponsesState?.(structuredClone(next));
}

function outputText(doc: ResponsesDocument): string {
  if (typeof doc.output_text === 'string' && doc.output_text) return doc.output_text;
  const chunks: string[] = [];
  for (const item of doc.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (typeof part === 'string') {
        chunks.push(part);
        continue;
      }
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('');
}

function reasoningPartText(part: ResponseReasoningPart | string): string {
  if (typeof part === 'string') return part.trim();
  if (!part || typeof part !== 'object') return '';
  return typeof part.text === 'string' ? part.text.trim() : '';
}

function outputItemReasoningText(item: ResponseOutputItem): string {
  const summary = (item.summary ?? []).map(reasoningPartText).filter(Boolean).join('\n\n');
  if (summary) return summary;
  return (item.content ?? [])
    .filter((part) => typeof part === 'string' || part.type === 'reasoning_text' || part.type === 'text')
    .map(reasoningPartText)
    .filter(Boolean)
    .join('\n\n');
}

function outputReasoningSummary(doc: ResponsesDocument): string {
  return (doc.output ?? [])
    .filter((item) => item.type === 'reasoning')
    .map(outputItemReasoningText)
    .filter(Boolean)
    .join('\n\n');
}

function outputToolCalls(doc: ResponsesDocument): AgentToolCallPayload[] {
  return (doc.output ?? [])
    .filter((item) => item.type === 'function_call' && item.name)
    .map((item, index) => ({
      id: item.call_id || item.id || `call_${index}_${item.name}`,
      type: 'function' as const,
      function: { name: item.name!, arguments: item.arguments || '{}' },
    }));
}

async function postResponse(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  opts?: ChatCompletionOptions,
): Promise<{ response: Response; url: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/responses`;
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  signals.push(AbortSignal.timeout(opts?.timeoutMs ?? 300_000));
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const serialized = JSON.stringify(body);
  const summary = {
    transport: body.previous_response_id ? 'delta' as const : (opts?.responsesState?.mode === 'client_replay' && opts.responsesState.request_contract ? 'replay' as const : 'full' as const),
    input_items: (body.input as unknown[]).length,
    serialized_bytes: Buffer.byteLength(serialized),
    invalidation_reason: opts?.responsesState?.invalidation_reason,
  };
  logResponsesBoundary({ phase: 'request', ...summary });
  const response = await fetchWithUsage(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: serialized,
    signal,
  });
  if (!response.ok) {
    let doc: ResponsesDocument = {};
    try { doc = await response.clone().json() as ResponsesDocument; } catch { /* no raw body logging */ }
    logResponsesBoundary({ phase: 'failure', ...summary, status: response.status, ...safeErrorFields(doc, response) });
  }
  return { response, url };
}

// Free-form errors can echo prompts or secrets. Retain bounded protocol identifiers only.
function safeIdentifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)
    && !/^(sk-|Bearer|eyJ)/i.test(value) ? value : undefined;
}

function safeErrorFields(doc: ResponsesDocument, response?: Response) {
  let upstream: ResponsesDocument = {};
  const raw = doc?.error?.metadata?.raw;
  if (typeof raw === 'string' && raw.length <= 4096) {
    try { upstream = JSON.parse(raw) as ResponsesDocument; } catch { /* omit unstructured upstream text */ }
  }
  const message = doc?.error?.message ?? '';
  const category = /rate.?limit|too many requests/i.test(message) ? 'rate_limit'
    : /context.{0,30}(length|window)|maximum.{0,30}tokens/i.test(message) ? 'context_length'
    : /api.?key|unauthorized|authentication/i.test(message) ? 'authentication'
    : 'provider_error';
  return {
    category,
    code: safeIdentifier(doc?.error?.code),
    type: safeIdentifier(doc?.error?.type),
    upstream_code: safeIdentifier(upstream?.error?.code),
    upstream_type: safeIdentifier(upstream?.error?.type),
    request_id: safeIdentifier(response?.headers.get('x-request-id') ?? response?.headers.get('request-id')),
  };
}

function assertCompleted(doc: ResponsesDocument): void {
  if (doc.error || (doc.status && doc.status !== 'completed')) {
    throw new Error(`RESPONSES_FAILED: status=${safeIdentifier(doc.status) ?? 'error'} ${JSON.stringify(safeErrorFields(doc))}`);
  }
}

async function readDocument(response: Response): Promise<ResponsesDocument> {
  const text = await response.text();
  let doc: ResponsesDocument;
  try {
    doc = JSON.parse(text) as ResponsesDocument;
  } catch {
    throw new ResponsesHttpError(response.status, `RESPONSES_INVALID_JSON: HTTP ${response.status}; non-JSON/empty body omitted`);
  }
  if (!response.ok) {
    throw new ResponsesHttpError(response.status, `RESPONSES_HTTP_${response.status}: Provider returned error ${JSON.stringify(safeErrorFields(doc, response))}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('RESPONSES_INVALID_DOCUMENT');
  assertCompleted(doc);
  return doc;
}

async function completionAtImpl(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const prepared = buildBody(model, messages, { ...opts, stream: false }, undefined, { baseUrl, apiKey });
  const { response } = await postResponse(baseUrl, apiKey, prepared.body, opts);
  const doc = await readDocument(response);
  const content = outputText(doc);
  if (!content) throw new Error('EMPTY_COMPLETION');
  const reasoning = outputReasoningSummary(doc);
  if (reasoning) opts?.onThought?.(reasoning);
  const usage = usageFrom(doc);
  advanceResponsesState(doc, messages, prepared, opts);
  return { content, model: doc.model ?? model, usage, response_id: doc.id };
}

export async function responsesCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  return responsesCompletionAt(responseBase(baseUrl), apiKey, model, messages, opts);
}

type StreamAccumulator = {
  content: string;
  thought: string;
  fallbackThought: string;
  model: string;
  calls: Map<number, AgentToolCallPayload>;
  completed?: ResponsesDocument;
};

function applyStreamEvent(raw: string, acc: StreamAccumulator, handlers?: ToolStreamHandlers): void {
  const event = JSON.parse(raw) as Record<string, unknown>;
  const type = String(event.type || '');
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    acc.content += event.delta;
    handlers?.onContent?.(event.delta);
  } else if (/reasoning.*\.delta$/.test(type) && typeof event.delta === 'string') {
    acc.thought += event.delta;
    handlers?.onThought?.(event.delta);
  } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = event.item as ResponseOutputItem | undefined;
    if (type === 'response.output_item.done' && item?.type === 'reasoning') {
      const fallback = outputItemReasoningText(item);
      if (fallback) acc.fallbackThought = [acc.fallbackThought, fallback].filter(Boolean).join('\n\n');
    }
    if (item?.type === 'function_call') {
      const index = Number(event.output_index ?? acc.calls.size);
      acc.calls.set(index, {
        id: item.call_id || item.id || `call_${index}`,
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '' },
      });
    }
  } else if (type === 'response.function_call_arguments.delta') {
    const index = Number(event.output_index ?? 0);
    const previous = acc.calls.get(index) ?? {
      id: String(event.item_id || `call_${index}`),
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    if (typeof event.delta === 'string') previous.function.arguments += event.delta;
    acc.calls.set(index, previous);
  } else if (type === 'response.completed') {
    acc.completed = event.response as ResponsesDocument;
    if (acc.completed?.model) acc.model = acc.completed.model;
  } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
    const doc = (event.response ?? event) as ResponsesDocument;
    throw new Error(`RESPONSES_FAILED: event=${type} ${JSON.stringify(safeErrorFields(doc))}`);
  }
}

async function responsesStreamAt(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  handlers: ToolStreamHandlers,
  opts?: ChatCompletionOptions,
): Promise<ToolCompletionResult> {
  const prepared = buildBody(
    model,
    messages,
    { ...opts, stream: true },
    tools,
    { baseUrl, apiKey },
  );
  const { response } = await postResponse(baseUrl, apiKey, prepared.body, opts);
  if (!response.ok) await readDocument(response);
  if (!response.body) throw new Error('NO_RESPONSE_BODY');
  const acc: StreamAccumulator = {
    content: '',
    thought: '',
    fallbackThought: '',
    model,
    calls: new Map(),
  };
  const reader = response.body.getReader();
  try {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      applyStreamEvent(data, acc, handlers);
    }
  }
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (data && data !== '[DONE]') applyStreamEvent(data, acc, handlers);
  }
  if (!acc.completed) throw new Error('RESPONSES_INCOMPLETE_STREAM: missing response.completed');
  assertCompleted(acc.completed);
  const completedCalls = outputToolCalls(acc.completed);
  if (acc.calls.size && !completedCalls.length) {
    throw new Error('RESPONSES_INCONSISTENT_STREAM: terminal response missing streamed tool calls');
  }
  const calls = completedCalls;
  const content = outputText(acc.completed) || acc.content;
  if (!acc.thought) {
    const completedThought = acc.completed ? outputReasoningSummary(acc.completed) : '';
    const fallbackThought = completedThought || acc.fallbackThought;
    if (fallbackThought) {
      acc.thought = fallbackThought;
      handlers.onThought?.(fallbackThought);
    }
  }
  if (!content && calls.length === 0) throw new Error('EMPTY_COMPLETION');
  if (acc.completed.output?.length) {
    advanceResponsesState(acc.completed, messages, prepared, opts, {
      role: 'assistant', content: content || null, tool_calls: calls,
    });
  } else {
    invalidateResponsesState(opts, 'missing_output_items');
  }
  return {
    content: content || null,
    tool_calls: calls,
    model: acc.model,
    finish_reason: calls.length ? 'tool_calls' : 'stop',
    reasoning: acc.thought || null,
    response_id: acc.completed?.id,
    usage: acc.completed ? usageFrom(acc.completed) : undefined,
  };
  } finally {
    try { await reader.cancel(); } catch { /* preserve the original error */ }
    reader.releaseLock();
  }
}

export async function responsesCompletionStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: (text: string) => void,
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const result = await guardedResponses(opts, () => responsesStreamAt(
    responseBase(baseUrl),
    apiKey,
    model,
    messages,
    undefined,
    { onContent: onToken, onThought: opts?.onThought },
    opts,
  ));
  return { content: result.content ?? '', model: result.model };
}

async function completionWithToolsImpl(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
  opts?: ChatCompletionOptions,
  handlers: ToolStreamHandlers = {},
): Promise<ToolCompletionResult> {
  const base = responseBase(baseUrl);
  if (opts?.stream !== false && (handlers.onContent || handlers.onThought)) {
    return responsesStreamAt(base, apiKey, model, messages, tools, handlers, opts);
  }
  const prepared = buildBody(
    model,
    messages,
    { ...opts, stream: false },
    tools,
    { baseUrl: base, apiKey },
  );
  const { response } = await postResponse(base, apiKey, prepared.body, opts);
  const doc = await readDocument(response);
  const content = outputText(doc) || null;
  const reasoning = outputReasoningSummary(doc);
  if (reasoning) handlers.onThought?.(reasoning);
  const tool_calls = outputToolCalls(doc);
  if (!content && tool_calls.length === 0) throw new Error('EMPTY_COMPLETION');
  advanceResponsesState(doc, messages, prepared, opts);
  return {
    content,
    tool_calls,
    model: doc.model ?? model,
    finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
    reasoning: reasoning || null,
    response_id: doc.id,
    usage: usageFrom(doc),
  };
}

async function guardedResponses<T>(opts: ChatCompletionOptions | undefined, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    try { invalidateResponsesState(opts, 'request_failed'); }
    catch { throw new AggregateError([error], 'RESPONSES_STATE_PERSIST_FAILED: provider failure; invalidation persistence also failed'); }
    throw error;
  }
}

export async function responsesCompletionAt(
  baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  return guardedResponses(opts, () => completionAtImpl(baseUrl, apiKey, model, messages, opts));
}

export async function responsesCompletionWithTools(
  baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], tools: unknown[],
  opts?: ChatCompletionOptions, handlers: ToolStreamHandlers = {},
): Promise<ToolCompletionResult> {
  return guardedResponses(opts, () => completionWithToolsImpl(baseUrl, apiKey, model, messages, tools, opts, handlers));
}
