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
 * - A market/trend study (`brief.study === 'trend'`) adds a year-by-year timeline. A timeline
 *   finding keeps only the cited items published in its year or naming its year; with none left
 *   (or a year outside the study period) it is dropped, so a statement cannot move between years.
 * - Every citation is rendered as a link to its source page, so `[E17]` opens that page.
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
export interface SynthesisTimeline extends SynthesisFinding {
  year: string;
}

export type SynthesisDropReason = 'no_valid_citation' | 'unsupported_figure' | 'year_not_in_evidence';

export interface MarketSynthesis {
  irrelevant: string[];
  summary: SynthesisFinding[];
  pains: SynthesisPain[];
  competitors: SynthesisCompetitor[];
  market: SynthesisFinding[];
  gaps: SynthesisFinding[];
  /** Year-by-year findings of a market/trend study, oldest year first; empty otherwise. */
  timeline: SynthesisTimeline[];
  unknowns: string[];
  /** Findings removed by the checks, with the reason. */
  dropped: Array<{ section: string; text: string; reason: SynthesisDropReason }>;
}

const KIND_LABEL: Record<string, string> = { review: '리뷰·불만', competitor: '경쟁사·가격', market: '시장·트렌드' };
const ITEM_CHARS = 1800;
const PRICE_LINE_CHARS = 600;
const MAX_FINDINGS = 8;
const MAX_TIMELINE = 16;
/** evidence_pack.py appends the page's "product name $price" lines to `detail` after this mark. */
const PRICE_LINE_MARK = '[가격 표기 줄]';

/** True for a market/trend study pack (`study: trend`). */
export function isTrendPack(pack: MarketEvidencePack): boolean {
  return pack.brief?.study === 'trend';
}

/** Years the pipeline searched for a trend study, oldest first. */
export function packYears(pack: MarketEvidencePack): string[] {
  const fromStats = pack.stats?.years;
  const years = Array.isArray(fromStats) ? fromStats.map(String) : [];
  const period = pack.brief?.period;
  if (!years.length && typeof period === 'string') {
    const m = /(20\d\d)(?:\s*-\s*(20\d\d))?/.exec(period);
    if (m) for (let y = Number(m[1]); y <= Number(m[2] ?? m[1]); y++) years.push(String(y));
  }
  return [...new Set(years.filter((y) => /^20\d\d$/.test(y)))].sort();
}

/** Published that year, or the item's text names the year. Mirrors `about_year` in evidence_pack.py. */
export function itemAboutYear(item: MarketEvidenceItem, year: string): boolean {
  if ((item.published ?? '').startsWith(year)) return true;
  return new RegExp(`(?<!\\d)${year}(?!\\d)`).test(`${item.title} ${item.excerpt} ${item.detail ?? ''}`);
}

function periodLabel(pack: MarketEvidencePack): string {
  const years = packYears(pack);
  return !years.length ? '' : years.length === 1 ? years[0] : `${years[0]}-${years[years.length - 1]}`;
}

function clean(text: unknown, max = 400): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Split `detail` into the page text and its price lines. They are cut to length separately, so
 * a long page body can never push the product-price pairs out of the prompt.
 */
export function splitDetail(detail: unknown): { body: string; priceLines: string } {
  const text = typeof detail === 'string' ? detail : '';
  const at = text.indexOf(PRICE_LINE_MARK);
  return at < 0 ? { body: text, priceLines: '' } : { body: text.slice(0, at), priceLines: text.slice(at + PRICE_LINE_MARK.length) };
}

/** An http(s) URL safe inside `(<…>)` and inside a table cell; '' for anything else. */
export function linkHref(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.href.replace(/[<>|\s]/g, (c) => encodeURIComponent(c));
  } catch {
    return '';
  }
}

/** Escape text used as link text so brackets or emphasis marks in a page title cannot break the link. */
function linkText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, '\\$&');
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
  if (b.study === 'trend') add('조사 유형', '시장·트렌드 추이');
  add('기간', b.study === 'trend' ? periodLabel(pack) : b.period);
  return parts.join(' / ');
}

export function packScope(pack: MarketEvidencePack): string {
  const b = pack.brief ?? {};
  return clean(b.product, 80) || clean(b.category, 80) || clean(b.product_en, 80) || '시장조사';
}

function itemText(item: MarketEvidenceItem): string {
  const { body: detailBody, priceLines } = splitDetail(item.detail);
  const body = clean(detailBody, ITEM_CHARS) || clean(item.excerpt, ITEM_CHARS);
  const prices = [...new Set([...(item.prices ?? []), ...(item.page_prices ?? [])])];
  return [
    `[${item.id}] ${KIND_LABEL[item.kind] ?? item.kind} · ${item.domain} · ${item.source === '본문' ? '본문' : '검색 요약문'}`,
    item.published ? `게시일: ${item.published}` : '',
    `제목: ${clean(item.title, 160)}`,
    `내용: ${body}`,
    prices.length ? `가격 표기: ${prices.join(', ')}` : '',
    priceLines.trim() ? `가격 표기 줄(페이지의 제품명과 가격): ${clean(priceLines, PRICE_LINE_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSynthesisPrompt(pack: MarketEvidencePack): { system: string; user: string } {
  const trend = isTrendPack(pack);
  const years = packYears(pack);
  const trendSchema = trend ? [' "timeline":[{"year":"YYYY","text":"그해 미국 시장·트렌드에서 일어난 일","cites":["E…"]}],'] : [];
  const trendRules = trend
    ? [
        `- This is a market/trend study of ${years.join(', ') || 'recent years'}. summary: the overall direction`,
        '  across the period (what grew, faded or changed), each point cited.',
        `- timeline: for each year (${years.join(', ')}), what the evidence says happened that year: demand,`,
        '  styles, materials, colors, prices, brands. Cite only items published that year (게시일) or that',
        '  name that year; never move a statement to another year. No item for a year without such evidence;',
        '  say so in unknowns instead.',
      ]
    : [];
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
    ...trendSchema,
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
    '- 가격 표기 줄 pairs product names with prices as shown on the page ("Carhartt … Bomber $125").',
    '  A price next to a product name there counts as stated for that product.',
    '- Write every dollar amount and percentage exactly as it appears in the cited items.',
    '- market: US market size, growth or trend statements only. gaps: hypotheses, each grounded in',
    '  cited pains or competitor facts.',
    '- At most 8 items per section. An empty list is fine when the evidence does not support one.',
    ...trendRules,
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

  function check<T extends SynthesisFinding>(
    section: string,
    list: unknown,
    build: (o: Record<string, unknown>) => T,
    opts: { limit?: number; scope?: (item: T, ids: string[]) => string[] } = {},
  ): T[] {
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
      if (opts.scope) {
        item.cites = opts.scope(item, item.cites);
        if (!item.cites.length) {
          dropped.push({ section, text: shown.slice(0, 160), reason: 'year_not_in_evidence' });
          continue;
        }
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
      if (out.length >= (opts.limit ?? MAX_FINDINGS)) break;
    }
    return out;
  }

  const years = packYears(pack);
  const timeline = isTrendPack(pack)
    ? check(
        'timeline',
        obj.timeline,
        (o) => ({ year: (/20\d\d/.exec(clean(o.year, 20)) ?? [''])[0], text: clean(o.text), cites: [] }),
        {
          limit: MAX_TIMELINE,
          // Only items of that year count; a year outside the study period has none.
          scope: (item, ids) =>
            item.year && (!years.length || years.includes(item.year))
              ? ids.filter((id) => itemAboutYear(byId.get(id)!, item.year))
              : [],
        },
      ).sort((a, b) => a.year.localeCompare(b.year))
    : [];

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
    timeline,
    unknowns: (Array.isArray(obj.unknowns) ? obj.unknowns : []).map((u) => clean(u, 300)).filter(Boolean).slice(0, 8),
    dropped,
  };
}

/** Findings that survived the checks. Zero means the synthesis produced nothing usable. */
export function synthesisFindingCount(s: MarketSynthesis): number {
  return s.summary.length + s.pains.length + s.competitors.length + s.market.length + s.gaps.length + s.timeline.length;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
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
  // `[E17]` links to the cited page; an item without a usable URL stays plain text.
  const cites = (ids: string[]) =>
    ids
      .map((id) => {
        const href = linkHref(byId.get(id)?.url);
        return href ? `[\\[${id}\\]](<${href}>)` : `[${id}]`;
      })
      .join('');
  const relevant = pack.evidence.filter((e) => !s.irrelevant.includes(e.id));
  const bodyCount = relevant.filter((e) => e.source === '본문').length;
  const trend = isTrendPack(pack);
  const period = periodLabel(pack);
  const out: string[] = [
    trend ? `# 미국 시장·트렌드 추이 — ${packScope(pack)}${period ? ` (${period})` : ''}` : `# 미국 시장조사 — ${packScope(pack)}`,
    '',
    `> 미국 웹 근거 ${relevant.length}건(본문 ${bodyCount}건, 검색 요약문 ${relevant.length - bodyCount}건)을 ` +
      `앱 LLM(${model})이 종합했습니다. 모든 항목에 근거 번호가 붙어 있고, 근거에 없는 번호나 근거에 없는 ` +
      `금액·비율이 든 항목은 코드가 뺐습니다${s.dropped.length ? `(${s.dropped.length}건)` : ''}.` +
      (trend ? ' 연도별 항목은 그해에 게시됐거나 그해를 다룬 근거만 인용합니다.' : ''),
  ];
  const scope = briefLine(pack);
  if (scope) out.push('', `- 조사 범위: ${scope}`);
  if (args.sessionId) out.push(`- 세션: \`${args.sessionId}\``);

  out.push('', '## 핵심 요약', '');
  out.push(...(s.summary.length ? s.summary.map((f) => `- ${f.text} ${cites(f.cites)}`) : [EMPTY]));

  const timelineSection = () => {
    out.push('', '## 연도별 추이');
    const years = packYears(pack);
    for (const year of years.length ? years : [...new Set(s.timeline.map((t) => t.year))]) {
      const items = s.timeline.filter((t) => t.year === year);
      out.push('', `### ${year}년`, '');
      out.push(...(items.length ? items.map((t) => `- ${t.text} ${cites(t.cites)}`) : ['_근거 부족 — 이 해에 게시됐거나 이 해를 다룬 근거가 없습니다._']));
    }
  };
  const painSection = () => {
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
  };
  const competitorSection = () => {
    out.push('', '## 경쟁 제품·가격', '');
    if (s.competitors.length) {
      out.push('| 브랜드 | 제품 | 가격 | 메모 | 근거 |', '|---|---|---|---|---|');
      for (const c of s.competitors) {
        out.push(`| ${cell(c.brand || '-')} | ${cell(c.product || '-')} | ${cell(c.price || '확인 필요')} | ${cell(c.text)} | ${cites(c.cites)} |`);
      }
    } else {
      out.push(EMPTY);
    }
  };
  const marketSection = () => {
    out.push('', '## 시장·트렌드', '');
    out.push(...(s.market.length ? s.market.map((f) => `- ${f.text} ${cites(f.cites)}`) : [EMPTY]));
  };
  // A trend study reads the market first; a product study starts from buyers' complaints.
  if (trend) {
    timelineSection();
    marketSection();
    competitorSection();
    painSection();
  } else {
    painSection();
    competitorSection();
    marketSection();
  }

  out.push('', '## 시장 공백 가설', '');
  out.push(...(s.gaps.length ? s.gaps.map((f) => `- (가설) ${f.text} ${cites(f.cites)}`) : [EMPTY]));

  out.push('', '## 확인 필요', '');
  const unknowns = [
    ...s.unknowns,
    ...(trend ? ['연도별 판매량·검색량 같은 수치 추이는 웹 기사 근거만으로 확정하지 않습니다.'] : []),
    '페르소나·세그먼트·시장 규모 추정·가격 전략은 웹 근거만으로 확정하지 않습니다.',
  ];
  out.push(...unknowns.map((u) => `- ${u}`));

  out.push('', '## 근거 목록', '');
  for (const e of relevant) {
    const published = e.published ? ` · 게시일 ${e.published}` : '';
    const href = linkHref(e.url);
    const id = href ? `[${e.id}](<${href}>)` : e.id;
    const title = href ? `[${linkText(clean(e.title, 300))}](<${href}>)` : cell(e.title);
    out.push(`- **${id}** · ${KIND_LABEL[e.kind] ?? e.kind} · ${e.domain} · ${e.source === '본문' ? '본문' : '요약문'}${published} — ${title}`);
  }
  if (s.irrelevant.length) {
    out.push(
      '',
      `주제와 무관하다고 판단해 종합에서 뺀 근거 ${s.irrelevant.length}건: ` +
        s.irrelevant.map((id) => `${id}(${byId.get(id)?.domain ?? '?'})`).join(', '),
    );
  }
  if (s.dropped.length) {
    const count = (reason: SynthesisDropReason) => s.dropped.filter((d) => d.reason === reason).length;
    const year = count('year_not_in_evidence');
    out.push(
      '',
      `검증에서 뺀 항목 ${s.dropped.length}건: 유효한 근거 번호 없음 ${count('no_valid_citation')}건, ` +
        `근거에 없는 금액·비율 ${count('unsupported_figure')}건` +
        (year ? `, 그해를 다룬 근거 없음 ${year}건.` : '.'),
    );
  }
  if (args.packPath) out.push('', `발췌 원문이 담긴 근거 팩: \`${args.packPath}\``);
  return out.join('\n');
}
