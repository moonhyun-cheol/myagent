import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { ResolvedModelRoute } from '../../providers/types.js';
import type { ProviderStore } from '../../providers/provider-store.js';
import type { SessionStore } from '../../sessions/session-store.js';
import type { DeepResearchPipeline } from '../../research/deep-research.js';
import { appendAssistantReply, withNarrativeCompletionRetry } from '../assistant-reply.js';

export async function handleDeepResearchMode(opts: {
  research: DeepResearchPipeline;
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  sessionId: string;
  message: string;
  routing: RouteDecision;
  resolved: ResolvedModelRoute;
}): Promise<ChatResponse> {
  const { research, providerStore, sessionStore, sessionId, message, routing, resolved } = opts;

  const llmProviderId =
    resolved.route.type === 'provider' ? resolved.route.providerId : providerStore.getDefaultId();
  const llmModelId = resolved.route.type === 'provider' ? resolved.route.modelId : undefined;

  const run = () => research.run(message, sessionId, { llmProviderId, llmModelId });
  let report = await run();
  let markdown = await withNarrativeCompletionRetry(
    report.markdown,
    async () => {
      report = await run();
      return report.markdown;
    },
    sessionId,
  );

  const content = appendAssistantReply(sessionStore, sessionId, {
    content: markdown,
    model: resolved.display,
    mode: 'deep_research',
    emptyFallback:
      '딥리서치 보고서가 비어 있습니다. 주제를 구체화해 다시 요청하거나 프로바이더 연결을 확인하세요.',
  });

  return {
    role: 'assistant',
    content,
    mode: 'deep_research',
    routing,
    model: resolved.display,
    research: {
      id: report.id,
      url: `/outputs/research/${sessionId}/${report.id}.md`,
      title: report.title,
    },
  };
}
