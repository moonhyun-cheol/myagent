import type { ProviderStore } from './provider-store.js';
import {
  chatCompletion,
  chatCompletionStreamOrStub,
  type ChatContentPart,
  type ChatMessage,
} from './openai-compatible.js';
import { harnessCompletionExtras, ollamaEmergencyFallbackEnabled } from './harness-policy.js';
import type { SessionMessage } from '../sessions/types.js';
import type { SessionStore } from '../sessions/session-store.js';
import { ProviderError } from './types.js';
import {
  wrapUserMessageWithContext,
  workspaceSystemInstruction,
  defaultChatSystemInstruction,
} from '../chat/chat-context.js';
import { isOwuiOrGatewayError } from '../agent/code-agent.js';

export class CloudChatService {
  constructor(
    private readonly store: ProviderStore,
    private readonly sessions?: SessionStore,
    private readonly cqrRoot?: string,
  ) {}

  private responsesOptions(
    providerId: string,
    modelId: string,
    wireApi: import('./types.js').ProviderWireApi,
    sessionId?: string,
  ) {
    if (wireApi !== 'responses' || !sessionId || !this.sessions) return {};
    // Direct OpenAI has a known provider-side response store. Gateways replay exact
    // encrypted reasoning/output items unless their stateful capability is configured later.
    const mode = providerId === 'openai' ? 'provider_state' as const : 'client_replay' as const;
    const responsesState = this.sessions.responsesState(sessionId, providerId, modelId, mode);
    return {
      responsesState,
      onResponsesState: (state: import('../sessions/types.js').ResponsesContinuationState) => {
        this.sessions?.saveResponsesState(sessionId, state);
      },
    };
  }

  buildMessages(
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    systemPrompt?: string,
    hasWorkspaceContext = false,
    imageDataUrls: string[] = [],
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const sysParts: string[] = [defaultChatSystemInstruction()];
    if (systemPrompt?.trim()) sysParts.push(systemPrompt.trim());
    if (hasWorkspaceContext) sysParts.push(workspaceSystemInstruction());
    if (sysParts.length) {
      messages.push({ role: 'system', content: sysParts.join('\n\n') });
    }
    for (const m of history) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    }
    const text = wrapUserMessageWithContext(userMessage, attachmentContext);
    if (imageDataUrls.length) {
      const parts: ChatContentPart[] = [{ type: 'text', text }];
      for (const url of imageDataUrls) {
        parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
      }
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: text });
    }
    return messages;
  }

  async complete(
    providerId: string,
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[] = [],
    systemPrompt?: string,
    opts?: {
      modelId?: string;
      timeoutMs?: number;
      hasWorkspaceContext?: boolean;
      signal?: AbortSignal;
      imageDataUrls?: string[];
      sessionId?: string;
      reasoningEffort?: string | null;
    },
  ): Promise<{ content: string; model: string }> {
    try {
      return await this.completeAt(providerId, userMessage, attachmentContext, history, systemPrompt, opts);
    } catch (e: unknown) {
      const fallback = this.resolveOllamaFallback(providerId);
      if (fallback && isOwuiOrGatewayError(e)) {
        return this.completeAt(fallback.providerId, userMessage, attachmentContext, history, systemPrompt, {
          ...opts,
          modelId: fallback.modelId,
          imageDataUrls: undefined,
        });
      }
      throw e;
    }
  }

  async completeStream(
    providerId: string,
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    onToken: (text: string) => void,
    systemPrompt?: string,
    opts?: {
      modelId?: string;
      timeoutMs?: number;
      hasWorkspaceContext?: boolean;
      signal?: AbortSignal;
      imageDataUrls?: string[];
      sessionId?: string;
      reasoningEffort?: string | null;
    },
  ): Promise<{ content: string; model: string }> {
    try {
      return await this.completeStreamAt(
        providerId,
        userMessage,
        attachmentContext,
        history,
        onToken,
        systemPrompt,
        opts,
      );
    } catch (e: unknown) {
      const fallback = this.resolveOllamaFallback(providerId);
      if (fallback && isOwuiOrGatewayError(e)) {
        return this.completeStreamAt(
          fallback.providerId,
          userMessage,
          attachmentContext,
          history,
          onToken,
          systemPrompt,
          { ...opts, modelId: fallback.modelId, imageDataUrls: undefined },
        );
      }
      throw e;
    }
  }

  private resolveOllamaFallback(
    providerId: string,
  ): { providerId: string; modelId?: string } | null {
    if (!ollamaEmergencyFallbackEnabled()) return null;
    if (providerId === 'ollama') return null;
    const ollama = this.store.resolveProvider('ollama');
    if (!ollama) return null;
    return { providerId: 'ollama', modelId: ollama.modelId };
  }

  private async completeAt(
    providerId: string,
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    systemPrompt?: string,
    opts?: {
      modelId?: string;
      timeoutMs?: number;
      hasWorkspaceContext?: boolean;
      signal?: AbortSignal;
      imageDataUrls?: string[];
      sessionId?: string;
      reasoningEffort?: string | null;
    },
  ): Promise<{ content: string; model: string }> {
    const resolved = this.store.resolveProvider(providerId, opts?.modelId);
    if (!resolved) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', `${providerId} API 키가 등록되지 않았습니다.`);
    }

    const { secret, modelId, baseUrl, def, wireApi } = resolved;
    if (secret.api_key.startsWith('stub:')) {
      return {
        content: `[stub cloud · ${def.name} · ${modelId}]\n${userMessage}`,
        model: `${def.name}/${modelId}`,
      };
    }
    const messages = this.buildMessages(
      userMessage,
      attachmentContext,
      history,
      systemPrompt,
      Boolean(opts?.hasWorkspaceContext),
      opts?.imageDataUrls ?? [],
    );

    const result = await chatCompletion(baseUrl, secret.api_key, modelId, messages, {
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      wireApi,
      ...this.responsesOptions(providerId, modelId, wireApi, opts?.sessionId),
      ...harnessCompletionExtras(process.env, { providerId, modelId }),
      ...(opts?.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    });
    return { content: result.content, model: `${def.name}/${result.model}` };
  }

  private async completeStreamAt(
    providerId: string,
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    onToken: (text: string) => void,
    systemPrompt?: string,
    opts?: {
      modelId?: string;
      timeoutMs?: number;
      hasWorkspaceContext?: boolean;
      signal?: AbortSignal;
      imageDataUrls?: string[];
      sessionId?: string;
      reasoningEffort?: string | null;
    },
  ): Promise<{ content: string; model: string }> {
    const resolved = this.store.resolveProvider(providerId, opts?.modelId);
    if (!resolved) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', `${providerId} API 키가 등록되지 않았습니다.`);
    }

    const { secret, modelId, baseUrl, def, wireApi } = resolved;
    const enrichedSystemPrompt = systemPrompt;
    const messages = this.buildMessages(
      userMessage,
      attachmentContext,
      history,
      systemPrompt,
      Boolean(opts?.hasWorkspaceContext),
      opts?.imageDataUrls ?? [],
    );

    const result = await chatCompletionStreamOrStub(
      baseUrl,
      secret.api_key,
      modelId,
      messages,
      onToken,
      {
        signal: opts?.signal,
        wireApi,
        ...this.responsesOptions(providerId, modelId, wireApi, opts?.sessionId),
        ...harnessCompletionExtras(process.env, { providerId, modelId }),
        ...(opts?.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      },
    );
    return { content: result.content, model: `${def.name}/${result.model}` };
  }
}
