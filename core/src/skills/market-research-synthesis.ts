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
 * - The year of an item is the date of the version that was read (`updated`, else `published`):
 *   an updated guide keeps its first publication date (Esquire's "for 2026" list says 2016).
 * - Findings the checks removed are listed with the reason (and the figures that were not found).
 * - Layout, kept short for the chat panel: a two-line header; 핵심 요약 with a key-figures table
 *   (지표·값·지역·기준·근거 — each number found in its cited item, its geography named there, a figure
 *   for a future year a forecast); the analysis sections in the order of the study type (trend:
 *   연도별 추이 → 시장 동인·제약 → 경쟁 → 불만; product: 불만 → 경쟁 → 시장 동인·제약), with a
 *   price-band line computed from the competitor table; CQR 기회 가설·다음 단계; 확인 필요.
 *   A section without evidence is left out and named under 확인 필요 instead of printing a blank.
 * - Scope, method (the pack's own search statistics and queries), limits, the source list (with a
 *   source type per item) and the findings the checks removed go to an appendix below a rule.
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
/** One market figure as the cited item writes it (size, growth, sales volume, search volume, share). */
export interface SynthesisFigure extends SynthesisFinding {
  metric: string;
  value: string;
  /** Year the figure is for; '' when neither the cited text nor the item's date shows it. */
  year: string;
  /** 미국 | 북미 | Amazon US | 글로벌 | 기타 | 확인 필요 (the cited items do not name that geography). */
  geo: string;
  /** 실측 | 추정 | 전망 | '' — a figure for a year after this one is always 전망. */
  basis: string;
}
export type SourceType = 'research' | 'data' | 'media' | 'community' | 'retail' | 'other';

export type SynthesisDropReason =
  | 'no_valid_citation'
  | 'unsupported_figure'
  | 'unsupported_number'
  | 'year_not_in_evidence';

export interface MarketSynthesis {
  irrelevant: string[];
  summary: SynthesisFinding[];
  pains: SynthesisPain[];
  competitors: SynthesisCompetitor[];
  market: SynthesisFinding[];
  gaps: SynthesisFinding[];
  /** Year-by-year findings of a market/trend study, oldest year first; empty otherwise. */
  timeline: SynthesisTimeline[];
  figures: SynthesisFigure[];
  drivers: SynthesisFinding[];
  restraints: SynthesisFinding[];
  /** Next steps for CQR's product team, each grounded in cited findings. */
  actions: SynthesisFinding[];
  /** Source type of each relevant item, as the model judged it. */
  sourceTypes: Record<string, SourceType>;
  unknowns: string[];
  /** Findings removed by the checks, with the reason. */
  dropped: Array<{ section: string; text: string; reason: SynthesisDropReason; figures?: string[] }>;
}

const KIND_LABEL: Record<string, string> = { review: '리뷰·불만', competitor: '경쟁사·가격', market: '시장·트렌드' };
const ITEM_CHARS = 1800;
const PRICE_LINE_CHARS = 600;
const MAX_FINDINGS = 8;
const MAX_TIMELINE = 16;
const MAX_FIGURES = 10;
const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  research: '리서치 기관 요약',
  data: '판매·검색 데이터',
  media: '매체·가이드',
  community: '리뷰·커뮤니티',
  retail: '판매처·브랜드',
  other: '기타',
};
const SOURCE_TYPE_IDS = Object.keys(SOURCE_TYPE_LABEL);
/** Order of the key-figures table: US figures first, unnamed geography last. */
const GEO_ORDER = ['미국', '북미', 'Amazon US', '글로벌', '기타', '확인 필요'];
/** evidence_pack.py appends the page's "product name $price" lines to `detail` after this mark. */
const PRICE_LINE_MARK = '[가격 표기 줄]';
/** … and a market page's figure lines ("USD 41.07 Billion", "CAGR 3.37%") after this one. */
const FIGURE_LINE_MARK = '[시장 수치 줄]';
const GENDER_LABEL: Record<string, string> = { men: '남성', women: '여성', unisex: '공용', all: '전체' };
const SECTION_LABEL: Record<string, string> = {
  summary: '핵심 요약',
  pains: '소비자 불만',
  competitors: '경쟁 제품·가격',
  market: '시장 동향',
  gaps: '기회 가설',
  timeline: '연도별 추이',
  figures: '핵심 수치',
  drivers: '성장 요인',
  restraints: '제약 요인',
  actions: '다음 단계',
};
const DROP_ORDER: SynthesisDropReason[] = ['no_valid_citation', 'unsupported_figure', 'unsupported_number', 'year_not_in_evidence'];
const DROP_LABEL: Record<SynthesisDropReason, string> = {
  no_valid_citation: '유효한 근거 번호 없음',
  unsupported_figure: '인용한 근거에 없는 금액·비율',
  unsupported_number: '인용한 근거에 없는 수치',
  year_not_in_evidence: '그해를 다룬 근거 없음',
};

/** The model's geography label as one of GEO_ORDER. */
export function figureGeo(raw: string): string {
  const v = raw.trim();
  if (!v) return '확인 필요';
  if (/amazon/i.test(v)) return 'Amazon US';
  if (/북미|north america/i.test(v)) return '북미';
  if (/글로벌|global|world|세계/i.test(v)) return '글로벌';
  if (/미국|united states|^u\.?s\.?a?\.?$/i.test(v)) return '미국';
  return '기타';
}

/** The cited text names that geography ("US" only in capitals: "us" is a pronoun, "USD" a currency). */
function textNamesGeo(geo: string, text: string): boolean {
  switch (geo) {
    case '미국':
      return /\bU\.?S\.?(?:A\.?)?(?![A-Za-z])/.test(text) || /united states|america/i.test(text);
    case '북미':
      return /north america/i.test(text);
    case 'Amazon US':
      return /amazon/i.test(text);
    case '글로벌':
      return /global|worldwide|world/i.test(text);
    default:
      return true;
  }
}

function figureBasis(raw: string, year: string, thisYear: number): string {
  const v = raw.toLowerCase();
  let basis = /전망|예상|예측|forecast|project/.test(v)
    ? '전망'
    : /추정|estimat/.test(v)
      ? '추정'
      : /실측|실적|actual|reported/.test(v)
        ? '실측'
        : '';
  if (year && Number(year) > thisYear) basis = '전망';
  return basis;
}

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

/** Date of the version that was read: the update date, else the publication date. */
export function itemDate(item: MarketEvidenceItem): string {
  return item.updated || item.published || '';
}

/** The version read is from that year, or the item's text names the year. Mirrors `about_year` in evidence_pack.py. */
export function itemAboutYear(item: MarketEvidenceItem, year: string): boolean {
  if (itemDate(item).startsWith(year)) return true;
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
 * Split `detail` into the page text, its price lines and its market-figure lines. They are cut to
 * length separately, so a long page body can never push product prices or market figures out of
 * the prompt.
 */
export function splitDetail(detail: unknown): { body: string; priceLines: string; figureLines: string } {
  const text = typeof detail === 'string' ? detail : '';
  const marks = [PRICE_LINE_MARK, FIGURE_LINE_MARK]
    .map((mark) => ({ mark, at: text.indexOf(mark) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at);
  const part = (mark: string) => {
    const i = marks.findIndex((m) => m.mark === mark);
    if (i < 0) return '';
    return text.slice(marks[i].at + mark.length, i + 1 < marks.length ? marks[i + 1].at : undefined);
  };
  return {
    body: marks.length ? text.slice(0, marks[0].at) : text,
    priceLines: part(PRICE_LINE_MARK),
    figureLines: part(FIGURE_LINE_MARK),
  };
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
  add('타깃 성별', GENDER_LABEL[String(b.gender ?? '')] ?? b.gender);
  add('타깃 스타일', b.style);
  return parts.join(' / ');
}

function datesText(item: MarketEvidenceItem): string {
  return [item.published ? `게시일 ${item.published}` : '', item.updated ? `수정일 ${item.updated}` : '']
    .filter(Boolean)
    .join(' · ');
}

export function packScope(pack: MarketEvidencePack): string {
  const b = pack.brief ?? {};
  return clean(b.product, 80) || clean(b.category, 80) || clean(b.product_en, 80) || '시장조사';
}

function itemText(item: MarketEvidenceItem): string {
  const { body: detailBody, priceLines, figureLines } = splitDetail(item.detail);
  const body = clean(detailBody, ITEM_CHARS) || clean(item.excerpt, ITEM_CHARS);
  const prices = [...new Set([...(item.prices ?? []), ...(item.page_prices ?? [])])];
  return [
    `[${item.id}] ${KIND_LABEL[item.kind] ?? item.kind} · ${item.domain} · ${item.source === '본문' ? '본문' : '검색 요약문'}`,
    item.published ? `게시일: ${item.published}` : '',
    item.updated ? `수정일: ${item.updated} (읽은 내용은 이 날짜 판본)` : '',
    item.before_period ? '조사 기간 이전 글: 기간의 흐름·연도별 추이의 근거로 쓰지 말 것' : '',
    `제목: ${clean(item.title, 160)}`,
    `내용: ${body}`,
    prices.length ? `가격 표기: ${prices.join(', ')}` : '',
    priceLines.trim() ? `가격 표기 줄(페이지의 제품명과 가격): ${clean(priceLines, PRICE_LINE_CHARS)}` : '',
    figureLines.trim() ? `시장 수치 줄(페이지가 적은 시장 규모·성장률): ${clean(figureLines, PRICE_LINE_CHARS)}` : '',
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
        '  styles, materials, colors, prices, brands. Cite only items dated that year (수정일, else 게시일) or that',
        '  name that year; never move a statement to another year. No item for a year without such evidence;',
        '  say so in unknowns instead.',
        '- Items marked 조사 기간 이전 글 were written before the period: never cite them for the direction of',
        '  the period or for a year.',
        '- Name the month of a peak or a low when an item states it (seasonality).',
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
    ' "figures":[{"metric":"무엇을 잰 수치인지(근거의 시장 정의 그대로)","value":"근거에 적힌 그대로의 값","year":"YYYY","geo":"미국|북미|Amazon US|글로벌|기타","basis":"실측|추정|전망","cites":["E…"]}],',
    ' "drivers":[{"text":"미국 수요를 키우는 요인","cites":["E…"]}],',
    ' "restraints":[{"text":"미국 수요를 막는 요인·위험","cites":["E…"]}],',
    ' "actions":[{"text":"CQR 제품팀이 다음에 할 일","cites":["E…"]}],',
    ' "sources":{"E1":"research|data|media|community|retail|other"},',
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
    '- Write every dollar amount and percentage exactly as it appears in the cited items. Write a',
    '  projected or forecast figure as a forecast (전망·예상, with its year), never as a measured value.',
    '- summary: 3-5 conclusions a product team acts on (direction, what sells, where the risk is). Leave',
    '  the numbers to figures; repeat one only when the conclusion depends on it.',
    '- market: other US market statements (structure, channels, segments, buyer behaviour) that are not',
    '  already a figures row, a driver or a restraint; do not restate figures. A size for another market',
    '  (global, another country) is not the US market. gaps: hypotheses, each grounded in cited pains or',
    '  competitor facts, and checked against the competitor facts (no "gap" a cited product already fills).',
    '- 조사 범위 names the target customer (타깃 성별, 타깃 스타일). Write the gaps for that customer. An item',
    '  about another customer (women\'s fashion in a menswear study) may show the overall trend; say so.',
    '- 수정일 is the date of the version that was read; an item whose newest date is years old is weaker',
    '  evidence for the present.',
    '- figures: every market size, growth rate (CAGR), sales volume or revenue, search volume and share',
    '  the cited items state, one row each. value is copied exactly as written (no conversion, rounding',
    '  or sums). metric says what is measured, as the item defines the market ("미국 아우터 시장 매출",',
    '  "Amazon US 봄버재킷 상위 50개 월 판매량"). geo is the geography the item names. basis: 전망 for a',
    '  projected or forecast value, 추정 for a third party\'s estimate (a sales-estimate tool, a research',
    '  firm\'s sizing), 실측 only for reported actuals. Figures of differently defined markets stay separate',
    '  rows; never reconcile or compare them.',
    '- drivers / restraints: what pushes US demand up or holds it back (prices, tariffs, weather, styles,',
    '  channels, competition), as the cited items state it.',
    '- actions: 2-5 concrete next steps for CQR\'s product team that follow from the cited findings (what',
    '  to verify, which competitor product to benchmark, which price band or feature to test). No generic',
    '  advice.',
    '- sources: the type of every relevant item. research = a market research firm\'s report page (its',
    '  figures are that firm\'s estimates), data = a sales or search data tool, media = an article or',
    '  buying guide, community = reviews or a forum, retail = a store or brand product page.',
    '- At most 8 items per section (figures: 10). An empty list is fine when the evidence does not support one.',
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

// "$41.07 billion" and "USD 41.07 Billion" (how market reports write it) are the same figure.
const MONEY_RE = /(?:US\$|\bUSD\s?|\$)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(billion|million|trillion|bn|mn|[bmk])\b)?/gi;
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

const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Plain numbers as comparable keys: "20,500 units" -> "20500", "3.37%" -> "3.37". */
export function numberKeys(text: string): string[] {
  return [...String(text ?? '').matchAll(NUMBER_RE)].map((m) => String(Number(m[0].replace(/,/g, ''))));
}

const MONEY_ONE = new RegExp(MONEY_RE.source, 'i');
const PRICE_BANDS: Array<[string, number]> = [
  ['$50 미만', 50],
  ['$50–99', 100],
  ['$100–199', 200],
  ['$200–399', 400],
  ['$400 이상', Infinity],
];

/**
 * Unit prices of the competitor table: count, min, median, max and price bands. Amounts with a scale
 * ("$17.9 billion") are market figures, not prices, and are skipped. Null without any price.
 */
export function priceDistribution(
  prices: string[],
): { n: number; min: number; median: number; max: number; bands: Array<[string, number]> } | null {
  const values: number[] = [];
  for (const p of prices) {
    const m = MONEY_ONE.exec(String(p ?? ''));
    if (!m || m[3]) continue;
    values.push(Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`));
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const bands: Array<[string, number]> = [];
  let lower = 0;
  for (const [label, upper] of PRICE_BANDS) {
    const n = values.filter((v) => v >= lower && v < upper).length;
    if (n) bands.push([label, n]);
    lower = upper;
  }
  return { n: values.length, min: values[0], median, max: values[values.length - 1], bands };
}

function usd(value: number): string {
  return `$${value % 1 ? value.toFixed(2) : String(value)}`;
}

/** Amounts and percentages written in `shown` that are not in the cited text, as written. */
function unsupportedFigures(shown: string, money: Set<string>, percents: Set<string>): string[] {
  const out: string[] = [];
  for (const m of shown.matchAll(MONEY_RE)) if (moneyKeys(m[0]).some((k) => !money.has(k))) out.push(m[0].trim());
  for (const m of shown.matchAll(PERCENT_RE)) if (!percents.has(String(Number(m[1])))) out.push(m[0].trim());
  return [...new Set(out)];
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
    opts: {
      limit?: number;
      scope?: (item: T, ids: string[]) => string[];
      /** Text whose plain numbers must all appear in the cited items (a figure's value). */
      numbers?: (item: T) => string;
    } = {},
  ): T[] {
    const out: T[] = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== 'object') continue;
      const item = build(entry as Record<string, unknown>);
      // Every text field of the finding, once (text first): checked for figures and shown when dropped.
      const shown = [...new Set([item.text, ...Object.values(item).filter((v): v is string => typeof v === 'string')])]
        .filter(Boolean)
        .join(' · ');
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
      const figures = unsupportedFigures(shown, new Set(moneyKeys(cited)), new Set(percentKeys(cited)));
      if (figures.length) {
        dropped.push({ section, text: shown.slice(0, 160), reason: 'unsupported_figure', figures });
        continue;
      }
      if (opts.numbers) {
        const have = new Set(numberKeys(cited));
        const missing = [...new Set(numberKeys(opts.numbers(item)).filter((k) => !have.has(k)))];
        if (missing.length) {
          dropped.push({ section, text: shown.slice(0, 160), reason: 'unsupported_number', figures: missing });
          continue;
        }
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

  const thisYear = new Date().getFullYear();
  const figures = check(
    'figures',
    obj.figures,
    (o) => ({
      metric: clean(o.metric, 120),
      value: clean(o.value, 80),
      year: (/20\d\d/.exec(clean(o.year, 20)) ?? [''])[0],
      geo: clean(o.geo, 30),
      basis: clean(o.basis, 20),
      text: clean(o.text, 200),
      cites: [],
    }),
    { limit: MAX_FIGURES, numbers: (f) => f.value },
  ).filter((f) => /\d/.test(f.value));
  for (const f of figures) {
    const cited = sourceText(f.cites);
    // A year neither written in the cited items nor their date is not the model's to add.
    const dated = f.cites.some((id) => itemDate(byId.get(id)!).startsWith(f.year));
    if (f.year && !dated && !new RegExp(`(?<!\\d)${f.year}(?!\\d)`).test(cited)) f.year = '';
    f.geo = figureGeo(f.geo);
    if (!textNamesGeo(f.geo, cited)) f.geo = '확인 필요';
    f.basis = figureBasis(f.basis, f.year, thisYear);
  }

  const sourceTypes: Record<string, SourceType> = {};
  const rawSources = obj.sources;
  const pairs: Array<[unknown, unknown]> = Array.isArray(rawSources)
    ? rawSources.map((r): [unknown, unknown] =>
        r && typeof r === 'object' ? [(r as Record<string, unknown>).id, (r as Record<string, unknown>).type] : [r, ''],
      )
    : rawSources && typeof rawSources === 'object'
      ? Object.entries(rawSources as Record<string, unknown>)
      : [];
  for (const [id, type] of pairs) {
    const key = citeList([id])[0];
    const value = String(type ?? '').trim().toLowerCase();
    if (key && usable.has(key) && SOURCE_TYPE_IDS.includes(value)) sourceTypes[key] = value as SourceType;
  }

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
    figures,
    drivers: check('drivers', obj.drivers, finding),
    restraints: check('restraints', obj.restraints, finding),
    actions: check('actions', obj.actions, finding, { limit: 5 }),
    sourceTypes,
    unknowns: (Array.isArray(obj.unknowns) ? obj.unknowns : []).map((u) => clean(u, 300)).filter(Boolean).slice(0, 8),
    dropped,
  };
}

/** Findings that survived the checks. Zero means the synthesis produced nothing usable. */
export function synthesisFindingCount(s: MarketSynthesis): number {
  return (
    s.summary.length +
    s.pains.length +
    s.competitors.length +
    s.market.length +
    s.gaps.length +
    s.timeline.length +
    s.figures.length +
    s.drivers.length +
    s.restraints.length +
    s.actions.length
  );
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

const EMPTY = '_근거 부족 — 이 항목을 뒷받침하는 근거를 찾지 못했습니다._';

function statNumber(stats: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = stats?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Product, period (or season) and target customer: the scope line under the title. */
function headerScope(pack: MarketEvidencePack): string {
  const b = pack.brief ?? {};
  const product = clean(b.product, 60);
  const en = clean(b.product_en, 60);
  const name =
    product && en && en.toLowerCase() !== product.toLowerCase() ? `${product}(${en})` : product || en || clean(b.category, 60);
  const when = isTrendPack(pack) ? periodLabel(pack) : clean(b.season, 30);
  const gender = GENDER_LABEL[String(b.gender ?? '')] ?? clean(b.gender, 20);
  const target = [gender, clean(b.style, 60)].filter(Boolean).join(' · ');
  return [name, when, target ? `타깃 ${target}` : ''].filter(Boolean).join(' · ');
}

/** How the evidence was collected and checked, from the pack's own statistics and queries. */
function methodLines(pack: MarketEvidencePack, s: MarketSynthesis, model: string): string[] {
  const stat = (key: string) => statNumber(pack.stats, key);
  const steps: string[] = [];
  const queries = stat('queries');
  if (queries !== undefined) steps.push(`미국 웹 검색 ${queries}회`);
  const results = stat('results');
  if (results !== undefined) steps.push(`결과 ${results}건`);
  const excluded = (
    [
      ['미국 외 출처', 'off_market_dropped'],
      ['소매처 상품 목록 페이지', 'listing_dropped'],
      ['다른 성별 대상', 'off_target_dropped'],
      ['주제와 무관', 'off_topic_dropped'],
    ] as const
  )
    .filter(([, key]) => (stat(key) ?? 0) > 0)
    .map(([label, key]) => `${label} ${stat(key)}건`);
  if (excluded.length) steps.push(`제외 ${excluded.join(', ')}`);
  const fetched = stat('fetch_ok');
  const attempted = stat('fetch_attempted');
  if (fetched !== undefined && attempted) steps.push(`본문 수집 ${fetched}/${attempted}건`);
  steps.push(`채택 근거 ${pack.evidence.length}건`);
  const lines = [`- 수집: ${steps.join(' → ')}`];
  const byYear = pack.stats?.evidence_by_year;
  if (isTrendPack(pack) && byYear && typeof byYear === 'object') {
    const parts = Object.entries(byYear as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'number')
      .map(([year, v]) => `${year}년 ${v}건`);
    if (parts.length) lines.push(`- 연도별 근거: ${parts.join(' · ')} (그해 판본이거나 그해를 다룬 글이라 겹칠 수 있음)`);
  }
  lines.push(
    `- 종합: 앱 LLM(${model})이 근거 안에서만 작성했고, 코드가 근거 번호와 금액·비율·수치를 인용한 원문과 대조했습니다.` +
      (s.irrelevant.length ? ` LLM이 주제와 무관하다고 본 근거 ${s.irrelevant.length}건은 인용하지 않았습니다.` : ''),
  );
  const searched = (pack.queries ?? []).map((q) => clean(q?.query, 120).replace(/`/g, "'")).filter(Boolean);
  if (searched.length) lines.push(`- 검색어: ${searched.map((q) => `\`${q}\``).join(' · ')}`);
  return lines;
}

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
    `> 미국 웹 근거 ${relevant.length}건(본문 ${bodyCount}·요약문 ${relevant.length - bodyCount})을 앱 LLM(${model})이 종합했습니다. ` +
      `근거 번호를 누르면 출처가 열리고, 원문과 맞지 않는 항목은 코드가 뺐습니다${s.dropped.length ? `(${s.dropped.length}건)` : ''}.`,
  ];
  const scope = headerScope(pack);
  if (scope) out.push('>', `> 조사 범위: ${scope} — 전체 조건과 조사 방법은 맨 아래 부록에 있습니다.`);

  let no = 0;
  const heading = (title: string) => out.push('', `## ${++no}. ${title}`, '');
  const bullets = (list: SynthesisFinding[]) => list.map((f) => `- ${f.text} ${cites(f.cites)}`);
  /** A labeled block inside a section; nothing when it has no lines. */
  const block = (label: string, lines: string[]) => {
    if (lines.length) out.push(`**${label}**`, '', ...lines, '');
  };

  // Conclusions first, then the figures they rest on.
  heading('핵심 요약');
  out.push(...(s.summary.length ? bullets(s.summary) : [EMPTY]));
  if (s.figures.length) {
    const rows = [...s.figures].sort(
      (a, b) => GEO_ORDER.indexOf(a.geo) - GEO_ORDER.indexOf(b.geo) || (a.year || '9999').localeCompare(b.year || '9999'),
    );
    out.push('', '| 지표 | 값 | 지역 | 기준 | 근거 |', '|---|---|---|---|---|');
    for (const f of rows) {
      const basis = [f.year, f.basis].filter(Boolean).join(' ') || '—';
      out.push(`| ${cell(f.metric || '-')} | ${cell(f.value)} | ${f.geo} | ${basis} | ${cites(f.cites)} |`);
    }
    const notes: string[] = [];
    if (rows.some((f) => f.cites.some((id) => s.sourceTypes[id] === 'research'))) {
      notes.push('리서치 기관 수치는 기관별 추정치이고 시장 정의가 서로 달라 직접 비교하지 않습니다.');
    }
    if (rows.some((f) => f.geo === '확인 필요')) notes.push('지역 「확인 필요」는 인용한 근거가 지역을 밝히지 않은 수치입니다.');
    if (notes.length) out.push('', `_${notes.join(' ')}_`);
  }

  const timelineSection = () => {
    heading('연도별 추이');
    const years = packYears(pack);
    for (const year of years.length ? years : [...new Set(s.timeline.map((t) => t.year))]) {
      const items = s.timeline.filter((t) => t.year === year);
      out.push(`### ${year}년`, '', ...(items.length ? bullets(items) : ['_이 해에 게시됐거나 이 해를 다룬 근거가 없습니다._']), '');
    }
  };
  const marketSection = () => {
    if (!s.drivers.length && !s.restraints.length && !s.market.length) return;
    heading('시장 동인·제약');
    block('성장 요인', bullets(s.drivers));
    block('제약 요인', bullets(s.restraints));
    block('시장 동향', bullets(s.market));
  };
  const competitorSection = () => {
    if (!s.competitors.length) return;
    heading('경쟁 제품·가격');
    const dist = priceDistribution(s.competitors.map((c) => c.price));
    if (dist && dist.n >= 3) {
      const bands = dist.bands.map(([label, n]) => `${label} ${n}개`).join(', ');
      out.push(
        `**가격대** 가격이 확인된 ${dist.n}개 제품 · 최저 ${usd(dist.min)} · 중앙값 ${usd(dist.median)} · 최고 ${usd(dist.max)} (${bands})`,
        '',
      );
    }
    out.push('| 브랜드 | 제품 | 가격 | 메모 | 근거 |', '|---|---|---|---|---|');
    for (const c of s.competitors) {
      out.push(`| ${cell(c.brand || '-')} | ${cell(c.product || '-')} | ${cell(c.price || '—')} | ${cell(c.text)} | ${cites(c.cites)} |`);
    }
    if (s.competitors.some((c) => !c.price)) out.push('', '_가격 칸의 —는 인용한 근거에 그 제품의 가격이 없다는 뜻입니다._');
  };
  const painSection = () => {
    if (!s.pains.length) return;
    heading('소비자 불만');
    out.push('| 불만 | 근거 수 | 내용 | 근거 |', '|---|---|---|---|');
    for (const p of s.pains) {
      const sites = new Set(p.cites.map((id) => byId.get(id)?.domain)).size;
      out.push(`| ${cell(p.pain || '-')} | ${p.cites.length}건 (${sites}개 사이트) | ${cell(p.text)} | ${cites(p.cites)} |`);
    }
    out.push('', '_근거 수는 이 불만을 언급한 근거 건수입니다. 표본이 작아 비율로 읽으면 안 됩니다._');
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

  if (s.gaps.length || s.actions.length) {
    heading('CQR 기회 가설·다음 단계');
    block('기회 가설', bullets(s.gaps));
    block('다음 단계', s.actions.map((f, i) => `${i + 1}. ${f.text} ${cites(f.cites)}`));
  }

  // Sections left out for lack of evidence are named here instead of printing a blank section.
  const sections: Array<[string, unknown[]]> = [
    ['핵심 수치', s.figures],
    ['소비자 불만', s.pains],
    ['경쟁 제품·가격', s.competitors],
    ['성장 요인', s.drivers],
    ['제약 요인', s.restraints],
    ['기회 가설', s.gaps],
    ['다음 단계', s.actions],
  ];
  const missing = sections.filter(([, list]) => !list.length).map(([label]) => label);
  const unknowns = [...s.unknowns, ...(missing.length ? [`근거를 찾지 못해 생략한 항목: ${missing.join(', ')}`] : [])];
  if (unknowns.length) {
    heading('확인 필요');
    out.push(...unknowns.map((u) => `- ${u}`));
  }

  // Appendix: how the evidence was gathered and checked, and every source.
  out.push('', '---', '', '## 부록 — 조사 방법·근거', '', '### 조사 범위·방법', '');
  const scopeFull = briefLine(pack);
  if (scopeFull) out.push(`- 조사 범위: ${scopeFull}`);
  out.push(...methodLines(pack, s, model));
  out.push(
    '',
    '**한계**',
    '',
    '- 공개 웹 자료만 썼습니다. 유료 보고서 본문, 소비자 설문, 판매 원자료는 없습니다.',
    '- 리서치 기관 공개 요약의 수치는 기관별 추정치이고 시장 정의가 서로 다릅니다.',
    ...(trend ? ['- 연도별 판매량·검색량 같은 수치 추이는 웹 기사 근거만으로 확정하지 않습니다.'] : []),
    '- 페르소나·세그먼트·시장 규모 추정·가격 전략은 웹 근거만으로 확정하지 않습니다.',
  );

  out.push('', '### 근거 목록', '');
  for (const e of relevant) {
    const dates = datesText(e);
    const published = (dates ? ` · ${dates}` : '') + (e.before_period ? ' · 조사 기간 이전 글' : '');
    const href = linkHref(e.url);
    const id = href ? `[${e.id}](<${href}>)` : e.id;
    const title = href ? `[${linkText(clean(e.title, 300))}](<${href}>)` : cell(e.title);
    const type = s.sourceTypes[e.id];
    const domain = type ? `${e.domain}(${SOURCE_TYPE_LABEL[type]})` : e.domain;
    out.push(`- **${id}** · ${KIND_LABEL[e.kind] ?? e.kind} · ${domain} · ${e.source === '본문' ? '본문' : '요약문'}${published} — ${title}`);
  }
  if (s.irrelevant.length) {
    out.push(
      '',
      `주제와 무관하다고 판단해 종합에서 뺀 근거 ${s.irrelevant.length}건: ` +
        s.irrelevant.map((id) => `${id}(${byId.get(id)?.domain ?? '?'})`).join(', '),
    );
  }
  if (s.dropped.length) {
    const counts = DROP_ORDER.map((reason) => [reason, s.dropped.filter((d) => d.reason === reason).length] as const)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${DROP_LABEL[reason]} ${n}건`);
    out.push(
      '',
      `### 검증에서 뺀 항목 ${s.dropped.length}건`,
      '',
      counts.join(' · '),
      '',
      ...s.dropped.map((d) => {
        const figures = d.figures?.length ? `: ${d.figures.join(', ')}` : '';
        return `- [${SECTION_LABEL[d.section] ?? d.section}] ${cell(d.text)} — ${DROP_LABEL[d.reason]}${figures}`;
      }),
    );
  }
  const footer = [
    args.sessionId ? `세션 \`${args.sessionId}\`` : '',
    args.packPath ? `발췌 원문이 담긴 근거 팩: \`${args.packPath}\`` : '',
  ].filter(Boolean);
  if (footer.length) out.push('', footer.join(' · '));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
