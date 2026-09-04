import {
  chatCompletionWithTools,
  chatCompletion,
  chatCompletionStream,
  type ChatMessage,
  type ToolCompletionResult,
  shouldFallbackToClientToolProtocol,
  chatContentToText,
  rememberClientToolProtocol,
  describeToolProtocolFallback,
} from '../providers/openai-compatible.js';
import { harnessCompletionExtras } from '../providers/harness-policy.js';
import { isUpstreamConnectionDrop } from '../debug-session-log.js';
import { AgentInfraError } from './agent-failure-plane.js';
import {
  normalizeToolCall,
  parseClientToolCalls,
  enrichClientToolCalls,
  stripToolMimeticNoise,
  type AgentToolDefinition,
} from './tools.js';
import { appendClientToolProtocol } from './agent-tool-protocol.js';
import { scrubAgentChannelLeak } from '../chat/chat-filters.js';
import type { ProviderWireApi } from '../providers/types.js';
import type { ResponsesContinuationState } from '../sessions/types.js';

export interface LlmStepAgentOptions {
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
  onThought?: (text: string) => void;
  /** Omit reasoning_effort on models that reject thinking (qwen2.5:7b). */
  providerId?: string;
  wireApi?: ProviderWireApi;
  nativeToolsLocked?: boolean;
  responsesState?: ResponsesContinuationState;
  onResponsesState?: (state: ResponsesContinuationState) => void;
  /** Used to tier reasoning (simple single-file → medium). */
  userMessage?: string;
  reasoningEffort?: string | null;
}

const AGENT_STEP_TIMEOUT_MS = 600_000;
type CodeAgentOptions = LlmStepAgentOptions;

export type AgentToolProtocol = 'api' | 'client';

/** Resolve LLM step timeout — OWUI probe passes a short timeoutMs via stepOpts. */
export function resolveAgentStepTimeoutMs(stepOpts?: { timeoutMs?: number }): number {
  if (typeof stepOpts?.timeoutMs === 'number' && stepOpts.timeoutMs > 0) {
    return stepOpts.timeoutMs;
  }
  return AGENT_STEP_TIMEOUT_MS;
}

function llmExtras(opts: CodeAgentOptions, modelId?: string) {
  const harness = harnessCompletionExtras(process.env, {
    providerId: opts.providerId,
    modelId,
  });
  return {
    wireApi: opts.wireApi ?? 'chat_completions',
    responsesState: opts.responsesState,
    onResponsesState: opts.onResponsesState,
    ...harness,
    ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    // One model round may return several independent reads; the host executes
    // only its strict read-only allowlist concurrently.
    parallelToolCalls: true,
  };
}
export async function completeAgentStepClientProtocol(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  opts: CodeAgentOptions,
  toolNames: string[],
): Promise<ToolCompletionResult> {
  const protocolMessages = appendClientToolProtocol(messages, toolNames);

  const finishFromRaw = (raw: string, model: string): ToolCompletionResult => {
    const tool_calls = enrichClientToolCalls(
      parseClientToolCalls(raw).map((call) => normalizeToolCall(call)),
      raw,
    );
    const content = stripToolMimeticNoise(raw);
    return {
      content: content || null,
      tool_calls,
      model,
      finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
    };
  };

  // Stream so UI is not frozen until the full reply arrives.
  const t0 = Date.now();
  opts.onStatus?.('도구 호출 생성 중 — 모델 스트리밍…');
  let buf = '';
  let lastUi = 0;
  try {
    const streamed = await chatCompletionStream(
      baseUrl,
      apiKey,
      modelId,
      protocolMessages,
      (delta) => {
        buf += delta;
        const now = Date.now();
        if (now - lastUi < 350) return;
        lastUi = now;
        const sec = Math.round((now - t0) / 1000);
        opts.onStatus?.(
          `도구 호출 생성 중… ${buf.length.toLocaleString()}자 · ${sec}초`,
        );
      },
      { timeoutMs: AGENT_STEP_TIMEOUT_MS, signal: opts.signal, ...llmExtras(opts, modelId) },
    );
    const raw = (streamed.content || buf).trim();
    if (raw) {
      opts.onStatus?.('도구 호출 수신 · 파싱 중…');
      return finishFromRaw(raw, streamed.model);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.onStatus?.(`스트림 실패, 재시도… (${msg.slice(0, 80)})`);
    // Partial TOOL_CALL already buffered — use it instead of waiting on a dead upstream.
    if (buf.trim() && /TOOL_CALL\s*:/i.test(buf)) {
      opts.onStatus?.('스트림 중단 — 버퍼된 TOOL_CALL로 계속');
      return finishFromRaw(buf.trim(), modelId);
    }
    // Connection drop: skip long non-stream wait (often another 3–4 min → 504).
    // Outer infra retry + stream-safe write notes recover faster.
    if (isUpstreamConnectionDrop(msg)) {
      throw new AgentInfraError(`OWUI_STREAM_TERMINATED: ${msg.slice(0, 160)}`, e);
    }
  }

  const plain = await chatCompletion(
    baseUrl,
    apiKey,
    modelId,
    protocolMessages,
    { timeoutMs: AGENT_STEP_TIMEOUT_MS, signal: opts.signal, ...llmExtras(opts, modelId) },
  );
  return finishFromRaw(plain.content, plain.model);
}

export async function completeAgentAnswerStep(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  opts: CodeAgentOptions,
  streamHandlers?: { onThought: (delta: string) => void; onContent?: (delta: string) => void },
): Promise<ToolCompletionResult> {
  // The caller supplies a phase=final Context View. Do not mechanically truncate
  // evidence here; final prose must be authored by the model from selected evidence.
  const plainMessages = buildPlainChatMessages(messages);

  const deliver = (text: string, model: string): ToolCompletionResult => {
    const cleaned = scrubAgentChannelLeak(text.trim());
    if (cleaned && streamHandlers?.onContent) streamHandlers.onContent(cleaned);
    return { content: cleaned, tool_calls: [], model, finish_reason: 'stop' };
  };

  const tryPlain = async (msgs: ChatMessage[]): Promise<ToolCompletionResult | null> => {
    try {
      const plain = await chatCompletion(
        baseUrl,
        apiKey,
        modelId,
        msgs,
        { timeoutMs: AGENT_STEP_TIMEOUT_MS, signal: opts.signal, ...llmExtras(opts, modelId) },
      );
      if (plain.content?.trim()) return deliver(plain.content, plain.model);
    } catch {
      /* next strategy */
    }
    if (streamHandlers) {
      try {
        const streamed = await chatCompletionStream(
          baseUrl,
          apiKey,
          modelId,
          msgs,
          (delta) => streamHandlers.onContent?.(delta),
          { timeoutMs: AGENT_STEP_TIMEOUT_MS, signal: opts.signal, ...llmExtras(opts, modelId) },
        );
        if (streamed.content?.trim()) return deliver(streamed.content, streamed.model);
      } catch {
        /* synthesize below */
      }
    }
    return null;
  };

  const first = await tryPlain(plainMessages);
  if (first) return first;
  return { content: null, tool_calls: [], model: modelId, finish_reason: 'stop' };
}

/** OWUI /api rejects OpenAI tool-role turns — fold tool output into normal user/assistant messages. */
export function buildPlainChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolBlocks: string[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      const t = chatContentToText(m.content).trim();
      if (t) toolBlocks.push(t);
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const t = chatContentToText(m.content).trim();
      if (t) out.push({ role: 'assistant', content: t });
      continue;
    }
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      const t = chatContentToText(m.content).trim();
      if (t) {
        out.push({ role: m.role, content: t });
      }
    }
  }

  if (toolBlocks.length) {
    out.push({
      role: 'user',
      content: [
        '[도구 실행 결과]',
        toolBlocks.join('\n\n---\n\n'),
        '',
        '위 결과와 전체 대화를 반영해 사용자의 현재 요청에 답변하세요.',
        '답변 구조와 포함할 정보는 직접 판단하고, 작업 보고서·변경 경로·진단·다음 조치 형식을 강제하지 마세요.',
        '도구 원문을 그대로 덤프하지 말되 모델이 발견한 유용한 정보는 보존하세요.',
        '도구는 MY Agent가 로컬에서 실행합니다. 「Tool not found / 작업공간 API 실패」라고 말하지 마세요.',
        'Unknown tool이면 allowed 이름(read_file/write_file/edit_file 등)으로 다시 호출하면 됩니다.',
      ].join('\n'),
    });
  }
  return out;
}

export async function completeAgentStep(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  opts: CodeAgentOptions,
  tools: AgentToolDefinition[],
  stepOpts?: {
    streamHandlers?: { onThought: (delta: string) => void; onContent?: (delta: string) => void };
    toolChoice?: 'auto' | 'required' | 'none';
    stream?: boolean;
    /** OWUI native-tools probe etc. — defaults to AGENT_STEP_TIMEOUT_MS when omitted. */
    timeoutMs?: number;
  },
): Promise<ToolCompletionResult> {
  const stream = stepOpts?.stream ?? Boolean(stepOpts?.streamHandlers);
  const timeoutMs = resolveAgentStepTimeoutMs(stepOpts);
  return chatCompletionWithTools(
    baseUrl,
    apiKey,
    modelId,
    messages,
    tools,
    {
      timeoutMs,
      signal: opts.signal,
      ...llmExtras(opts, modelId),
      stream,
      toolChoice: stepOpts?.toolChoice,
    },
    stepOpts?.streamHandlers,
  );
}

export async function safeCompleteAgentStep(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  opts: CodeAgentOptions,
  tools: AgentToolDefinition[],
  stepOpts?: Parameters<typeof completeAgentStep>[6],
): Promise<ToolCompletionResult> {
  try {
    return await completeAgentStep(baseUrl, apiKey, modelId, messages, opts, tools, stepOpts);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (shouldFallbackToClientToolProtocol(msg)) {
      throw e;
    }
    if (msg === 'EMPTY_COMPLETION' || msg.includes('CHAT_TOOLS_FAILED')) {
      return { content: null, tool_calls: [], model: modelId, finish_reason: 'stop' };
    }
    throw e;
  }
}

export async function completeAgentStepWithProtocol(
  protocol: AgentToolProtocol,
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  opts: CodeAgentOptions,
  agentTools: AgentToolDefinition[],
  toolNames: string[],
  stepOpts?: Parameters<typeof completeAgentStep>[6],
  protocolCacheKey?: string,
): Promise<{ result: ToolCompletionResult; protocol: AgentToolProtocol }> {
  if (protocol === 'client') {
    return {
      protocol: 'client',
      result: await completeAgentStepClientProtocol(
        baseUrl,
        apiKey,
        modelId,
        messages,
        opts,
        toolNames,
      ),
    };
  }
  try {
    const result = await completeAgentStep(
      baseUrl,
      apiKey,
      modelId,
      messages,
      opts,
      agentTools,
      stepOpts,
    );
    return { result, protocol: 'api' };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.nativeToolsLocked) throw e;
    if (!shouldFallbackToClientToolProtocol(msg)) throw e;
    const reason = describeToolProtocolFallback(msg);
    if (protocolCacheKey) rememberClientToolProtocol(protocolCacheKey, reason);
    opts.onStatus?.(
      `네이티브 API tools 불가 (${reason}) → 텍스트 TOOL_CALL로 실행 (정상 폴백)`,
    );
    return {
      protocol: 'client',
      result: await completeAgentStepClientProtocol(
        baseUrl,
        apiKey,
        modelId,
        messages,
        opts,
        toolNames,
      ),
    };
  }
}


