import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { SessionStore } from '../../sessions/session-store.js';
import { appendAssistantReply } from '../assistant-reply.js';
import { matchMarketResearchSlash } from '../../skills/market-pipeline-capability.js';
import {
  runMarketPipeline,
  type MarketResearchPhase,
} from '../../skills/market-pipeline-runner.js';

function inferPhase(message: string, matchedTool?: string): MarketResearchPhase {
  if (matchedTool === 'market_feasibility') return 'feasibility';
  if (matchedTool === 'market_product_plan') return 'plan';
  if (matchedTool === 'market_deep_research') return 'research';
  const slash = matchMarketResearchSlash(message);
  if (slash) return slash.phase;
  if (/타당성|feasibility|RAG\s*검토/i.test(message)) return 'feasibility';
  if (/기획서|product\s*plan|승인하고\s*기획/i.test(message)) return 'plan';
  return 'research';
}

function extractBrief(message: string): string {
  const slash = matchMarketResearchSlash(message);
  if (slash) return slash.brief;
  return message
    .replace(/^\s*(심층리서치|딥리서치|시장조사|타당성|기획서)\s*/i, '')
    .trim();
}

/** Returns a chat response when pipeline produced a report; null = fall through to skill LLM chat. */
export async function handleMarketResearchMode(opts: {
  cqrRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
  message: string;
  routing: RouteDecision;
}): Promise<ChatResponse | null> {
  const { cqrRoot, sessionStore, sessionId, message, routing } = opts;
  const phase = inferPhase(message, routing.matched_tool);
  const brief = extractBrief(message);

  const result = runMarketPipeline({
    cqrRoot,
    phase,
    brief,
    sessionId,
  });

  if (result.ok && result.markdown) {
    const header = [
      '조사 계획 수립 → 웹 검색 → 근거 정리 → 리포트 작성',
      '',
      result.session_id ? `세션: \`${result.session_id}\`` : null,
      result.output_dir ? `출력: \`${result.output_dir}\`` : null,
      '',
    ]
      .filter((line) => line != null)
      .join('\n');

    const content = appendAssistantReply(sessionStore, sessionId, {
      content: `${header}${result.markdown}\n\n_다음: 원할 때만 **타당성** 또는 **기획서까지** 요청. 기본은 심층리서치에서 종료._`,
      model: 'org/market_research',
      mode: 'org:market_research',
      emptyFallback: '시장조사 리포트가 비어 있습니다.',
    });

    return {
      role: 'assistant',
      content,
      mode: 'org:market_research',
      routing,
      model: 'org/market_research',
      research: result.session_id
        ? {
            id: result.session_id,
            url: result.output_dir ? `file://${result.output_dir}` : '',
            title: brief.slice(0, 80) || 'market research',
          }
        : undefined,
    };
  }

  // Pipeline unavailable or incomplete — skill inject chat continues.
  if (result.used_fallback_chat) return null;

  const content = appendAssistantReply(sessionStore, sessionId, {
    content: `**시장조사 실행 실패**\n\n${result.error ?? '알 수 없는 오류'}`,
    model: 'org/market_research',
    mode: 'org:market_research',
  });

  return {
    role: 'assistant',
    content,
    mode: 'org:market_research',
    routing,
    model: 'org/market_research',
  };
}
