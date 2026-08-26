import { wrapUserMessageWithContext, workspaceSystemInstruction, defaultChatSystemInstruction } from '../chat/chat-context.js';
import type { SessionMessage } from '../sessions/types.js';
import {
  chatCompletion,
  chatCompletionStreamOrStub,
  type ChatMessage,
} from '../providers/openai-compatible.js';
import { getLocalLlamaRuntime } from './local-llama-runtime.js';

export class LocalChatService {
  constructor(private readonly cqrRoot: string) {}

  buildMessages(
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    systemPrompt?: string,
    hasWorkspaceContext = false,
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
    messages.push({
      role: 'user',
      content: wrapUserMessageWithContext(userMessage, attachmentContext),
    });
    return messages;
  }

  async completeStream(
    modelPath: string,
    filename: string,
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    onToken: (text: string) => void,
    systemPrompt?: string,
    hasWorkspaceContext = false,
    signal?: AbortSignal,
  ): Promise<{ content: string; model: string }> {
    const runtime = getLocalLlamaRuntime(this.cqrRoot);
    const server = await runtime.ensureServer(modelPath);
    const messages = this.buildMessages(
      userMessage,
      attachmentContext,
      history,
      systemPrompt,
      hasWorkspaceContext,
    );
    const result = await chatCompletionStreamOrStub(
      server.baseUrl,
      'local',
      'local',
      messages,
      onToken,
      { signal },
    );
    return { content: result.content, model: `local:${filename}` };
  }

  async complete(
    modelPath: string,
    filename: string,
    userMessage: string,
    attachmentContext: string | undefined,
    history: SessionMessage[],
    systemPrompt?: string,
    hasWorkspaceContext = false,
  ): Promise<{ content: string; model: string }> {
    const runtime = getLocalLlamaRuntime(this.cqrRoot);
    const server = await runtime.ensureServer(modelPath);
    const messages = this.buildMessages(
      userMessage,
      attachmentContext,
      history,
      systemPrompt,
      hasWorkspaceContext,
    );
    const result = await chatCompletion(server.baseUrl, 'local', 'local', messages);
    return { content: result.content, model: `local:${filename}` };
  }
}
