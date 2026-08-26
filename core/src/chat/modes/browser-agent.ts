import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { ProviderStore } from '../../providers/provider-store.js';
import type { SessionStore } from '../../sessions/session-store.js';
import { runBrowserVisionAgent } from '../../browser/browser-vision-agent.js';
import { appendAssistantReply, withNarrativeCompletionRetry } from '../assistant-reply.js';

export async function handleBrowserAgentMode(opts: {
  cqrRoot: string;
  configPath: string;
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  sessionId: string;
  message: string;
  routing: RouteDecision;
}): Promise<ChatResponse> {
  const { cqrRoot, configPath, sessionStore, sessionId, message, routing } = opts;
  const run = () =>
    runBrowserVisionAgent({
      cqrRoot,
      configPath,
      providerStore: opts.providerStore,
      sessionId,
      message,
    });

  let result = await run();
  if (!result.ok && result.error && result.steps > 0) {
    result = await run();
  }

  const imageUrls = result.imageUrls;
  let raw = result.ok
    ? result.content
    : `**브라우저 에이전트 실패**\n\n${result.content}`;

  if (result.ok) {
    raw = await withNarrativeCompletionRetry(raw, async () => {
      const again = await run();
      return again.ok ? again.content : raw;
    }, sessionId);
  }

  const content = appendAssistantReply(sessionStore, sessionId, {
    content: raw,
    model: 'browser/vision-agent',
    mode: 'browser_agent',
    image_urls: imageUrls.length ? imageUrls : undefined,
    emptyFallback: '브라우저 에이전트 응답이 비어 있습니다. URL과 지시를 확인한 뒤 다시 시도하세요.',
  });

  return {
    role: 'assistant',
    content,
    mode: 'browser_agent',
    routing,
    model: 'browser/vision-agent',
    ...(imageUrls[0]
      ? { image: { url: imageUrls[imageUrls.length - 1] }, images: imageUrls.map((url) => ({ url })) }
      : {}),
  };
}
