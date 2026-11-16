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
  assert.match(md, /## 소비자 불만·페인 포인트/);
  assert.match(md, /\| 솔기 터짐 \| 1건 \(1개 사이트\)/);
  assert.match(md, /## 시장 공백 가설\n\n_근거 부족/);
  assert.match(md, /주제와 무관하다고 판단해 종합에서 뺀 근거 1건: E2\(slack\.example\)/);
  assert.ok(!md.includes('https://slack.example/r'), 'off-topic evidence is not listed as a source');
  assert.equal(parseSynthesis('no json', PACK), null);
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
  assert.match(res.content, /솔기 불만 \[E1\]/);
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
