import { logLlmWireRequest, logLlmWireResponse } from './llm-wire-log.js';
import type {
  AgentToolCallPayload,
  ChatCompletionOptions,
  ChatContentPart,
  ChatMessage,
  CompletionResult,
  CompletionUsage,
  ToolCompletionResult,
  ToolStreamHandlers,
} from './openai-compatible.js';

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

type AnthropicDocument = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
  error?: { message?: string };
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

function normalizeAnthropicUsage(usage?: AnthropicUsage): CompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    cached_tokens: usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens,
  };
}

function mergeUsage(current: CompletionUsage | undefined, next: CompletionUsage): CompletionUsage {
  return {
    prompt_tokens: next.prompt_tokens ?? current?.prompt_tokens,
    completion_tokens: next.completion_tokens ?? current?.completion_tokens,
    reasoning_tokens: next.reasoning_tokens ?? current?.reasoning_tokens,
    cached_tokens: next.cached_tokens ?? current?.cached_tokens,
    cache_write_tokens: next.cache_write_tokens ?? current?.cache_write_tokens,
  };
}

function imageBlock(part: Extract<ChatContentPart, { type: 'image_url' }>): Record<string, unknown> {
  const url = part.image_url.url;
  const data = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (data) {
    return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function userContent(content: ChatMessage['content']): unknown {
  if (content == null || typeof content === 'string') return content ?? '';
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : imageBlock(part));
}

/** Convert shared history to native Anthropic Messages blocks. */
export function buildAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
} {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content.trim()) system.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
        }],
      });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = { raw: call.function.arguments }; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role, content: userContent(message.content) });
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages: out };
}

export function buildAnthropicTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    const row = tool as {
      function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
    const fn = row.function ?? row;
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    };
  });
}

function buildBody(
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
  tools?: unknown[],
): Record<string, unknown> {
  const converted = buildAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: 16_384,
    ...converted,
    stream: opts?.stream === true,
  };
  if (opts?.promptCacheMode !== 'off') body.cache_control = { type: 'ephemeral' };
  const effort = opts?.reasoningEffort?.trim();
  const adaptiveModel = /(?:opus-(?:4[-_.](?:6|7|8)|5)|sonnet-(?:4[-_.]6|5)|fable-5|mythos)/i.test(model);
  const effortModel = adaptiveModel || /opus-4[-_.]5/i.test(model);
  if (effort && effortModel) {
    body.output_config = { effort };
    if (adaptiveModel) body.thinking = { type: 'adaptive' };
  }
  if (tools?.length) {
    body.tools = buildAnthropicTools(tools);
    if (opts?.toolChoice === 'required') body.tool_choice = { type: 'any' };
    else if (opts?.toolChoice === 'none') delete body.tools;
    else body.tool_choice = { type: 'auto' };
  }
  return body;
}

async function postMessages(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  opts?: ChatCompletionOptions,
): Promise<Response> {
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  signals.push(AbortSignal.timeout(opts?.timeoutMs ?? 300_000));
  return fetch(`${baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
}

async function readDocument(response: Response): Promise<AnthropicDocument> {
  const text = await response.text();
  let doc: AnthropicDocument;
  try { doc = JSON.parse(text) as AnthropicDocument; }
  catch { throw new Error(`MESSAGES_INVALID_JSON: ${text.slice(0, 160)}`); }
  if (!response.ok) throw new Error(`MESSAGES_HTTP_${response.status}: ${doc.error?.message || text.slice(0, 160)}`);
  return doc;
}

function parseDocument(doc: AnthropicDocument, fallbackModel: string): ToolCompletionResult {
  const text = (doc.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
  const reasoning = (doc.content ?? [])
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking ?? block.text ?? '')
    .join('');
  const tool_calls: AgentToolCallPayload[] = (doc.content ?? [])
    .filter((block) => block.type === 'tool_use' && block.name)
    .map((block, index) => ({
      id: block.id || `call_${index}_${block.name}`,
      type: 'function' as const,
      function: { name: block.name!, arguments: JSON.stringify(block.input ?? {}) },
    }));
  if (!text && tool_calls.length === 0) throw new Error('EMPTY_COMPLETION');
  return {
    content: text || null,
    tool_calls,
    model: doc.model ?? fallbackModel,
    finish_reason: doc.stop_reason === 'tool_use' ? 'tool_calls' : doc.stop_reason,
    reasoning: reasoning || null,
    usage: normalizeAnthropicUsage(doc.usage),
  };
}

export async function messagesCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const reqId = logLlmWireRequest({
    url: `${baseUrl}/messages`,
    model,
    messages,
    stream: false,
    kind: 'anthropic.messages',
    promptContext: opts?.promptContext,
  });
  const t0 = Date.now();
  try {
    const response = await postMessages(baseUrl, apiKey, buildBody(model, messages, { ...opts, stream: false }), opts);
    const doc = await readDocument(response);
    const parsed = parseDocument(doc, model);
    if (!parsed.content) throw new Error('EMPTY_COMPLETION');
    const usage = normalizeAnthropicUsage(doc.usage);
    logLlmWireResponse(reqId, { ok: true, status: response.status, model: parsed.model, content: parsed.content, usage, durationMs: Date.now() - t0 });
    return { content: parsed.content, model: parsed.model, usage };
  } catch (error) {
    logLlmWireResponse(reqId, { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - t0 });
    throw error;
  }
}

async function messagesStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  handlers: ToolStreamHandlers,
  opts?: ChatCompletionOptions,
): Promise<ToolCompletionResult> {
  const response = await postMessages(baseUrl, apiKey, buildBody(model, messages, { ...opts, stream: true }, tools), opts);
  if (!response.ok) await readDocument(response);
  if (!response.body) throw new Error('NO_RESPONSE_BODY');
  let content = '';
  let reasoning = '';
  let resolvedModel = model;
  let stopReason: string | null = null;
  let usage: CompletionUsage | undefined;
  const calls = new Map<number, AgentToolCallPayload>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const processFrame = (frame: string) => {
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!raw) return;
    const event = JSON.parse(raw) as Record<string, unknown>;
    if (event.type === 'message_start') {
      const message = event.message as AnthropicDocument | undefined;
      if (message?.model) resolvedModel = message.model;
      usage = normalizeAnthropicUsage(message?.usage);
    } else if (event.type === 'content_block_start') {
      const index = Number(event.index ?? calls.size);
      const block = event.content_block as AnthropicContentBlock | undefined;
      if (block?.type === 'tool_use') {
        calls.set(index, { id: block.id || `call_${index}`, type: 'function', function: { name: block.name || '', arguments: '' } });
      }
    } else if (event.type === 'content_block_delta') {
      const index = Number(event.index ?? 0);
      const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        content += delta.text;
        handlers.onContent?.(delta.text);
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        reasoning += delta.thinking;
        handlers.onThought?.(delta.thinking);
      } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        const call = calls.get(index);
        if (call) call.function.arguments += delta.partial_json;
      }
    } else if (event.type === 'message_delta') {
      const delta = event.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
      const nextUsage = normalizeAnthropicUsage(event.usage as AnthropicUsage | undefined);
      if (nextUsage) usage = mergeUsage(usage, nextUsage);
    } else if (event.type === 'error') {
      const error = event.error as { message?: string } | undefined;
      throw new Error(`MESSAGES_STREAM_FAILED: ${error?.message || 'unknown'}`);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) processFrame(frame);
  }
  if (buffer.trim()) processFrame(buffer);
  const tool_calls = [...calls.values()].filter((call) => call.function.name).map((call) => ({
    ...call,
    function: { ...call.function, arguments: call.function.arguments || '{}' },
  }));
  if (!content && tool_calls.length === 0) throw new Error('EMPTY_COMPLETION');
  return {
    content: content || null,
    tool_calls,
    model: resolvedModel,
    finish_reason: stopReason === 'tool_use' ? 'tool_calls' : stopReason,
    reasoning: reasoning || null,
    usage,
  };
}

export async function messagesCompletionStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: (text: string) => void,
  opts?: ChatCompletionOptions,
): Promise<CompletionResult> {
  const result = await messagesStream(
    baseUrl,
    apiKey,
    model,
    messages,
    undefined,
    { onContent: onToken, onThought: opts?.onThought },
    opts,
  );
  return { content: result.content ?? '', model: result.model, usage: result.usage };
}

export async function messagesCompletionWithTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
  opts?: ChatCompletionOptions,
  handlers: ToolStreamHandlers = {},
): Promise<ToolCompletionResult> {
  if (opts?.stream !== false && (handlers.onContent || handlers.onThought)) {
    return messagesStream(baseUrl, apiKey, model, messages, tools, handlers, opts);
  }
  const response = await postMessages(baseUrl, apiKey, buildBody(model, messages, { ...opts, stream: false }, tools), opts);
  return parseDocument(await readDocument(response), model);
}
