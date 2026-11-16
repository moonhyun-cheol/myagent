/**
 * Synthesis step of /심층리서치: the app's LLM reads the organization pipeline's evidence pack
 * (web excerpts with ids E1…) and writes the findings; code then checks every finding.
 *
 * - Each finding must cite evidence ids that exist in the pack (and were not judged off-topic).
 * - Every dollar amount and percentage in a finding must appear in the items it cites, so a
 *   price or market figure cannot come from the model's memory.
 * - A finding that fails either check is dropped and counted; a section left empty says so.
 * - Pain frequency is the number of distinct evidence items (and sites) behind it, counted by
 *   code, not a percentage estimated by the model.
 */
import { extractJsonObject } from './market-research-brief.js';
import type { MarketEvidenceItem, MarketEvidencePack } from './market-pipeline-runner.js';

export interface SynthesisFinding {
  text: string;
  cites: string[];
}
export interface SynthesisPain extends SynthesisFinding {
  pain: string;
}
export interface SynthesisCompetitor extends SynthesisFinding {
  brand: string;
  product: string;
  price: string;
}

export interface MarketSynthesis {
  irrelevant: string[];
  summary: SynthesisFinding[];
  pains: SynthesisPain[];
  competitors: SynthesisCompetitor[];
  market: SynthesisFinding[];
  gaps: SynthesisFinding[];
  unknowns: string[];
  /** Findings removed by the checks, with the reason. */
  dropped: Array<{ section: string; text: string; reason: 'no_valid_citation' | 'unsupported_figure' }>;
}

const KIND_LABEL: Record<string, string> = { review: '리뷰·불만', competitor: '경쟁사·가격', market: '시장·트렌드' };
const ITEM_CHARS = 1800;
const MAX_FINDINGS = 8;

function clean(text: unknown, max = 400): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function briefLine(pack: MarketEvidencePack): string {
  const b = pack.brief ?? {};
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    const v = Array.isArray(value) ? value.join(', ') : clean(value, 200);
    if (v) parts.push(`${label}: ${v}`);
  };
  add('품목', b.product);
  add('검색 영문명', b.product_en);
  add('카테고리', b.category);
  add('시즌', b.season);
  add('채널', b.channel);
  add('가격대', b.price_band);
  add('경쟁사', b.competitors);
  add('초점', b.focus);
  return parts.join(' / ');
}

export function packScope(pack: MarketEvidencePack): string {
  const b = pack.brief ?? {};
  return clean(b.product, 80) || clean(b.category, 80) || clean(b.product_en, 80) || '시장조사';
}

function itemText(item: MarketEvidenceItem): string {
  const body = clean(item.detail, ITEM_CHARS) || clean(item.excerpt, ITEM_CHARS);
  const prices = [...new Set([...(item.prices ?? []), ...(item.page_prices ?? [])])];
  return [
    `[${item.id}] ${KIND_LABEL[item.kind] ?? item.kind} · ${item.domain} · ${item.source === '본문' ? '본문' : '검색 요약문'}`,
    `제목: ${clean(item.title, 160)}`,
    `내용: ${body}`,
    prices.length ? `가격 표기: ${prices.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSynthesisPrompt(pack: MarketEvidencePack): { system: string; user: string } {
  const system = [
    'You are a market researcher for CQR, a US apparel brand (tactical, outdoor, workwear).',
    'You get web evidence about the US market, each item with an id like E3. Write the findings',
    'in Korean. Use ONLY the evidence; do not add facts, brands, prices or figures from memory.',
    'Return ONE JSON object and nothing else:',
    '{"irrelevant":["E…"],',
    ' "summary":[{"text":"","cites":["E…"]}],',
    ' "pains":[{"pain":"짧은 이름","text":"무엇이 문제인지","cites":["E…"]}],',
    ' "competitors":[{"brand":"","product":"","price":"","text":"강점·약점·포지션","cites":["E…"]}],',
    ' "market":[{"text":"","cites":["E…"]}],',
    ' "gaps":[{"text":"CQR이 노릴 수 있는 공백 가설","cites":["E…"]}],',
    ' "unknowns":["근거로 확인할 수 없었던 것"]}',
    '',
    'Rules:',
    '- irrelevant: ids of items that are not about the researched product/category or not about the',
    '  US market (another product, a software app, a store\'s shipping complaints, an ad page).',
    '  Never cite them.',
    '- Every item in summary/pains/competitors/market/gaps cites at least one relevant id.',
    '- pains: problems buyers report with the product (fit, durability, function…), not shopping or',
    '  delivery issues. Merge the same problem from several items into one pain citing all of them.',
    '- competitors: a brand/product with its price only when the cited item states that price for',
    '  that product. Leave price "" otherwise. A price for another thing (a guitar, a fashion house',
    '  bag in a trend article, a shipping threshold) is not a competitor price.',
    '- Write every dollar amount and percentage exactly as it appears in the cited items.',
    '- market: US market size, growth or trend statements only. gaps: hypotheses, each grounded in',
    '  cited pains or competitor facts.',
    '- At most 8 items per section. An empty list is fine when the evidence does not support one.',
  ].join('\n');
  const user = [
    `조사 범위: ${briefLine(pack) || packScope(pack)}`,
    `대상 시장: ${pack.market ?? 'US'}`,
    '',
    '근거:',
    ...pack.evidence.map(itemText),
  ].join('\n\n');
  return { system, user };
}

const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(billion|million|trillion|bn|mn|[bmk])\b)?/gi;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s?%/g;

/** Dollar amounts as comparable keys: "$1,299" -> "1299", "$17.9 billion" -> "17.9b". */
export function moneyKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(MONEY_RE)) {
    const whole = m[1].replace(/,/g, '');
    const cents = m[2] && Number(m[2]) !== 0 ? `.${m[2].replace(/0$/, '')}` : '';
    // billion / bn / B -> b, million / mn / M -> m, trillion -> t, k -> k
    const scale = (m[3] ?? '').toLowerCase().charAt(0);
    out.push(`${Number(whole)}${cents}${scale}`);
  }
  return out;
}

export function percentKeys(text: string): string[] {
  return [...String(text ?? '').matchAll(PERCENT_RE)].map((m) => String(Number(m[1])));
}

function citeList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  return [...new Set(raw.map((v) => String(v).trim().toUpperCase().replace(/^\[|\]$/g, '')).filter((v) => /^E\d+$/.test(v)))];
}

/**
 * Validate the model's JSON against the pack. Returns null when the reply is not usable JSON.
 */
export function parseSynthesis(raw: string, pack: MarketEvidencePack): MarketSynthesis | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const byId = new Map(pack.evidence.map((e) => [e.id, e]));
  const irrelevant = citeList(obj.irrelevant).filter((id) => byId.has(id));
  const usable = new Set([...byId.keys()].filter((id) => !irrelevant.includes(id)));
  const dropped: MarketSynthesis['dropped'] = [];
  const sourceText = (ids: string[]) =>
    ids
      .map((id) => byId.get(id)!)
      .map((e) => [e.title, e.excerpt, e.detail, ...(e.prices ?? []), ...(e.page_prices ?? [])].join(' '))
      .join(' ');

  function check<T extends SynthesisFinding>(section: string, list: unknown, build: (o: Record<string, unknown>) => T): T[] {
    const out: T[] = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== 'object') continue;
      const item = build(entry as Record<string, unknown>);
      const shown = [item.text, ...Object.values(item).filter((v) => typeof v === 'string')].join(' ');
      if (!item.text && !shown.trim()) continue;
      item.cites = citeList((entry as Record<string, unknown>).cites).filter((id) => usable.has(id));
      if (!item.cites.length) {
        dropped.push({ section, text: shown.slice(0, 160), reason: 'no_valid_citation' });
        continue;
      }
      const cited = sourceText(item.cites);
      const money = new Set(moneyKeys(cited));
      const percents = new Set(percentKeys(cited));
      const unsupported =
        moneyKeys(shown).some((k) => !money.has(k)) || percentKeys(shown).some((k) => !percents.has(k));
      if (unsupported) {
        dropped.push({ section, text: shown.slice(0, 160), reason: 'unsupported_figure' });
        continue;
      }
      out.push(item);
      if (out.length >= MAX_FINDINGS) break;
    }
    return out;
  }

  const finding = (o: Record<string, unknown>): SynthesisFinding => ({ text: clean(o.text), cites: [] });
  const pains = check('pains', obj.pains, (o) => ({ pain: clean(o.pain, 60), text: clean(o.text), cites: [] }));
  pains.sort((a, b) => b.cites.length - a.cites.length);
  return {
    irrelevant,
    summary: check('summary', obj.summary, finding),
    pains,
    competitors: check('competitors', obj.competitors, (o) => ({
      brand: clean(o.brand, 60),
      product: clean(o.product, 100),
      price: clean(o.price, 60),
      text: clean(o.text),
      cites: [],
    })),
    market: check('market', obj.market, finding),
    gaps: check('gaps', obj.gaps, finding),
    unknowns: (Array.isArray(obj.unknowns) ? obj.unknowns : []).map((u) => clean(u, 300)).filter(Boolean).slice(0, 8),
    dropped,
  };
}

/** Findings that survived the checks. Zero means the synthesis produced nothing usable. */
export function synthesisFindingCount(s: MarketSynthesis): number {
  return s.summary.length + s.pains.length + s.competitors.length + s.market.length + s.gaps.length;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function cites(ids: string[]): string {
  return ids.map((id) => `[${id}]`).join('');
}

const EMPTY = '_근거 부족 — 이 항목을 뒷받침하는 근거를 찾지 못했습니다._';

export function renderSynthesisMarkdown(args: {
  pack: MarketEvidencePack;
  synthesis: MarketSynthesis;
  model: string;
  sessionId?: string;
  packPath?: string;
}): string {
  const { pack, synthesis: s, model } = args;
  const byId = new Map(pack.evidence.map((e) => [e.id, e]));
  const relevant = pack.evidence.filter((e) => !s.irrelevant.includes(e.id));
  const bodyCount = relevant.filter((e) => e.source === '본문').length;
  const out: string[] = [
    `# 미국 시장조사 — ${packScope(pack)}`,
    '',
    `> 미국 웹 근거 ${relevant.length}건(본문 ${bodyCount}건, 검색 요약문 ${relevant.length - bodyCount}건)을 ` +
      `앱 LLM(${model})이 종합했습니다. 모든 항목에 근거 번호가 붙어 있고, 근거에 없는 번호나 근거에 없는 ` +
      `금액·비율이 든 항목은 코드가 뺐습니다${s.dropped.length ? `(${s.dropped.length}건)` : ''}.`,
  ];
  const scope = briefLine(pack);
  if (scope) out.push('', `- 조사 범위: ${scope}`);
  if (args.sessionId) out.push(`- 세션: \`${args.sessionId}\``);

  out.push('', '## 핵심 요약', '');
  out.push(...(s.summary.length ? s.summary.map((f) => `- ${f.text} ${cites(f.cites)}`) : [EMPTY]));

  out.push('', '## 소비자 불만·페인 포인트', '');
  if (s.pains.length) {
    out.push('| 페인 | 근거 수 | 내용 | 근거 |', '|---|---|---|---|');
    for (const p of s.pains) {
      const sites = new Set(p.cites.map((id) => byId.get(id)?.domain)).size;
      out.push(`| ${cell(p.pain || '-')} | ${p.cites.length}건 (${sites}개 사이트) | ${cell(p.text)} | ${cites(p.cites)} |`);
    }
    out.push('', '_근거 수는 이 불만을 언급한 근거 건수입니다. 표본이 작아 비율로 읽으면 안 됩니다._');
  } else {
    out.push(EMPTY);
  }

  out.push('', '## 경쟁 제품·가격', '');
  if (s.competitors.length) {
    out.push('| 브랜드 | 제품 | 가격 | 메모 | 근거 |', '|---|---|---|---|---|');
    for (const c of s.competitors) {
      out.push(`| ${cell(c.brand || '-')} | ${cell(c.product || '-')} | ${cell(c.price || '확인 필요')} | ${cell(c.text)} | ${cites(c.cites)} |`);
    }
  } else {
    out.push(EMPTY);
  }

  out.push('', '## 시장·트렌드', '');
  out.push(...(s.market.length ? s.market.map((f) => `- ${f.text} ${cites(f.cites)}`) : [EMPTY]));

  out.push('', '## 시장 공백 가설', '');
  out.push(...(s.gaps.length ? s.gaps.map((f) => `- (가설) ${f.text} ${cites(f.cites)}`) : [EMPTY]));

  out.push('', '## 확인 필요', '');
  const unknowns = [...s.unknowns, '페르소나·세그먼트·시장 규모 추정·가격 전략은 웹 근거만으로 확정하지 않습니다.'];
  out.push(...unknowns.map((u) => `- ${u}`));

  out.push('', '## 근거 목록', '');
  for (const e of relevant) {
    out.push(`- **${e.id}** · ${KIND_LABEL[e.kind] ?? e.kind} · ${e.domain} · ${e.source === '본문' ? '본문' : '요약문'} — [${cell(e.title)}](${e.url})`);
  }
  if (s.irrelevant.length) {
    out.push(
      '',
      `주제와 무관하다고 판단해 종합에서 뺀 근거 ${s.irrelevant.length}건: ` +
        s.irrelevant.map((id) => `${id}(${byId.get(id)?.domain ?? '?'})`).join(', '),
    );
  }
  if (s.dropped.length) {
    const noCite = s.dropped.filter((d) => d.reason === 'no_valid_citation').length;
    const figure = s.dropped.length - noCite;
    out.push(
      '',
      `검증에서 뺀 항목 ${s.dropped.length}건: 유효한 근거 번호 없음 ${noCite}건, 근거에 없는 금액·비율 ${figure}건.`,
    );
  }
  if (args.packPath) out.push('', `발췌 원문이 담긴 근거 팩: \`${args.packPath}\``);
  return out.join('\n');
}
