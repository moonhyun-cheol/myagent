import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { SessionStore } from '../../sessions/session-store.js';
import { appendAssistantReply } from '../assistant-reply.js';
import { matchMarketResearchSlash } from '../../skills/market-pipeline-capability.js';
import {
  runMarketPipeline,
  type MarketPipelineRunResult,
  type MarketResearchPhase,
} from '../../skills/market-pipeline-runner.js';
import {
  buildBriefPrompt,
  parseBriefDecision,
  type MarketBriefDecision,
} from '../../skills/market-research-brief.js';
import {
  buildSynthesisPrompt,
  parseSynthesis,
  renderSynthesisMarkdown,
  synthesisFindingCount,
  type MarketSynthesis,
} from '../../skills/market-research-synthesis.js';

/** The app's chat model, called once per step (no history, no tools). */
export type MarketResearchLlm = (
  system: string,
  user: string,
  opts?: { timeoutMs?: number },
) => Promise<{ content: string; model: string }>;

const MODE = 'org:market_research';
const MODEL = 'org/market_research';
const BRIEF_TIMEOUT_MS = 60_000;
const SYNTHESIS_TIMEOUT_MS = 240_000;

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

const FAILURE_TITLE: Record<string, string> = {
  needs_brief: '조사할 대상을 확인해 주세요',
  insufficient_evidence: '근거가 부족해 리포트를 만들지 않았습니다',
  unavailable: '이 단계는 지금 사용할 수 없습니다',
};

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
}

/** Last turns before the current message, for the follow-up judgment. */
function recentTurns(sessionStore: SessionStore, sessionId: string, message: string) {
  const messages = sessionStore.load(sessionId)?.messages ?? [];
  const list = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const last = list[list.length - 1];
  const before = last && last.role === 'user' && last.content === message ? list.slice(0, -1) : list;
  return {
    recent: before.slice(-4).map((m) => ({ role: m.role, content: m.content })),
    // A report, not a one-line failure or question.
    hasPreviousReport: before.some((m) => m.role === 'assistant' && m.mode === MODE && m.content.length > 600),
  };
}

async function decideBrief(
  llm: MarketResearchLlm,
  ctx: Parameters<typeof buildBriefPrompt>[0],
): Promise<MarketBriefDecision | null> {
  try {
    const prompt = buildBriefPrompt(ctx);
    const out = await llm(prompt.system, prompt.user, { timeoutMs: BRIEF_TIMEOUT_MS });
    return parseBriefDecision(out.content, ctx);
  } catch {
    return null; // the pipeline's rule parser reads the sentence instead
  }
}

async function synthesize(
  llm: MarketResearchLlm,
  result: MarketPipelineRunResult,
): Promise<{ synthesis: MarketSynthesis; model: string } | { error: string }> {
  const pack = result.evidence_pack!;
  const prompt = buildSynthesisPrompt(pack);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const user =
        attempt === 0
          ? prompt.user
          : `${prompt.user}\n\n(이전 응답이 유효한 JSON이 아니었습니다. 설명 없이 JSON 객체 하나만 출력하세요.)`;
      const out = await llm(prompt.system, user, { timeoutMs: SYNTHESIS_TIMEOUT_MS });
      const synthesis = parseSynthesis(out.content, pack);
      if (!synthesis) {
        lastError = '응답이 JSON 형식이 아니었습니다';
        continue;
      }
      if (!synthesisFindingCount(synthesis)) {
        return { error: `검증을 통과한 항목이 없었습니다(제외 ${synthesis.dropped.length}건)` };
      }
      return { synthesis, model: out.model };
    } catch (e: unknown) {
      return { error: errorText(e) };
    }
  }
  return { error: lastError };
}

/**
 * /심층리서치: brief (app LLM) → web evidence pack (organization pipeline) → synthesis (app LLM,
 * checked by code). Returns null to fall through to the org skill chat: a follow-up on the
 * previous report, or no pipeline installed.
 */
export async function handleMarketResearchMode(opts: {
  cqrRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
  message: string;
  routing: RouteDecision;
  /** App LLM; null when no provider is configured (pack is shown without synthesis). */
  llm?: MarketResearchLlm | null;
  onStatus?: (text: string) => void;
  /** Test seam. */
  runPipeline?: typeof runMarketPipeline;
}): Promise<ChatResponse | null> {
  const { cqrRoot, sessionStore, sessionId, message, routing } = opts;
  const llm = opts.llm ?? null;
  const status = opts.onStatus ?? (() => {});
  const runPipeline = opts.runPipeline ?? runMarketPipeline;
  const phase = inferPhase(message, routing.matched_tool);
  const brief = extractBrief(message);

  const reply = (content: string, model = MODEL, research?: ChatResponse['research']): ChatResponse => {
    const stored = appendAssistantReply(sessionStore, sessionId, {
      content,
      model,
      mode: MODE,
      emptyFallback: '시장조사 결과가 비어 있습니다.',
    });
    return { role: 'assistant', content: stored, mode: MODE, routing, model, ...(research ? { research } : {}) };
  };

  let decision: MarketBriefDecision | null = null;
  if (phase === 'research' && llm) {
    status('요청 해석 중…');
    const { recent, hasPreviousReport } = recentTurns(sessionStore, sessionId, message);
    decision = await decideBrief(llm, {
      message,
      brief,
      explicit: Boolean(matchMarketResearchSlash(message)),
      hasPreviousReport,
      recent,
    });
    // A follow-up ("리포트 형식으로 줘") is answered from the chat history, not a new search.
    if (decision?.action === 'followup') return null;
    if (decision?.action === 'clarify') return reply(`**${FAILURE_TITLE.needs_brief}**\n\n${decision.question}`);
  }

  if (phase === 'research') status('미국 웹 근거 수집 중… (보통 30~80초)');
  const result = await runPipeline({ cqrRoot, phase, brief, fields: decision?.fields, sessionId });

  if (!result.ok) {
    // Pipeline genuinely unavailable — skill inject chat continues.
    if (result.used_fallback_chat) return null;
    const title = FAILURE_TITLE[result.status ?? ''] ?? '시장조사 실행 실패';
    return reply(`**${title}**\n\n${result.error ?? '알 수 없는 오류'}`);
  }

  const research = result.session_id
    ? {
        id: result.session_id,
        url: result.output_dir ? `file://${result.output_dir}` : '',
        title: brief.slice(0, 80) || 'market research',
      }
    : undefined;
  const packPath = result.output_dir ? path.join(result.output_dir, 'research_report.md') : undefined;

  if (result.evidence_pack && llm) {
    status('근거 종합 중…');
    const done = await synthesize(llm, result);
    if ('synthesis' in done) {
      const markdown = renderSynthesisMarkdown({
        pack: result.evidence_pack,
        synthesis: done.synthesis,
        model: done.model,
        sessionId: result.session_id,
        packPath,
      });
      if (result.output_dir) {
        try {
          writeFileSync(path.join(result.output_dir, 'market_report.md'), markdown, 'utf8');
        } catch {
          /* the chat reply still carries the report */
        }
      }
      return reply(markdown, `${MODEL} · ${done.model}`, research);
    }
    return reply(
      `> 앱 LLM으로 근거를 종합하지 못해(${done.error}) 수집한 근거 팩을 그대로 보여드립니다.\n\n${result.markdown ?? ''}`,
      MODEL,
      research,
    );
  }

  const note = result.evidence_pack
    ? '> 연결된 LLM이 없어 근거를 종합하지 않고 수집한 근거 팩을 그대로 보여드립니다.\n\n'
    : '';
  return reply(`${note}${result.markdown ?? ''}`, MODEL, research);
}
