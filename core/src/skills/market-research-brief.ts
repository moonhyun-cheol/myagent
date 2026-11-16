/**
 * Brief step of /심층리서치: the app's LLM reads the chat message and returns structured
 * fields (product, US search name, category, season, …) or says the message is a follow-up
 * on the previous report. The organization pipeline only parses a sentence with rules, so
 * without this step 「리포트 형식으로 줘」 or 「바지 부분만 다시 요약해줘」 started a new study.
 *
 * Code keeps the decisions the model must not make alone: an explicit slash command is
 * always a new study, a follow-up needs an earlier report in this chat, and values the user
 * wrote as inline fields (`품목: …`) are never replaced.
 */
import { MARKET_BRIEF_FIELDS, type MarketBriefField, type MarketBriefFields } from './market-pipeline-runner.js';

export type MarketBriefAction = 'research' | 'followup' | 'clarify';

export interface MarketBriefDecision {
  action: MarketBriefAction;
  fields: MarketBriefFields;
  /** Korean question for `clarify`. */
  question?: string;
}

export interface MarketBriefContext {
  message: string;
  /** Text after the slash command (or the message without its trigger word). */
  brief: string;
  /** True for /심층리서치 · /딥리서치: always a new study. */
  explicit: boolean;
  /** This chat already has a market-research reply to follow up on. */
  hasPreviousReport: boolean;
  /** Last turns of this chat, oldest first. */
  recent: Array<{ role: string; content: string }>;
}

/** Inline keys per field; mirrors `FIELD_KEYS` in the organization pipeline (evidence_pack.py). */
const FIELD_KEYS: Record<MarketBriefField, string[]> = {
  product: ['품목', '제품', 'product', 'item'],
  product_en: ['영문명', '영문', '검색어', 'product_en', 'english'],
  category: ['카테고리', 'category'],
  season: ['시즌', 'season'],
  channel: ['채널', 'channel'],
  price_band: ['가격대', '가격', 'price_band', 'price'],
  competitors: ['경쟁사', 'competitors', 'competitor'],
  focus: ['초점', '포커스', 'focus'],
};

/** Fields the user wrote inline as `키: 값` in the brief. */
export function inlineBriefFields(brief: string): Set<MarketBriefField> {
  const found = new Set<MarketBriefField>();
  for (const name of MARKET_BRIEF_FIELDS) {
    for (const key of FIELD_KEYS[name]) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Not preceded by a letter/digit (so "price" inside "price_band" or "영문명" is not "영문").
      if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}\\s*[:=]`, 'iu').test(brief)) found.add(name);
    }
  }
  return found;
}

const MAX_FIELD_CHARS = 160;

export function buildBriefPrompt(ctx: MarketBriefContext): { system: string; user: string } {
  const system = [
    'You turn a chat request into a structured brief for US market research. The company is CQR,',
    'a US apparel brand (tactical, outdoor, workwear). The research searches the US web in English.',
    'Return ONE JSON object and nothing else:',
    '{"action":"research|followup|clarify","product":"","product_en":"","category":"","season":"",',
    '"channel":"","price_band":"","competitors":[],"focus":"","question":""}',
    '',
    'Rules:',
    '- action "followup": the message asks about, reformats, summarizes, filters or continues the',
    '  previous market-research report (e.g. "리포트 형식으로 줘", "바지 부분만 다시 요약해줘",',
    '  "경쟁사만 표로") instead of asking for a new study. Only possible when a previous report exists.',
    '- action "clarify": neither a product nor a category can be identified. Put one short Korean',
    '  question in "question".',
    '- action "research": a new study. Fill the fields:',
    '  - product: the product as the user wrote it (Korean is fine). Empty for a category-wide study.',
    '  - product_en: the English name US shoppers search for it, specific enough to be unambiguous',
    '    ("dress slacks", not "slacks"; "bomber jacket"; "tactical cargo pants"). Always fill it.',
    '  - category: the broader English category the product belongs to ("men\'s dress pants",',
    '    "outdoor apparel"); used to search market-size reports.',
    '  - season, channel, price_band (like "$40-90"), focus (English keywords): only what the user stated.',
    '  - competitors: only brands the user named. Never add brands the user did not name.',
    '- Never invent values the user did not state, except the English translations above.',
  ].join('\n');
  const history = ctx.recent
    .slice(-4)
    .map((m) => `${m.role}: ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');
  const user = [
    `Explicit research command: ${ctx.explicit ? 'yes (action must be research or clarify)' : 'no'}`,
    `Previous market-research report in this chat: ${ctx.hasPreviousReport ? 'yes' : 'no'}`,
    history ? `Recent chat (oldest first):\n${history}` : 'Recent chat: (none)',
    '',
    `Message: ${ctx.message}`,
  ].join('\n');
  return { system, user };
}

/** First JSON object in a model reply (fences and prose around it are ignored). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fieldValue(name: MarketBriefField, value: unknown): string {
  const raw = Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(', ') : typeof value === 'string' ? value : '';
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
  // The US search name must be English: a Korean value would search Korean pages.
  if (name === 'product_en' || name === 'category') return /[^\x00-\x7F’]/.test(text) ? '' : text;
  return text;
}

/**
 * Validate the model's JSON. Returns null when it is unusable (the caller then passes the raw
 * brief to the pipeline's rule parser, as before this step existed).
 */
export function parseBriefDecision(raw: string, ctx: Pick<MarketBriefContext, 'explicit' | 'hasPreviousReport' | 'brief'>): MarketBriefDecision | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const inline = inlineBriefFields(ctx.brief);
  const fields: MarketBriefFields = {};
  for (const name of MARKET_BRIEF_FIELDS) {
    if (inline.has(name)) continue; // the user's own `키: 값` wins; the pipeline reads it
    const value = fieldValue(name, obj[name]);
    if (value) fields[name] = value;
  }
  const hasScope = Boolean(fields.product || fields.category || inline.has('product') || inline.has('category'));
  let action: MarketBriefAction =
    obj.action === 'followup' || obj.action === 'clarify' ? obj.action : 'research';
  if (action === 'followup' && (ctx.explicit || !ctx.hasPreviousReport)) action = hasScope ? 'research' : 'clarify';
  if (action === 'research' && !hasScope) action = 'clarify';
  if (action === 'clarify' && ctx.explicit && hasScope) action = 'research';
  const question = typeof obj.question === 'string' ? obj.question.trim().slice(0, 300) : '';
  return {
    action,
    fields: action === 'research' ? fields : {},
    ...(action === 'clarify' ? { question: question || '어떤 품목이나 카테고리의 미국 시장을 조사할까요? 예: 품목: 스키바지 / 시즌: 2027 FW' } : {}),
  };
}
