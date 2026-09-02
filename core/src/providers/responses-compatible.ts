import { logLlmWireRequest, logLlmWireResponse } from './llm-wire-log.js';
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

class ResponsesHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ResponsesHttpError';
  }
}

type ResponseOutputItem = {
  type?: string;
  role?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
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
  error?: { message?: string };
  detail?: unknown;
};

type PreparedResponseBody = {
  body: Record<string, unknown>;
  requestItems: unknown[];
};

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
    delete state.previous_response_id;
    delete state.replay_items;
    delete state.reasoning_context;
    delete state.usage;
    state.next_message_index = 0;
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

function continuationItems(
  messages: ChatMessage[],
  state: ResponsesContinuationState | undefined,
): { items: unknown[]; continued: boolean } {
  // Index only durable non-system messages. System content and ephemeral phase
  // guidance travel via `instructions`, so neither may shift the stored item chain.
  // Legacy chains without index_basis rebuild in full once, then heal.
  const dynamic = messages.filter((message) => message.role !== 'system' && message.ephemeral !== true);
  if (!state?.previous_response_id && !state?.replay_items?.length) {
    return { items: buildResponsesInput(dynamic), continued: false };
  }
  if (state.index_basis !== 'dynamic' || state.next_message_index < 0 || state.next_message_index > dynamic.length) {
    return { items: buildResponsesInput(dynamic), continued: false };
  }
  return {
    items: buildResponsesInput(dynamic.slice(state.next_message_index)),
    continued: true,
  };
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
  tools?: unknown[],
): PreparedResponseBody {
  alignResponsesStateToolSchema(opts);
  const state = opts?.responsesState;
  const continuation = continuationItems(messages, state);
  const providerState = state?.mode === 'provider_state' && continuation.continued;
  const replayPrefix = state?.mode === 'client_replay' && continuation.continued
    ? state.replay_items ?? []
    : [];
  const requestItems = [...replayPrefix, ...continuation.items];
  const body: Record<string, unknown> = {
    model,
    input: requestItems,
    stream: opts?.stream === true,
    store: state?.mode === 'provider_state',
  };
  const instructions = responseInstructions(messages);
  if (instructions) body.instructions = instructions;
  if (providerState && state?.previous_response_id) {
    body.previous_response_id = state.previous_response_id;
  }
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
  if (opts?.reasoningEffort?.trim()) body.reasoning = { effort: opts.reasoningEffort.trim() };
  return { body, requestItems };
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
  requestItems: unknown[],
  opts?: ChatCompletionOptions,
): void {
  const current = opts?.responsesState;
  if (!current || !doc.id) return;
  const next: ResponsesContinuationState = {
    ...current,
    tool_schema_hash: opts?.promptContext?.tool_schema_hash ?? current.tool_schema_hash,
    previous_response_id: doc.id,
    // The completed response becomes one assistant ChatMessage before the next call.
    // Count only durable non-system messages (see continuationItems).
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
    next.replay_items = [...requestItems, ...(doc.output ?? [])];
  } else {
    delete next.replay_items;
  }
  Object.assign(current, next);
  opts?.onResponsesState?.(structuredClone(next));
}

function outputText(doc: ResponsesDocument): string {
  if (typeof doc.output_text === 'string' && doc.output_text) return doc.output_text;
  const chunks: string[] = [];
  for (const item of doc.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('');
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
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  return { response, url };
}

async function readDocument(response: Response): Promise<ResponsesDocument> {
  const text = await response.text();
  let doc: ResponsesDocument;
  try {
    doc = JSON.parse(text) as ResponsesDocument;
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown';
    const responseUrl = response.url || 'unknown';
    throw new ResponsesHttpError(
      response.status,
      `RESPONSES_INVALID_JSON: HTTP ${response.status} content-type=${contentType} url=${responseUrl} body=${text.slice(0, 160)}`,
    );
  }
  if (!response.ok) {
    const message = doc.error?.message || String(doc.detail || `HTTP ${response.status}`);
    throw new ResponsesHttpError(response.status, `RESPONSES_HTTP_${response.status}: ${message}`);
  }
  return doc;
}

export async function responsesCompletionAt(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const prepared = buildBody(model, messages, { ...opts, stream: false });
  const reqId = logLlmWireRequest({
    url: `${baseUrl}/responses`,
    model,
    messages,
    stream: false,
    kind: 'responses',
    promptContext: opts?.promptContext,
  });
  const t0 = Date.now();
  try {
    const { response } = await postResponse(baseUrl, apiKey, prepared.body, opts);
    const doc = await readDocument(response);
    const content = outputText(doc);
    if (!content) throw new Error('EMPTY_COMPLETION');
    const usage = usageFrom(doc);
    advanceResponsesState(doc, messages, prepared.requestItems, opts);
    logLlmWireResponse(reqId, { ok: true, status: response.status, model: doc.model ?? model, content, usage, durationMs: Date.now() - t0 });
    return { content, model: doc.model ?? model, usage, response_id: doc.id };
  } catch (error) {
    logLlmWireResponse(reqId, { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - t0 });
    throw error;
  }
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
  } else if (type === 'response.failed') {
    const doc = event.response as ResponsesDocument | undefined;
    throw new Error(`RESPONSES_FAILED: ${doc?.error?.message || 'stream failed'}`);
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
  const prepared = buildBody(model, messages, { ...opts, stream: true }, tools);
  const { response } = await postResponse(baseUrl, apiKey, prepared.body, opts);
  if (!response.ok) await readDocument(response);
  if (!response.body) throw new Error('NO_RESPONSE_BODY');
  const acc: StreamAccumulator = { content: '', thought: '', model, calls: new Map() };
  const reader = response.body.getReader();
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
  const completedCalls = acc.completed ? outputToolCalls(acc.completed) : [];
  const calls = completedCalls.length ? completedCalls : [...acc.calls.values()].filter((call) => call.function.name);
  const content = acc.content || (acc.completed ? outputText(acc.completed) : '');
  if (!content && calls.length === 0) throw new Error('EMPTY_COMPLETION');
  if (acc.completed) advanceResponsesState(acc.completed, messages, prepared.requestItems, opts);
  return {
    content: content || null,
    tool_calls: calls,
    model: acc.model,
    finish_reason: calls.length ? 'tool_calls' : 'stop',
    reasoning: acc.thought || null,
    response_id: acc.completed?.id,
    usage: acc.completed ? usageFrom(acc.completed) : undefined,
  };
}

export async function responsesCompletionStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: (text: string) => void,
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const result = await responsesStreamAt(responseBase(baseUrl), apiKey, model, messages, undefined, { onContent: onToken }, opts);
  return { content: result.content ?? '', model: result.model };
}

export async function responsesCompletionWithTools(
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
  const prepared = buildBody(model, messages, { ...opts, stream: false }, tools);
  const { response } = await postResponse(base, apiKey, prepared.body, opts);
  const doc = await readDocument(response);
  const content = outputText(doc) || null;
  const tool_calls = outputToolCalls(doc);
  if (!content && tool_calls.length === 0) throw new Error('EMPTY_COMPLETION');
  advanceResponsesState(doc, messages, prepared.requestItems, opts);
  return {
    content,
    tool_calls,
    model: doc.model ?? model,
    finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
    response_id: doc.id,
    usage: usageFrom(doc),
  };
}
