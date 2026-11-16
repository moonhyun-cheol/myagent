#!/usr/bin/env node
/**
 * Market-research pipeline wiring: output location, exit/stdout JSON parsing,
 * failure-kind messages, no stale-report reuse, and chat-fallback only when the
 * pipeline genuinely cannot run. Uses a fake process (no real Python).
 * Also: brief step (follow-up / clarify / inline fields), synthesis checks (citations,
 * figures that must appear in the cited evidence) and the mode handler with a fake LLM.
 */
import assert from 'node:assert/strict';
import path from 'node:path';

const mod = await import('../core/dist/skills/market-pipeline-runner.js');
const {
  runMarketPipeline,
  interpretMarketPipelineResult,
  parsePipelineResultJson,
  resolveMarketStateDir,
  marketFieldArgs,
} = mod;
const briefMod = await import('../core/dist/skills/market-research-brief.js');
const synthMod = await import('../core/dist/skills/market-research-synthesis.js');
const { handleMarketResearchMode } = await import('../core/dist/chat/modes/market-research.js');

const STATE_DIR = path.join('C:', 'Users', 'tester', 'AppData', 'Local', 'MYAgent', 'organization', 'market_research');
process.env.CQR_MARKET_STATE_DIR = STATE_DIR;

const FAKE_ORG_ROOT = path.join('C:', 'org', 'modules', 'organization');

function readyCapability(overrides = {}) {
  return {
    available: true,
    status: 'ready',
    message_ko: 'ok',
    org_root: FAKE_ORG_ROOT,
    script: null,
    pipeline_entry: path.join(FAKE_ORG_ROOT, 'pipelines', 'market_research.py'),
    pipeline_venv: path.join('C:', 'venv', 'python.exe'),
    python: path.join('C:', 'venv', 'python.exe'),
    ...overrides,
  };
}

const json = (obj) => `log line before\n${JSON.stringify(obj, null, 2)}\nMD=whatever`;

// --- parser: last market_research object from noisy multi-line stdout ---
{
  const parsed = parsePipelineResultJson(
    'starting...\n{\n  "noise": 1\n}\n' + json({ ok: false, pipeline: 'market_research', status: 'missing_deps', missing: ['chromadb'] }),
  );
  assert.equal(parsed.status, 'missing_deps');
  assert.equal(parsePipelineResultJson('no json here'), null);
}

// --- Case 1: missing_deps → visible failure, NOT fallback ---
{
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: '2027 FW slacks',
    capabilityOverride: readyCapability(),
    spawnOverride: () => ({
      status: 1,
      stdout: json({ ok: false, pipeline: 'market_research', phase: 'research', status: 'missing_deps', missing: ['langgraph', 'chromadb'] }),
      stderr: '',
    }),
    readReportOverride: () => null,
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, false, 'case1 not ok');
  assert.equal(r.status, 'missing_deps');
  assert.equal(r.used_fallback_chat, false, 'case1 must not fall back to chat');
  assert.match(r.error, /키트/);
  assert.match(r.error, /langgraph, chromadb/);
}

// --- Case 2: missing_api_key → key guidance ---
{
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'feasibility',
    brief: 'brief',
    capabilityOverride: readyCapability(),
    spawnOverride: () => ({
      status: 1,
      stdout: json({ ok: false, pipeline: 'market_research', phase: 'feasibility', status: 'missing_api_key', provider: 'openai', missing: ['OPENAI_API_KEY'] }),
      stderr: '',
    }),
    readReportOverride: () => null,
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'missing_api_key');
  assert.equal(r.used_fallback_chat, false);
  assert.match(r.error, /OPENAI_API_KEY/);
  assert.match(r.error, /LLM 연결/);
}

// --- Case 3: entry claims ok but only a STALE report exists → not returned as new ---
{
  const r = interpretMarketPipelineResult({
    phase: 'research',
    capability: readyCapability(),
    outputDir: path.join(STATE_DIR, 'output', 'sess-abc'),
    proc: { status: 0, stdout: json({ ok: true, pipeline: 'market_research', phase: 'research', session_id: 'sess' }), stderr: '' },
    report: { markdown: '# OLD REPORT', mtimeMs: 500_000 }, // older than start
    startedAtMs: 1_000_000,
  });
  assert.equal(r.ok, false, 'stale report must not count as success');
  assert.equal(r.status, 'pipeline_failed');
  assert.equal(r.markdown, undefined, 'must not return the old markdown');
}

// --- Case 4: successful run → report under state dir (outside module), ok:true ---
{
  let capturedDir = null;
  let capturedFields = null;
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: '2027 FW slacks Amazon US',
    fields: { product: '슬랙스', product_en: 'dress slacks' },
    sessionId: 'sess42',
    capabilityOverride: readyCapability(),
    spawnOverride: (ctx) => {
      capturedDir = ctx.outputDir;
      capturedFields = ctx.fields;
      return {
        status: 0,
        stdout: json({ ok: true, pipeline: 'market_research', phase: 'research', report_kind: 'evidence_pack', session_id: 'sess42', markdown_path: path.join(ctx.outputDir, 'research_report.md') }),
        stderr: '',
      };
    },
    readReportOverride: () => ({ markdown: '# Market Research\nfresh', mtimeMs: 2_000_000 }),
    readPackOverride: () => ({ evidence: [{ id: 'E1', kind: 'review', title: 't', url: 'https://a.example', domain: 'a.example', source: '본문', excerpt: 'x' }] }),
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, true, 'case4 ok');
  assert.equal(r.status, 'ok');
  assert.equal(r.report_kind, 'evidence_pack');
  assert.equal(r.evidence_pack.evidence.length, 1, 'evidence pack of this run is attached');
  assert.deepEqual(capturedFields, { product: '슬랙스', product_en: 'dress slacks' }, 'fields reach the spawn');
  assert.match(r.markdown, /Market Research/);
  assert.ok(r.output_dir.startsWith(STATE_DIR), 'output under state dir');
  assert.ok(r.output_dir.includes(`${path.sep}output${path.sep}`), 'under output/');
  assert.ok(!r.output_dir.includes(`modules${path.sep}organization`), 'NOT inside the module folder');
  assert.equal(capturedDir, r.output_dir, 'spawn got the same dir passed via --output-dir');
  assert.ok(resolveMarketStateDir().startsWith(STATE_DIR.slice(0, 3)));
}

// --- Case 5: no org module → fall back to chat, with a reason line ---
{
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: 'anything',
    capabilityOverride: {
      available: false,
      status: 'no_org_module',
      message_ko: '조직 모듈이 설치되지 않았습니다. 모듈 업데이트 후 다시 시도하세요.',
      org_root: null,
      script: null,
      pipeline_entry: null,
      pipeline_venv: null,
      python: null,
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'no_org_module');
  assert.equal(r.used_fallback_chat, true, 'genuine no-module falls back to chat');
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'fallback carries a reason line');
}

// --- Extra: no python at all → visible guidance, not fallback ---
{
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: 'anything',
    capabilityOverride: readyCapability({ status: 'no_python', python: null, pipeline_venv: null }),
  });
  assert.equal(r.status, 'no_python');
  assert.equal(r.used_fallback_chat, false);
  assert.match(r.error, /venv|pipeline-venv/);
}

// --- Entry statuses of the evidence-pack pipeline keep their own guidance ---
for (const status of ['needs_brief', 'insufficient_evidence', 'unavailable']) {
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: status === 'unavailable' ? 'feasibility' : 'research',
    brief: 'brief',
    capabilityOverride: readyCapability(),
    spawnOverride: () => ({ status: 1, stdout: json({ ok: false, pipeline: 'market_research', status, error: `guidance for ${status}` }), stderr: '' }),
    readReportOverride: () => null,
  });
  assert.equal(r.status, status, `${status} is not reported as a generic error`);
  assert.equal(r.error, `guidance for ${status}`);
  assert.equal(r.used_fallback_chat, false);
}

// --- Field flags: `=` form, only set fields, values starting with $ kept ---
assert.deepEqual(marketFieldArgs({ product: '슬랙스', price_band: '$40-90', focus: '  ' }), [
  '--product=슬랙스',
  '--price-band=$40-90',
]);
assert.deepEqual(marketFieldArgs({ period: '2024-2026', product_en: 'bomber jacket', study: 'trend' }), [
  '--product-en=bomber jacket',
  '--study=trend',
  '--period=2024-2026',
]);

// --- A module older than the trend study rejects --study/--period: retried without them ---
{
  const seen = [];
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: '최근 3년간의 봄버재킷 시장 및 트렌드, 추이 분석',
    fields: { product: '봄버재킷', product_en: 'bomber jacket', study: 'trend', period: '2024-2026' },
    capabilityOverride: readyCapability(),
    spawnOverride: (ctx) => {
      seen.push(marketFieldArgs(ctx.fields));
      return seen.length === 1
        ? { status: 2, stdout: '', stderr: 'usage: market_research.py [-h] ...\nmarket_research.py: error: unrecognized arguments: --study=trend --period=2024-2026' }
        : { status: 0, stdout: json({ ok: true, pipeline: 'market_research', phase: 'research', session_id: 's' }), stderr: '' };
    },
    readReportOverride: () => ({ markdown: '# pack', mtimeMs: 2_000_000 }),
    readPackOverride: () => null,
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, true, 'older module still runs its product study');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ['--product=봄버재킷', '--product-en=bomber jacket']);
  // Any other failure is not retried.
  const once = [];
  await runMarketPipeline({
    cqrRoot: 'C:/app', phase: 'research', brief: 'x', fields: { product: 'a', product_en: 'a', study: 'trend' },
    capabilityOverride: readyCapability(),
    spawnOverride: () => { once.push(1); return { status: 1, stdout: '', stderr: 'Traceback: boom' }; },
    readReportOverride: () => null,
  });
  assert.equal(once.length, 1, 'only the unknown-flag error is retried');
}

// --- Brief step ---
{
  const { parseBriefDecision, inlineBriefFields } = briefMod;
  const base = { explicit: false, hasPreviousReport: true, brief: '' };
  assert.equal(parseBriefDecision('{"action":"followup"}', base).action, 'followup');
  // No earlier report in this chat: a "follow-up" without a product is a question back.
  assert.equal(parseBriefDecision('{"action":"followup"}', { ...base, hasPreviousReport: false }).action, 'clarify');
  // An explicit /심층리서치 with a product is always a new study.
  const explicit = parseBriefDecision('{"action":"followup","product":"슬랙스","product_en":"dress slacks"}', { ...base, explicit: true });
  assert.equal(explicit.action, 'research');
  assert.deepEqual(explicit.fields, { product: '슬랙스', product_en: 'dress slacks' });
  // Korean is not a US search name; inline `키: 값` from the user is never overwritten.
  const inline = parseBriefDecision(
    '```json\n{"action":"research","product":"스키바지","product_en":"스키 팬츠","category":"outdoor apparel","competitors":["Burton","Patagonia"],"price_band":"$50-60"}\n```',
    { ...base, brief: '품목: 스키바지 / 가격대: $90-280' },
  );
  assert.deepEqual(inline.fields, { category: 'outdoor apparel', competitors: 'Burton, Patagonia' });
  assert.deepEqual([...inlineBriefFields('품목: 스키바지 / 영문명: ski pants / 가격대: $90')].sort(), ['price_band', 'product', 'product_en']);
  assert.equal(parseBriefDecision('not json', base), null);
  // Trend study: study and period are normalized; anything else is dropped (the pipeline reads the sentence).
  const trend = parseBriefDecision(
    '{"action":"research","product":"봄버재킷","product_en":"bomber jacket","category":"men\'s outerwear","study":"Trend","period":"2026 ~ 2024"}',
    { ...base, hasPreviousReport: false },
  );
  assert.equal(trend.action, 'research');
  assert.deepEqual(trend.fields, { product: '봄버재킷', product_en: 'bomber jacket', category: "men's outerwear", study: 'trend', period: '2024-2026' });
  const loose = parseBriefDecision('{"action":"research","product":"봄버재킷","product_en":"bomber jacket","study":"history","period":"최근 3년"}', base);
  assert.deepEqual(loose.fields, { product: '봄버재킷', product_en: 'bomber jacket' });
  assert.deepEqual([...inlineBriefFields('기간: 2024-2026 / 조사유형: trend')].sort(), ['period', 'study']);
  const prompt = briefMod.buildBriefPrompt({ message: 'm', brief: 'm', explicit: false, hasPreviousReport: false, recent: [], today: '2026-11-16' });
  assert.match(prompt.system, /Today is 2026-11-16\./);
  assert.match(prompt.system, /"최근 3년" is\s+"2024-2026", "작년" is "2025"/);
}

// --- Synthesis checks ---
const PACK = {
  market: 'US',
  brief: { product: '카고바지', product_en: 'tactical cargo pants' },
  evidence: [
    { id: 'E1', kind: 'review', title: 'Cargo pants ripped', url: 'https://r.example/1', domain: 'r.example', source: '본문', excerpt: 'The seams ripped after a month.', detail: 'The seams ripped after a month. 30% of owners mention the seams.' },
    { id: 'E2', kind: 'review', title: 'Slack reviews', url: 'https://slack.example/r', domain: 'slack.example', source: '요약문', excerpt: 'Slack takes my money.' },
    { id: 'E3', kind: 'competitor', title: '5.11 Peak Cargo Pant', url: 'https://511.example/p', domain: '511.example', source: '본문', excerpt: 'Peak cargo pant', page_prices: ['$89.49'], detail: '[가격 표기 줄] 5.11 Peak Cargo Pant $89.49' },
    { id: 'E4', kind: 'market', title: 'Cargo pants market', url: 'https://m.example/a', domain: 'm.example', source: '본문', excerpt: 'The market will reach $17.9 billion by 2030.' },
  ],
};
{
  const { parseSynthesis, moneyKeys, renderSynthesisMarkdown, synthesisFindingCount } = synthMod;
  assert.deepEqual(moneyKeys('$1,299 and $89.50, $17.9 billion, $2.5M'), ['1299', '89.5', '17.9b', '2.5m']);
  const raw = JSON.stringify({
    irrelevant: ['E2', 'E99'],
    summary: [{ text: '솔기 내구성 불만이 반복됩니다.', cites: ['E1'] }],
    pains: [
      { pain: '솔기 터짐', text: '한 달 만에 솔기가 터짐. 소유자 30%가 언급', cites: ['E1'] },
      { pain: '앱 요금', text: '요금이 계속 청구됨', cites: ['E2'] },
      { pain: '무릎 해짐', text: '무릎이 해짐', cites: ['E7'] },
    ],
    competitors: [
      { brand: '5.11', product: 'Peak Cargo Pant', price: '$89.49', text: '대표 제품', cites: ['[E3]'] },
      { brand: 'TRUEWERK', product: 'T1', price: '$65', text: '기억에서 나온 가격', cites: ['E3'] },
    ],
    market: [{ text: '2030년 $17.9 billion 전망', cites: ['E4'] }, { text: '연 12% 성장', cites: ['E4'] }],
    gaps: [],
    unknowns: ['Amazon 리뷰 본문 미확인'],
  });
  const s = parseSynthesis(raw, PACK);
  assert.deepEqual(s.irrelevant, ['E2'], 'only ids that exist are marked off-topic');
  assert.deepEqual(s.pains.map((p) => p.pain), ['솔기 터짐'], 'off-topic and unknown citations are dropped');
  assert.deepEqual(s.competitors.map((c) => c.brand), ['5.11'], 'a price not in the cited item is dropped');
  assert.deepEqual(s.market.map((m) => m.text), ['2030년 $17.9 billion 전망'], 'a percentage not in the cited item is dropped');
  assert.equal(s.dropped.length, 4);
  assert.equal(synthesisFindingCount(s), 4);
  const md = renderSynthesisMarkdown({ pack: PACK, synthesis: s, model: 'test-model', packPath: 'C:/out/research_report.md' });
  assert.match(md, /^# 미국 시장조사 — 카고바지\n\n> 미국 웹 근거 3건\(본문 3·요약문 0\)을 앱 LLM\(test-model\)이 종합했습니다\./);
  assert.ok(md.includes('>\n> 조사 범위: 카고바지(tactical cargo pants) — '), 'a short scope line under the header');
  // A product study starts from buyers' complaints; sections without evidence are left out.
  assert.deepEqual(
    [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    ['1. 핵심 요약', '2. 소비자 불만', '3. 경쟁 제품·가격', '4. 시장 동인·제약', '5. 확인 필요', '부록 — 조사 방법·근거'],
  );
  assert.ok(md.includes('**시장 동향**\n\n- 2030년 $17.9 billion 전망 [\\[E4\\]](<https://m.example/a>)'));
  assert.ok(md.includes('- Amazon 리뷰 본문 미확인\n- 근거를 찾지 못해 생략한 항목: 핵심 수치, 성장 요인, 제약 요인, 기회 가설, 다음 단계'));
  assert.ok(!md.includes('_근거 부족'), 'no blank section is printed');
  assert.ok(md.includes('\n\n---\n\n## 부록 — 조사 방법·근거\n\n### 조사 범위·방법\n\n- 조사 범위: 품목: 카고바지 / 검색 영문명: tactical cargo pants'));
  assert.ok(md.includes('### 검증에서 뺀 항목 4건\n\n유효한 근거 번호 없음 2건 · 인용한 근거에 없는 금액·비율 2건'));
  assert.ok(md.endsWith('발췌 원문이 담긴 근거 팩: `C:/out/research_report.md`'));
  assert.ok(!/\n{3,}/.test(md), 'no runs of blank lines');
  assert.match(md, /\| 솔기 터짐 \| 1건 \(1개 사이트\)/);
  assert.ok(md.includes('| [\\[E1\\]](<https://r.example/1>) |'), 'a table citation links to its source page');
  assert.ok(md.includes('- **[E1](<https://r.example/1>)** · 리뷰·불만 · r.example · 본문 — [Cargo pants ripped](<https://r.example/1>)'));
  assert.match(md, /주제와 무관하다고 판단해 종합에서 뺀 근거 1건: E2\(slack\.example\)/);
  assert.ok(!md.includes('https://slack.example/r'), 'off-topic evidence is not listed as a source');
  assert.equal(parseSynthesis('no json', PACK), null);
  // A price band ("$80대") is supported by a cited amount inside it; a band with no amount inside is not.
  const band = parseSynthesis(
    JSON.stringify({
      competitors: [
        { brand: '5.11', product: 'Peak', price: '$89.49', text: '$80대 중가 포지션', cites: ['E3'] },
        { brand: '5.11', product: 'Peak', price: '$89.49', text: '$89대 리스팅', cites: ['E3'] },
        { brand: '5.11', product: 'Peak', price: '$89.49', text: '$30대 저가', cites: ['E3'] },
      ],
    }),
    PACK,
  );
  assert.deepEqual(band.competitors.map((c) => c.text), ['$80대 중가 포지션', '$89대 리스팅']);
  assert.deepEqual(band.dropped.map((d) => d.figures), [['$30']]);
  // Items found without the target gender or without a date are flagged to the model and in the appendix.
  const flagged = { ...PACK, evidence: PACK.evidence.map((e) => (e.id === 'E4' ? { ...e, all_genders: true, undated: true } : e)) };
  const flaggedPrompt = synthMod.buildSynthesisPrompt(flagged).user;
  assert.ok(flaggedPrompt.includes('성별 구분 없는 검색 결과(전 성별 시장)'));
  assert.ok(flaggedPrompt.includes('게시일 확인 불가: 연도별 추이의 근거로 쓰지 말고'));
  const flaggedMd = renderSynthesisMarkdown({ pack: flagged, synthesis: s, model: 'm' });
  assert.ok(flaggedMd.includes(' · 게시일 확인 불가 · 성별 구분 없는 검색 결과'));
  assert.deepEqual(s.timeline, [], 'a product study has no timeline');
  assert.ok(!synthMod.buildSynthesisPrompt(PACK).system.includes('timeline'));
}

// --- Trend study: timeline findings may only cite items of their year ---
{
  const { parseSynthesis, renderSynthesisMarkdown, buildSynthesisPrompt } = synthMod;
  const TREND_PACK = {
    market: 'US',
    brief: { product: '봄버재킷', product_en: 'bomber jacket', study: 'trend', period: '2024-2026' },
    stats: { years: [2024, 2025, 2026] },
    evidence: [
      { id: 'E1', kind: 'market', title: 'Bomber jackets are back', url: 'https://a.example/1', domain: 'a.example', source: '본문', excerpt: 'Oversized bombers led the fall collections.', published: '2024-09-10' },
      { id: 'E2', kind: 'market', title: 'Bomber jacket trend 2025', url: 'https://b.example/2', domain: 'b.example', source: '요약문', excerpt: 'Suede bombers are the pick of the year.' },
      { id: 'E3', kind: 'market', title: 'Bomber jacket market', url: 'https://c.example/3', domain: 'c.example', source: '본문', excerpt: 'Sales grew 4% a year.', published: '2026-02-01' },
    ],
  };
  const prompt = buildSynthesisPrompt(TREND_PACK);
  assert.match(prompt.system, /"timeline"/);
  assert.match(prompt.system, /2024, 2025, 2026/);
  assert.match(prompt.user, /게시일: 2024-09-10/);
  const s = parseSynthesis(
    JSON.stringify({
      summary: [{ text: '오버사이즈에서 스웨이드로 이동', cites: ['E1', 'E2'] }],
      timeline: [
        { year: '2025', text: '스웨이드 봄버', cites: ['E2', 'E1'] },
        { year: '2024', text: '오버사이즈 봄버 주도', cites: ['E1'] },
        { year: '2026', text: '오버사이즈 지속', cites: ['E1'] },
        { year: '2023년', text: '예전 이야기', cites: ['E1'] },
        { year: '2026', text: '판매 연 4% 성장', cites: ['E3'] },
      ],
      market: [],
      pains: [],
      competitors: [],
      gaps: [],
      unknowns: [],
    }),
    TREND_PACK,
  );
  assert.deepEqual(
    s.timeline.map((t) => [t.year, t.cites.join(',')]),
    [['2024', 'E1'], ['2025', 'E2'], ['2026', 'E3']],
    'cites of another year are removed; findings left without one are dropped',
  );
  assert.equal(s.dropped.filter((d) => d.reason === 'year_not_in_evidence').length, 2);
  const md = renderSynthesisMarkdown({ pack: TREND_PACK, synthesis: s, model: 'm' });
  assert.match(md, /^# 미국 시장·트렌드 추이 — 봄버재킷 \(2024-2026\)/);
  assert.ok(md.includes('## 2. 연도별 추이\n\n### 2024년\n\n- 오버사이즈 봄버 주도 [\\[E1\\]](<https://a.example/1>)'));
  assert.match(md, /a\.example · 본문 · 게시일 2024-09-10/);
  assert.match(md, /그해를 다룬 근거 없음 2건/);
  assert.match(md, /조사 유형: 시장·트렌드 추이 \/ 기간: 2024-2026/);
}

// --- Citation links, and price lines that a long page body must not push out of the prompt ---
{
  const { parseSynthesis, renderSynthesisMarkdown, buildSynthesisPrompt, linkHref, splitDetail } = synthMod;
  const LINK_PACK = {
    market: 'US',
    brief: { product: '봄버재킷', product_en: 'bomber jacket' },
    evidence: [
      {
        id: 'E1', kind: 'competitor', title: 'Best [2026] bomber_jackets | ranked', url: 'https://x.example/a(b)|c',
        domain: 'x.example', source: '본문', excerpt: 'Carhartt bomber',
        detail: `${'Long page text. '.repeat(150)}\n[가격 표기 줄] Carhartt Rugged Flex Bomber Jacket $125 Amazon | Calvin Klein Bomber $80`,
      },
      { id: 'E2', kind: 'market', title: 'Unsafe', url: 'javascript:alert(1)', domain: 'y.example', source: '요약문', excerpt: 'Bombers are back.' },
    ],
  };
  const prompt = buildSynthesisPrompt(LINK_PACK);
  assert.ok(
    prompt.user.includes('가격 표기 줄(페이지의 제품명과 가격): Carhartt Rugged Flex Bomber Jacket $125 Amazon | Calvin Klein Bomber $80'),
    'price lines reach the model even when the page body is cut',
  );
  assert.ok(!prompt.user.includes('[가격 표기 줄]'), 'the page body is cut before the price-line mark');
  assert.deepEqual(splitDetail('[가격 표기 줄] A $1'), { body: '', priceLines: ' A $1', figureLines: '' });
  assert.deepEqual(splitDetail('Body\n[가격 표기 줄] A $1\n[시장 수치 줄] USD 41.07 Billion'), {
    body: 'Body\n',
    priceLines: ' A $1\n',
    figureLines: ' USD 41.07 Billion',
  });
  assert.equal(linkHref('javascript:alert(1)'), '');
  assert.equal(linkHref('https://x.example/a(b)|c d'), 'https://x.example/a(b)%7Cc%20d');
  const s = parseSynthesis(
    JSON.stringify({
      summary: [{ text: '봄버 복귀', cites: ['E1', 'E2'] }],
      competitors: [{ brand: 'Carhartt', product: 'Rugged Flex Bomber', price: '$125', text: '워크웨어', cites: ['E1'] }],
      pains: [], market: [], gaps: [], unknowns: [],
    }),
    LINK_PACK,
  );
  assert.equal(s.competitors[0]?.price, '$125');
  const md = renderSynthesisMarkdown({ pack: LINK_PACK, synthesis: s, model: 'm' });
  assert.ok(md.includes('- 봄버 복귀 [\\[E1\\]](<https://x.example/a(b)%7Cc>)[E2]'), 'a citation links to its page; a non-http URL stays plain');
  assert.ok(md.includes('| $125 | 워크웨어 | [\\[E1\\]](<https://x.example/a(b)%7Cc>) |'));
  assert.ok(md.includes('- **[E1](<https://x.example/a(b)%7Cc>)** · 경쟁사·가격 · x.example · 본문 — [Best \\[2026\\] bomber\\_jackets | ranked](<https://x.example/a(b)%7Cc>)'));
  assert.ok(md.includes('- **E2** · 시장·트렌드 · y.example · 요약문 — Unsafe'));
  assert.ok(!md.includes('javascript:'));
}

// --- Target customer, update dates, market figures, dropped findings listed ---
{
  const { parseSynthesis, renderSynthesisMarkdown, buildSynthesisPrompt, moneyKeys, itemAboutYear } = synthMod;
  assert.deepEqual(moneyKeys('USD 41.07 Billion, US$2.5 bn, $45.40 billion'), ['41.07b', '2.5b', '45.4b']);
  const updatedItem = { id: 'E1', kind: 'competitor', title: 'Best bombers', url: 'https://e.example/a', domain: 'e.example', source: '본문', excerpt: 'x', published: '2016-08-25', updated: '2026-01-20' };
  assert.ok(itemAboutYear(updatedItem, '2026') && !itemAboutYear(updatedItem, '2016'), 'the version read is from the update year');
  const PACK2 = {
    market: 'US',
    brief: { product: '봄버재킷', product_en: 'bomber jacket', study: 'trend', period: '2024-2026', gender: 'men', style: 'military, workwear' },
    stats: { years: [2024, 2025, 2026] },
    evidence: [
      updatedItem,
      { id: 'E2', kind: 'review', title: 'B-3 reviews', url: 'https://p.example/r', domain: 'p.example', source: '본문', excerpt: 'Pricey but worth it.', published: '2010-12-08', before_period: true },
      { id: 'E3', kind: 'market', title: 'US outerwear market', url: 'https://m.example/us', domain: 'm.example', source: '본문', excerpt: 'Outerwear jackets', detail: 'Outerwear jackets segment.\n[시장 수치 줄] Base year 2024 USD 41.07 Billion | Forecast CAGR 3.37%', published: '2025-10-30', updated: '2026-04-21' },
    ],
  };
  const prompt = buildSynthesisPrompt(PACK2);
  assert.match(prompt.user, /타깃 성별: 남성 \/ 타깃 스타일: military, workwear/);
  assert.match(prompt.user, /게시일: 2016-08-25\n수정일: 2026-01-20/);
  assert.match(prompt.user, /조사 기간 이전 글/);
  assert.match(prompt.user, /시장 수치 줄\(페이지가 적은 시장 규모·성장률\): Base year 2024 USD 41.07 Billion \| Forecast CAGR 3.37%/);
  assert.match(prompt.system, /forecast/);
  const s = parseSynthesis(
    JSON.stringify({
      summary: [],
      market: [
        { text: '미국 아우터 시장 2024년 $41.07 billion, CAGR 3.37% 전망', cites: ['E3'] },
        { text: '미국 아우터 시장 $60 billion', cites: ['E3'] },
      ],
      competitors: [{ brand: 'Alpha', product: 'MA-1', price: '$200', text: '클래식', cites: ['E1'] }],
      timeline: [{ year: '2026', text: '봄버 재부상', cites: ['E1'] }, { year: '2024', text: '가격 불만', cites: ['E2'] }],
      pains: [], gaps: [], unknowns: [],
    }),
    PACK2,
  );
  assert.deepEqual(s.market.map((m) => m.cites.join()), ['E3'], 'USD … Billion in the item supports $… billion');
  assert.deepEqual(s.timeline.map((t) => t.year), ['2026'], 'an updated page counts for its update year; an older page for none');
  const md = renderSynthesisMarkdown({ pack: PACK2, synthesis: s, model: 'm' });
  assert.ok(md.includes('e.example · 본문 · 게시일 2016-08-25 · 수정일 2026-01-20 — '));
  assert.ok(md.includes('p.example · 본문 · 게시일 2010-12-08 · 조사 기간 이전 글 — '));
  assert.ok(md.includes('- [시장 동향] 미국 아우터 시장 $60 billion — 인용한 근거에 없는 금액·비율: $60 billion'));
  assert.ok(md.includes('- [경쟁 제품·가격] '), 'each dropped finding is listed with its section');
  assert.ok(md.includes('- [연도별 추이] 가격 불만 · 2024 — 그해를 다룬 근거 없음'));
}

// --- Report layout: key figures, study-type order, price band, next steps, appendix ---
{
  const { parseSynthesis, renderSynthesisMarkdown, buildSynthesisPrompt } = synthMod;
  const LAYOUT_PACK = {
    market: 'US',
    brief: { product: '봄버재킷', product_en: 'bomber jacket', study: 'trend', period: '2024-2026', gender: 'men', style: 'military, workwear' },
    queries: [{ query: "men's bomber jacket trend 2025", kind: 'market' }, { query: 'US outerwear market size', kind: 'market' }],
    stats: {
      years: [2024, 2025, 2026], queries: 2, results: 20, off_market_dropped: 1, listing_dropped: 0, off_target_dropped: 2,
      off_topic_dropped: 3, fetch_attempted: 4, fetch_ok: 3, evidence_by_year: { 2024: 1, 2025: 1, 2026: 2 },
    },
    evidence: [
      { id: 'E1', kind: 'market', title: 'US outerwear market', url: 'https://m.example/us', domain: 'm.example', source: '본문', excerpt: 'United States outerwear market', detail: 'The U.S. outerwear market.\n[시장 수치 줄] USD 41.07 Billion in 2024 | USD 54.91 Billion by 2033 | CAGR 3.37%', published: '2025-10-30' },
      { id: 'E2', kind: 'market', title: 'Bomber jacket sales', url: 'https://d.example/b', domain: 'd.example', source: '본문', excerpt: 'Amazon bomber jacket sales peaked at 20,500 units in October 2025.', published: '2026-08-25' },
      { id: 'E3', kind: 'competitor', title: 'Best bomber jackets 2026', url: 'https://g.example/best', domain: 'g.example', source: '본문', excerpt: 'Picks', detail: '[가격 표기 줄] Calvin Klein Bomber $80 | Carhartt Relaxed Fit Bomber $125 | Alpha Industries MA-1 $200', updated: '2026-01-20' },
      { id: 'E4', kind: 'review', title: 'MA-1 too slim', url: 'https://r.example/ma1', domain: 'r.example', source: '요약문', excerpt: 'The MA-1 runs slim; hard to layer over a sweater.', published: '2024-11-02' },
    ],
  };
  const prompt = buildSynthesisPrompt(LAYOUT_PACK);
  assert.match(prompt.system, /Leave\s+the numbers to figures/);
  assert.match(prompt.system, /seasonality/);
  const s = parseSynthesis(
    JSON.stringify({
      summary: [{ text: '봄버는 2024~2026년 내내 스테디 아우터', cites: ['E2', 'E3'] }],
      figures: [
        { metric: 'Amazon US 봄버재킷 월 판매량(최고)', value: '20,500개', year: '2025', geo: 'Amazon US', basis: '추정', cites: ['E2'] },
        { metric: '미국 아우터 시장 매출', value: 'USD 54.91 Billion', year: '2033', geo: '미국', basis: '추정', cites: ['E1'] },
        { metric: '미국 아우터 시장 매출', value: 'USD 41.07 Billion', year: '2024', geo: 'United States', basis: '추정', cites: ['E1'] },
        { metric: '봄버 시장', value: 'USD 99 Billion', year: '2030', geo: '글로벌', basis: '전망', cites: ['E1'] },
        { metric: 'MA-1 핏', value: '슬림', geo: '', cites: ['E4'] },
      ],
      timeline: [{ year: '2026', text: '봄버 재부상', cites: ['E3'] }],
      drivers: [{ text: '가을·겨울 수요', cites: ['E2'] }],
      restraints: [],
      market: [],
      competitors: [
        { brand: 'Calvin Klein', product: 'Bomber', price: '$80', text: '저가', cites: ['E3'] },
        { brand: 'Carhartt', product: 'Relaxed Fit Bomber', price: '$125', text: '워크웨어', cites: ['E3'] },
        { brand: 'Alpha Industries', product: 'MA-1', price: '$200', text: '클래식', cites: ['E3'] },
        { brand: 'Schott', product: 'B-3', price: '', text: '가죽', cites: ['E3'] },
      ],
      pains: [{ pain: '슬림핏', text: '레이어링이 어려움', cites: ['E4'] }],
      gaps: [{ text: '레이어링되는 MA-1형', cites: ['E4'] }],
      actions: [{ text: 'Carhartt Relaxed Fit 봄버와 핏 비교', cites: ['E3'] }],
      sources: { E1: 'research', E2: 'data', E3: 'media', E4: 'community', E9: 'media' },
      unknowns: ['미국 봄버재킷 단일 시장 규모'],
    }),
    LAYOUT_PACK,
  );
  assert.equal(s.figures.length, 3, 'a value not in the cited item, or without a number, is not a figure');
  const md = renderSynthesisMarkdown({ pack: LAYOUT_PACK, synthesis: s, model: 'm', sessionId: 'sess9' });
  assert.ok(md.startsWith('# 미국 시장·트렌드 추이 — 봄버재킷 (2024-2026)\n\n> 미국 웹 근거 4건(본문 3·요약문 1)을 앱 LLM(m)이 종합했습니다. '));
  assert.ok(md.includes('코드가 뺐습니다(1건).\n>\n> 조사 범위: 봄버재킷(bomber jacket) · 2024-2026 · 타깃 남성 · military, workwear — '));
  assert.deepEqual(
    [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    [
      '1. 핵심 요약', '2. 연도별 추이', '3. 시장 동인·제약', '4. 경쟁 제품·가격', '5. 소비자 불만',
      '6. CQR 기회 가설·다음 단계', '7. 확인 필요', '부록 — 조사 방법·근거',
    ],
    'a trend study reads the market first',
  );
  assert.ok(
    md.includes(
      '| 지표 | 값 | 지역 | 기준 | 근거 |\n|---|---|---|---|---|\n' +
        '| 미국 아우터 시장 매출 | USD 41.07 Billion | 미국 | 2024 추정 | [\\[E1\\]](<https://m.example/us>) |\n' +
        '| 미국 아우터 시장 매출 | USD 54.91 Billion | 미국 | 2033 전망 | [\\[E1\\]](<https://m.example/us>) |\n' +
        '| Amazon US 봄버재킷 월 판매량(최고) | 20,500개 | Amazon US | 2025 추정 | [\\[E2\\]](<https://d.example/b>) |',
    ),
    'US figures first, oldest year first; a future year is a forecast',
  );
  assert.ok(md.indexOf('| 지표 |') < md.indexOf('## 2. 연도별 추이'), 'the figures table sits under the summary');
  assert.match(md, /_리서치 기관 수치는 기관별 추정치/);
  assert.ok(md.includes('### 2025년\n\n_이 해에 게시됐거나 이 해를 다룬 근거가 없습니다._'));
  assert.ok(md.includes('## 3. 시장 동인·제약\n\n**성장 요인**\n\n- 가을·겨울 수요 [\\[E2\\]](<https://d.example/b>)\n\n## 4.'), 'an empty block is left out');
  assert.ok(md.includes('## 4. 경쟁 제품·가격\n\n**가격대** 가격이 확인된 3개 제품 · 최저 $80 · 중앙값 $125 · 최고 $200 ($50–99 1개, $100–199 1개, $200–399 1개)\n\n| 브랜드 |'));
  assert.ok(md.includes('| Schott | B-3 | — | 가죽 |'));
  assert.match(md, /_가격 칸의 —는/);
  assert.ok(md.includes('**기회 가설**\n\n- 레이어링되는 MA-1형 [\\[E4\\]](<https://r.example/ma1>)\n\n**다음 단계**\n\n1. Carhartt Relaxed Fit 봄버와 핏 비교 [\\[E3\\]](<https://g.example/best>)'));
  assert.ok(md.includes('- 미국 봄버재킷 단일 시장 규모\n- 근거를 찾지 못해 생략한 항목: 제약 요인'));
  assert.ok(md.includes('- 수집: 미국 웹 검색 2회 → 결과 20건 → 제외 미국 외 출처 1건, 다른 성별 대상 2건, 주제와 무관 3건 → 본문 수집 3/4건 → 채택 근거 4건'));
  assert.ok(md.includes('- 연도별 근거: 2024년 1건 · 2025년 1건 · 2026년 2건'));
  assert.ok(md.includes("- 검색어: `men's bomber jacket trend 2025` · `US outerwear market size`"));
  assert.match(md, /\*\*한계\*\*\n\n- 공개 웹 자료만/);
  assert.ok(md.includes('· 시장·트렌드 · m.example(리서치 기관 요약) · 본문 · 게시일 2025-10-30 — '), 'each source carries its type');
  assert.ok(md.includes('- [핵심 수치] 봄버 시장 · USD 99 Billion · 2030 · 글로벌 · 전망 — 인용한 근거에 없는 금액·비율: USD 99 Billion'));
  assert.ok(md.endsWith('세션 `sess9`'));
  assert.ok(md.indexOf('## 7. 확인 필요') < md.indexOf('\n---\n'), 'the appendix comes last');
  assert.ok(!md.includes('_근거 부족'));
}

// --- Brief step: target customer fields ---
{
  const { parseBriefDecision, inlineBriefFields } = briefMod;
  const base = { explicit: false, hasPreviousReport: false, brief: '' };
  const d = parseBriefDecision('{"action":"research","product":"봄버재킷","product_en":"bomber jacket","gender":"Men","style":"Military, Workwear"}', base);
  assert.deepEqual(d.fields, { product: '봄버재킷', product_en: 'bomber jacket', gender: 'men', style: 'military, workwear' });
  const bad = parseBriefDecision('{"action":"research","product":"봄버재킷","product_en":"bomber jacket","gender":"남성","style":"밀리터리"}', base);
  assert.deepEqual(bad.fields, { product: '봄버재킷', product_en: 'bomber jacket' }, 'non-normalized values are left to the pipeline');
  assert.deepEqual([...inlineBriefFields('성별: 남성 / 스타일: 밀리터리')].sort(), ['gender', 'style']);
  const prompt = briefMod.buildBriefPrompt({ message: 'm', brief: 'm', explicit: false, hasPreviousReport: false, recent: [], today: '2026-11-16' });
  assert.match(prompt.system, /"gender":"","style":""/);
  assert.match(prompt.system, /CQR's own customer/);
}

// --- An older module rejects --gender/--style: only those are dropped, the trend study stays ---
{
  const seen = [];
  const r = await runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: 'b',
    fields: { product: '봄버재킷', product_en: 'bomber jacket', study: 'trend', gender: 'men', style: 'military' },
    capabilityOverride: readyCapability(),
    spawnOverride: (ctx) => {
      seen.push(marketFieldArgs(ctx.fields));
      return seen.length === 1
        ? { status: 2, stdout: '', stderr: 'market_research.py: error: unrecognized arguments: --gender=men --style=military' }
        : { status: 0, stdout: json({ ok: true, pipeline: 'market_research', phase: 'research', session_id: 's' }), stderr: '' };
    },
    readReportOverride: () => ({ markdown: '# pack', mtimeMs: 2_000_000 }),
    readPackOverride: () => null,
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen[1], ['--product=봄버재킷', '--product-en=bomber jacket', '--study=trend']);
}

// --- Mode handler: follow-up, clarify, synthesis, fallback to the pack ---
{
  const store = (messages) => {
    const sessions = { s1: { messages: [...messages] } };
    return {
      load: (id) => sessions[id],
      append: (id, msg) => sessions[id].messages.push(msg),
      messages: () => sessions.s1.messages,
    };
  };
  const routing = { mode: 'org:market_research', confidence: 1, layer: 'slash' };
  const okRun = async (args) => ({
    ok: true,
    phase: 'research',
    status: 'ok',
    markdown: '# 시장조사 근거 팩 — 카고바지',
    session_id: 'abc',
    output_dir: path.join('C:', 'nonexistent-dir-for-test', 'abc'),
    evidence_pack: PACK,
    capability: readyCapability(),
    seenFields: args.fields,
  });
  const report = { role: 'assistant', mode: 'org:market_research', content: '# 미국 시장조사 — 카고바지\n' + 'x'.repeat(700) };

  // Follow-up on an earlier report → null (answered by the skill chat from history), no pipeline run.
  let ran = false;
  const followStore = store([report, { role: 'user', content: '리포트 형식으로 줘' }]);
  const follow = await handleMarketResearchMode({
    cqrRoot: 'C:/app', sessionStore: followStore, sessionId: 's1', message: '리포트 형식으로 줘', routing,
    llm: async () => ({ content: '{"action":"followup"}', model: 'm' }),
    runPipeline: async () => { ran = true; return okRun({}); },
  });
  assert.equal(follow, null);
  assert.equal(ran, false, 'a follow-up does not search again');

  // Research: brief fields reach the pipeline, synthesis is checked and rendered.
  const calls = [];
  let fieldsSeen = null;
  const researchStore = store([{ role: 'user', content: '/심층리서치 카고바지' }]);
  const statuses = [];
  const res = await handleMarketResearchMode({
    cqrRoot: 'C:/app', sessionStore: researchStore, sessionId: 's1', message: '/심층리서치 카고바지', routing,
    llm: async (system, user) => {
      calls.push(system.slice(0, 30));
      if (calls.length === 1) return { content: '{"action":"research","product":"카고바지","product_en":"tactical cargo pants"}', model: 'm' };
      return { content: JSON.stringify({ summary: [{ text: '솔기 불만', cites: ['E1'] }], pains: [], competitors: [], market: [], gaps: [], unknowns: [] }), model: 'gpt-test' };
    },
    runPipeline: async (args) => { fieldsSeen = args.fields; return okRun(args); },
    onStatus: (t) => statuses.push(t),
  });
  assert.deepEqual(fieldsSeen, { product: '카고바지', product_en: 'tactical cargo pants' });
  assert.match(res.content, /^# 미국 시장조사 — 카고바지/);
  assert.ok(res.content.includes('솔기 불만 [\\[E1\\]](<https://r.example/1>)'));
  assert.equal(res.model, 'org/market_research · gpt-test');
  assert.ok(!res.content.includes('타당성'), 'no closed next-step footer');
  assert.equal(statuses.length, 3);

  // Synthesis reply unusable twice → the evidence pack is shown with the reason.
  const fallback = await handleMarketResearchMode({
    cqrRoot: 'C:/app', sessionStore: store([]), sessionId: 's1', message: '/심층리서치 카고바지', routing,
    llm: async (system) => (system.includes('structured brief')
      ? { content: '{"action":"research","product":"카고바지","product_en":"tactical cargo pants"}', model: 'm' }
      : { content: 'sorry', model: 'm' }),
    runPipeline: okRun,
  });
  assert.match(fallback.content, /종합하지 못해\(응답이 JSON 형식이 아니었습니다\)/);
  assert.match(fallback.content, /# 시장조사 근거 팩 — 카고바지/);

  // Clarify → question back, no pipeline run.
  ran = false;
  const clarify = await handleMarketResearchMode({
    cqrRoot: 'C:/app', sessionStore: store([]), sessionId: 's1', message: '시장조사 해줘', routing: { ...routing, layer: 'keyword' },
    llm: async () => ({ content: '{"action":"clarify","question":"어떤 품목인가요?"}', model: 'm' }),
    runPipeline: async () => { ran = true; return okRun({}); },
  });
  assert.match(clarify.content, /어떤 품목인가요\?/);
  assert.equal(ran, false);

  // needs_brief from the pipeline is a question, not "실행 실패".
  const needs = await handleMarketResearchMode({
    cqrRoot: 'C:/app', sessionStore: store([]), sessionId: 's1', message: '/심층리서치 텀블러', routing,
    llm: null,
    runPipeline: async () => ({ ok: false, phase: 'research', status: 'needs_brief', error: '영문명을 붙여 주세요', used_fallback_chat: false, capability: readyCapability() }),
  });
  assert.match(needs.content, /^\*\*조사할 대상을 확인해 주세요\*\*/);
}

console.log('verify-market-pipeline: ok');
