// Usage log purpose split (chat/approval/image/video/embedding) + 「비용 추적」 on/off intervals + custom range.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(root, 'data', 'verify-llm-usage-purpose-'));
let server;
let server2;
let passed = 0;
const readFileSafe = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const pass = (name) => { passed += 1; console.log(`PASS ${name}`); };
try {
  process.env.MY_AGENT_LLM_LOG = 'off';
  const usageDir = path.join(temp, 'usage');
  process.env.MY_AGENT_LLM_USAGE_LOG_DIR = usageDir;
  delete process.env.MY_AGENT_LLM_USAGE_LOG;
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json'), '--outDir', path.join(temp, 'compiled'), '--declaration', 'false'], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  pass('core TypeScript (isolated output)');
  const load = (rel) => import(pathToFileURL(path.join(temp, 'compiled', rel + '.js')));
  const { fetchWithUsage, withLlmUsageContext, recordLlmUsageEvent } = await load('providers/llm-usage-log');
  const { createEmbeddings } = await load('providers/embeddings');
  const { summarizeLlmUsage, readLlmUsageTracking, setLlmUsageTracking } = await load('providers/llm-usage-summary');
  const { generateVideo, retrieveVideoJob } = await load('video/video-generation');

  server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/decisions')) res.end(JSON.stringify({ model: 'typesafe/jev-1', answers: { severity: 'normal' }, usage: { cost: 0.001 } }));
    else if (req.url.endsWith('/embeddings')) res.end(JSON.stringify({ model: 'emb', data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 5, total_tokens: 5 } }));
    else res.end(JSON.stringify({ model: 'img-model', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.02, cost_details: { upstream_inference_input_cost: 0.004 } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (url, body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await (await fetchWithUsage(`${base}/alpha/decisions`, post(null, { model: '~typesafe/jev-latest', state: {}, questions: {} }))).text();
  await createEmbeddings(`${base}/v1`, 'sk-test', 'emb', ['hello']);
  await withLlmUsageContext({ purpose: 'image' }, async () => (await fetchWithUsage(`${base}/v1/chat/completions`, post({ model: 'img-model', messages: [] }))).text());
  await (await fetchWithUsage(`${base}/v1/chat/completions`, post({ model: 'chat-model', messages: [] }))).text();

  // Video: provider reports completion + cost; download fails locally; a later retrieve must not count it again.
  const videoFetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/videos')) return new Response(JSON.stringify({ id: 'job-1', status: 'completed', usage: { cost: 0.75 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/videos/job-1/content')) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ id: 'job-1', status: 'completed', usage: { cost: 0.75 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const output = { dir: path.join(temp, 'videos'), urlPrefix: '/outputs/videos/x', baseName: 'v', cqrRoot: temp };
  const model = { id: 'vendor/video-1', label: 'V', duration: 4, resolution: '720p', aspect_ratio: '16:9', generate_audio: false };
  await withLlmUsageContext({ purpose: 'video', providerId: 'openrouter' }, async () => {
    await assert.rejects(generateVideo({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test', model, prompt: 'p', output, fetchImpl: videoFetch, pollIntervalMs: 1 }));
    await assert.rejects(retrieveVideoJob({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test', jobId: 'job-1', modelId: model.id, output, fetchImpl: videoFetch }));
  });
  recordLlmUsageEvent({ purpose: 'video', model: 'vendor/video-2', outcome: 'completed' });

  const rows = readdirSync(usageDir).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(path.join(usageDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((r) => r.event === 'finish');
  const byPurpose = (p) => rows.filter((r) => r.purpose === p);
  assert.equal(byPurpose('approval').length, 1);
  assert.equal(byPurpose('approval')[0].provider_cost_usd, 0.001);
  pass('decisions endpoint logged as approval with billed cost');
  assert.equal(byPurpose('approval')[0].model, '~typesafe/jev-latest', 'OpenRouter ~ alias kept as model name');
  pass('~ latest alias recorded as model (no 「(알 수 없음)」)');
  assert.equal(byPurpose('embedding').length, 1);
  assert.equal(byPurpose('embedding')[0].input_tokens, 5);
  pass('embeddings logged as embedding');
  assert.equal(byPurpose('image').length, 1);
  assert.equal(byPurpose('chat').length, 1);
  pass('context purpose image vs default chat');
  assert.equal(byPurpose('image')[0].upstream_input_cost_usd, 0.004);
  assert.equal(byPurpose('image')[0].cost_probe, undefined, 'diagnostic probe retired');
  pass('billed row logs actual input cost (cost_details)');
  const videos = byPurpose('video');
  assert.equal(videos.filter((r) => r.model === 'vendor/video-1').length, 1, 'video job counted once');
  assert.equal(videos.find((r) => r.model === 'vendor/video-1').provider_cost_usd, 0.75);
  assert.equal(videos.find((r) => r.model === 'vendor/video-1').provider_id, 'openrouter');
  assert.ok(!JSON.stringify(rows).includes('sk-test'), 'no secrets in rows');
  pass('video job logged once with cost, no secrets');

  // Never turned on → nothing counted even though rows exist.
  const none = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  assert.equal(none.tracking.enabled, false);
  assert.equal(none.tracking.periods.length, 0);
  assert.equal(none.totals.requests, 0);
  assert.equal(none.purposes.length, 0);
  pass('never tracked = empty summary');

  const openSince = (iso) => ({ enabled: true, first_started_at: iso, periods: [{ from: iso, to: null }] });
  const all = summarizeLlmUsage({ cqrRoot: temp, days: 7, tracking: openSince(new Date(Date.now() - 3_600_000).toISOString()) });
  const keys = Object.fromEntries(all.purposes.map((p) => [p.key, p.requests]));
  assert.deepEqual(keys, { approval: 1, embedding: 1, image: 1, chat: 1, video: 2 });
  assert.equal(all.purposes.find((p) => p.key === 'video').unpriced_requests, 1, 'video without cost = unpriced');
  assert.ok(Math.abs(all.totals.billed_cost_usd - (0.001 + 0.02 + 0.02 + 0.75)) < 1e-9, `billed ${all.totals.billed_cost_usd}`);
  assert.ok(all.daily.some((d) => d.purposes.video?.requests === 2));
  pass('summary purposes + unpriced video');

  // On-intervals: an old row before the switch was turned on must be excluded.
  const now = Date.now();
  const oldDay = new Date(now - 2 * 86_400_000);
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(path.join(usageDir, `llm-usage-${oldDay.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ event: 'finish', started_at: oldDay.toISOString(), outcome: 'completed', model: 'old', provider_cost_usd: 9 }) + '\n');
  assert.equal(summarizeLlmUsage({ cqrRoot: temp, days: 7, tracking: openSince(new Date(0).toISOString()) }).totals.requests, 7);
  assert.equal(readLlmUsageTracking(temp).periods.length, 0);
  const on = setLlmUsageTracking(temp, true, process.env, now - 86_400_000);
  assert.equal(on.enabled, true);
  assert.equal(setLlmUsageTracking(temp, true, process.env, now).periods.length, 1, 'turning on twice keeps one interval');
  const filtered = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  assert.equal(filtered.tracking.first_started_at, on.first_started_at);
  assert.equal(filtered.totals.requests, 6);
  assert.ok(!filtered.models.some((m) => m.key === 'old'));
  const allRange = summarizeLlmUsage({ cqrRoot: temp, days: 'all', tzOffsetMinutes: 540 });
  assert.ok(allRange.range.days >= 2 && allRange.range.days <= 3, `all range days ${allRange.range.days}`);
  pass('tracking on: persist/filter and all range');

  // Off → rows during the pause are excluded; data so far stays; on again resumes (no reset).
  const off = setLlmUsageTracking(temp, false);
  assert.equal(off.enabled, false);
  assert.equal(summarizeLlmUsage({ cqrRoot: temp, days: 7 }).totals.requests, 6, 'off keeps collected data');
  const offTo = Date.parse(off.periods[0].to);
  const pausedRow = new Date(offTo + 1);
  const resumedRow = new Date(offTo + 10);
  const fileFor = (d) => path.join(usageDir, `llm-usage-${d.toISOString().slice(0, 10)}.jsonl`);
  const appendRow = (d, model) => writeFileSync(fileFor(d), (readFileSafe(fileFor(d))) + JSON.stringify({ event: 'finish', started_at: d.toISOString(), outcome: 'completed', model, provider_cost_usd: 1 }) + '\n');
  appendRow(pausedRow, 'paused');
  setLlmUsageTracking(temp, true, process.env, offTo + 5);
  appendRow(resumedRow, 'resumed');
  const resumed = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  assert.equal(resumed.tracking.periods.length, 2);
  assert.equal(resumed.totals.requests, 7);
  assert.ok(resumed.models.some((m) => m.key === 'resumed'));
  assert.ok(!resumed.models.some((m) => m.key === 'paused'));
  pass('off excludes pause, keeps data, on resumes');

  // Custom local-date window (reversed order tolerated, capped length).
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const custom = summarizeLlmUsage({ cqrRoot: temp, from: day(now), to: day(now - 3 * 86_400_000) });
  assert.equal(custom.range.days, 4);
  assert.equal(custom.range.to, day(now));
  const capped = summarizeLlmUsage({ cqrRoot: temp, from: '2000-01-01', to: day(now) });
  assert.equal(capped.range.days, 366);
  assert.equal(summarizeLlmUsage({ cqrRoot: temp, from: 'bad', to: day(now), days: 7 }).range.days, 7, 'invalid custom falls back');
  pass('custom date range');

  // Decision version probes: unknown-id 400 is dropped; a probe that hit a real model is counted.
  const probeAt = new Date();
  writeFileSync(fileFor(probeAt), readFileSafe(fileFor(probeAt))
    + JSON.stringify({ event: 'finish', started_at: probeAt.toISOString(), purpose: 'approval', probe: true, http_status: 400, outcome: 'http_error', model: 'microsoft/microsoft-decision-2' }) + '\n'
    + JSON.stringify({ event: 'finish', started_at: probeAt.toISOString(), purpose: 'approval', probe: true, http_status: 200, outcome: 'completed', model: 'microsoft/microsoft-decision-1.1', provider_cost_usd: 0.002 }) + '\n');
  const probed = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  assert.equal(probed.totals.requests, 8, 'only the billed probe is counted');
  assert.ok(!probed.models.some((m) => m.key.startsWith('microsoft/microsoft-decision-2')));
  assert.ok(probed.models.some((m) => m.key === 'microsoft/microsoft-decision-1.1 (승인 판단)'));
  const probeSrc = readFileSync(path.join(root, 'core/src/agent/approval-auto-review.ts'), 'utf8');
  assert.match(probeSrc, /withLlmUsageContext\(\{ probe: true \}/);
  await withLlmUsageContext({ probe: true }, async () => (await fetchWithUsage(`${base}/alpha/decisions`, post({ model: 'm', state: {}, questions: {} }))).text());
  const probeRows = readdirSync(usageDir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(path.join(usageDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((r) => r.event === 'finish' && r.probe === true && r.endpoint_host);
  assert.equal(probeRows.length, 1, 'probe context marks the logged row');
  assert.equal(probeRows[0].purpose, 'approval');
  pass('decision version probes: free 400 excluded, billed probe kept');

  // Cache savings without cache_discount: list input price − actual input cost, marked as estimated.
  process.env.MY_AGENT_LLM_PRICING_JSON = JSON.stringify({ 'cache-model': { input_usd_per_million: 5, output_usd_per_million: 25 } });
  const cacheAt = new Date();
  writeFileSync(fileFor(cacheAt), readFileSafe(fileFor(cacheAt))
    + JSON.stringify({ event: 'finish', started_at: cacheAt.toISOString(), outcome: 'completed', model: 'cache-model', total_input_tokens: 40_000, input_tokens: 40_000, cached_tokens: 39_000, cache_write_tokens: 500, output_tokens: 100, provider_cost_usd: 0.03, cache_discount_usd: null, upstream_input_cost_usd: 0.025 }) + '\n'
    + JSON.stringify({ event: 'finish', started_at: cacheAt.toISOString(), outcome: 'completed', model: 'cache-model', total_input_tokens: 1_000, input_tokens: 1_000, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 10, provider_cost_usd: 0.006, upstream_input_cost_usd: 0.0051 }) + '\n');
  const cacheSummary = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  const cache = cacheSummary.models.find((m) => m.key === 'cache-model');
  assert.ok(Math.abs(cache.cache_savings_usd - (0.2 - 0.025)) < 1e-9, `savings ${cache.cache_savings_usd}`);
  assert.equal(cache.cache_savings_estimated_requests, 1, 'no-cache row is not estimated');
  // Per-request cache list: only cache-using rows, newest first.
  const cacheRows = cacheSummary.cache_requests.filter((r) => r.model === 'cache-model');
  assert.equal(cacheRows.length, 1, 'no-cache request is not listed');
  assert.equal(cacheRows[0].cached_tokens, 39_000);
  assert.equal(cacheRows[0].cache_write_tokens, 500);
  assert.ok(Math.abs(cacheRows[0].savings_usd - (0.2 - 0.025)) < 1e-9);
  assert.equal(cacheRows[0].estimated, true);
  assert.equal(cacheSummary.cache_requests_total, cacheSummary.cache_requests.length);
  assert.ok(cacheSummary.cache_requests.every((r, i, a) => i === 0 || Date.parse(a[i - 1].started_at) >= Date.parse(r.started_at)));
  pass('per-request cache list');
  delete process.env.MY_AGENT_LLM_PRICING_JSON;
  pass('cache savings estimated from list price − actual input cost');

  // Same model id used for chat and approval → separate 「모델별」 rows; purposes unchanged.
  const shareAt = new Date();
  writeFileSync(fileFor(shareAt), readFileSafe(fileFor(shareAt))
    + JSON.stringify({ event: 'finish', started_at: shareAt.toISOString(), outcome: 'completed', model: 'shared-model', input_tokens: 100, output_tokens: 10, provider_cost_usd: 0.01 }) + '\n'
    + JSON.stringify({ event: 'finish', started_at: shareAt.toISOString(), outcome: 'completed', purpose: 'approval', model: 'shared-model', input_tokens: 50, output_tokens: 5, provider_cost_usd: 0.002 }) + '\n');
  const shared = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  const chatRow = shared.models.find((m) => m.key === 'shared-model');
  const approvalRow = shared.models.find((m) => m.key === 'shared-model (승인 판단)');
  assert.equal(chatRow?.requests, 1);
  assert.equal(approvalRow?.requests, 1);
  assert.ok(shared.daily.some((d) => d.models['shared-model (승인 판단)']), 'daily series uses the split key');
  pass('model rows split chat vs approval for the same model id');

  // Provider column groups by endpoint host: `custom`+openrouter.ai and host-only rows merge.
  const provAt = new Date();
  writeFileSync(fileFor(provAt), readFileSafe(fileFor(provAt))
    + JSON.stringify({ event: 'finish', started_at: provAt.toISOString(), outcome: 'completed', provider_id: 'custom', endpoint_host: 'openrouter.ai', model: 'prov-model', input_tokens: 10, output_tokens: 1 }) + '\n'
    + JSON.stringify({ event: 'finish', started_at: provAt.toISOString(), outcome: 'completed', endpoint_host: 'openrouter.ai', model: 'prov-model', input_tokens: 20, output_tokens: 2 }) + '\n'
    + JSON.stringify({ event: 'finish', started_at: provAt.toISOString(), outcome: 'completed', provider_id: 'legacy-id', model: 'prov-model', input_tokens: 5, output_tokens: 1 }) + '\n');
  const prov = summarizeLlmUsage({ cqrRoot: temp, days: 7 });
  assert.ok(!prov.providers.some((p) => p.key === 'openrouter.ai'), 'raw host is labeled');
  assert.ok(!prov.providers.some((p) => p.key === 'custom' ), 'custom+host row is not split by id');
  assert.ok(prov.providers.find((p) => p.key === 'OpenRouter')?.requests >= 2, 'custom + host-only merge under OpenRouter');
  assert.equal(prov.providers.find((p) => p.key === 'legacy-id')?.requests, 1, 'host-less rows keep provider id');
  pass('provider rows group by endpoint host');

  // Image replies: base64 image in an oversized `response.completed`, usage recovered from its tail;
  // a reply without cost but with x-generation-id is backfilled from the generation-stats API.
  const imageDir = path.join(temp, 'usage-image');
  process.env.MY_AGENT_LLM_USAGE_LOG_DIR = imageDir;
  process.env.MY_AGENT_LLM_USAGE_BACKFILL_DELAYS_MS = '20,60';
  const bigImage = 'A'.repeat(2_500_000);
  let statsAuth;
  server2 = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url.startsWith('/api/v1/generation')) {
      statsAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'gen-two', total_cost: 0.05, native_tokens_prompt: 7, native_tokens_completion: 1290, provider_name: 'Google' } }));
      return;
    }
    const withUsage = req.headers['x-case'] === 'big';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': withUsage ? 'gen-one' : 'gen-two' });
    res.write(`data: ${JSON.stringify({ type: 'response.created', response: { model: 'google/gemini-3-pro-image' } })}\n\n`);
    const completed = JSON.stringify({ type: 'response.completed', response: {
      model: 'google/gemini-3-pro-image', output: [{ type: 'image_generation_call', result: withUsage ? bigImage : 'x' }],
      ...(withUsage ? { usage: { input_tokens: 12, output_tokens: 1290, cost: 0.134, input_tokens_details: { cached_tokens: 0 } } } : {}),
    } });
    const frame = `data: ${completed}\n\n`;
    for (let i = 0; i < frame.length; i += 65_536) res.write(frame.slice(i, i + 65_536));
    res.end();
  });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const imgBase = `http://127.0.0.1:${server2.address().port}/api/v1`;
  const imgPost = (kind) => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-img', 'x-case': kind }, body: JSON.stringify({ model: 'google/gemini-3-pro-image', input: [], stream: true }) });
  const bigText = await (await fetchWithUsage(`${imgBase}/responses`, imgPost('big'))).text();
  assert.ok(bigText.length > 2_500_000, 'bytes delivered unchanged');
  await (await fetchWithUsage(`${imgBase}/responses`, imgPost('small'))).text();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const imageRows = readdirSync(imageDir).flatMap((f) => readFileSync(path.join(imageDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const finishes = imageRows.filter((r) => r.event === 'finish');
  assert.equal(finishes.length, 2);
  assert.ok(finishes.every((r) => r.purpose === 'image'), 'context-less image model counted as image');
  const big = finishes.find((r) => r.output_tokens === 1290);
  assert.ok(big, 'usage salvaged from oversized event');
  assert.equal(big.provider_cost_usd, 0.134);
  assert.equal(big.usage_salvaged, true);
  assert.equal(big.observation_truncated, true);
  assert.equal(big.outcome, 'completed', 'terminal type read from event head');
  pass('oversized image event: usage + cost salvaged, purpose image');
  const fills = imageRows.filter((r) => r.event === 'cost_backfill');
  assert.equal(fills.length, 1, 'only the cost-less reply is backfilled');
  assert.equal(statsAuth, 'Bearer sk-img', 'stats API uses the same key');
  assert.ok(!JSON.stringify(imageRows).includes('sk-img'), 'no secrets in rows');
  const small = finishes.find((r) => r.call_id === fills[0].call_id);
  assert.equal(small.provider_cost_usd, null);
  const imgSummary = summarizeLlmUsage({ cqrRoot: temp, days: 7, tracking: openSince(new Date(Date.now() - 3_600_000).toISOString()) });
  assert.ok(Math.abs(imgSummary.totals.billed_cost_usd - (0.134 + 0.05)) < 1e-9, `billed ${imgSummary.totals.billed_cost_usd}`);
  assert.equal(imgSummary.purposes.find((p) => p.key === 'image')?.requests, 2);
  assert.equal(imgSummary.totals.requests, 2, 'backfill row is not a request');
  pass('generation-stats backfill fills a cost-less reply');
  assert.equal(small.generation_id, 'gen-two', 'cost-less row keeps generation id');
  assert.equal(big.generation_id, undefined, 'priced row does not keep generation id');

  // App closed before the delayed lookup: the next usage-page load recovers it from the kept generation id.
  const { recoverPendingCostBackfills } = await load('providers/llm-usage-log');
  const recAt = Date.now();
  const recFile = path.join(imageDir, `llm-usage-${new Date(recAt).toISOString().slice(0, 10)}.jsonl`);
  writeFileSync(recFile, readFileSafe(recFile)
    + JSON.stringify({ call_id: 'rec-old', event: 'finish', started_at: new Date(recAt - 300_000).toISOString(), finished_at: new Date(recAt - 290_000).toISOString(), outcome: 'completed', provider_id: 'custom', endpoint_host: 'openrouter.ai', model: 'google/gemini-3-pro-image', provider_cost_usd: null, generation_id: 'gen-two' }) + '\n'
    + JSON.stringify({ call_id: 'rec-young', event: 'finish', started_at: new Date(recAt - 5_000).toISOString(), finished_at: new Date(recAt - 4_000).toISOString(), outcome: 'completed', endpoint_host: 'openrouter.ai', provider_cost_usd: null, generation_id: 'gen-two' }) + '\n'
    + JSON.stringify({ call_id: 'rec-other-host', event: 'finish', started_at: new Date(recAt - 300_000).toISOString(), finished_at: new Date(recAt - 290_000).toISOString(), outcome: 'completed', endpoint_host: 'api.example.com', provider_cost_usd: null, generation_id: 'gen-two' }) + '\n');
  statsAuth = undefined;
  const authCalls = [];
  const recover = () => recoverPendingCostBackfills({
    cqrRoot: temp, force: true, now: recAt,
    authFor: (pid, host) => { authCalls.push([pid, host]); return host === 'openrouter.ai' ? 'Bearer sk-rec' : null; },
    statsUrlFor: (_host, gid) => `${imgBase}/generation?id=${gid}`,
  });
  assert.equal(await recover(), 1, 'only the old OpenRouter row is recovered');
  assert.equal(statsAuth, 'Bearer sk-rec');
  assert.deepEqual(authCalls, [['custom', 'openrouter.ai']]);
  assert.equal(await recover(), 0, 'already filled rows are not fetched again');
  const recRows = readFileSync(recFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const recFill = recRows.find((r) => r.event === 'cost_backfill' && r.call_id === 'rec-old');
  assert.equal(recFill?.provider_cost_usd, 0.05);
  assert.equal(recFill?.backfill_recovered, true);
  assert.ok(!readFileSync(recFile, 'utf8').includes('sk-rec'), 'no secrets in rows');
  pass('kept generation id: cost recovered after restart');

  // Image detection: the /models listing (output_modalities) decides first, the id pattern only as fallback.
  const { parseModelPricing, recordProviderPricing, setModelPricingFileForTest } = await load('models/model-pricing');
  const { isImageGenerationModelId } = await load('providers/llm-usage-log');
  assert.deepEqual(parseModelPricing({ pricing: { prompt: '0.000001' }, architecture: { output_modalities: ['image', 'text'] } })?.outputs, ['image', 'text']);
  setModelPricingFileForTest(null);
  recordProviderPricing('or', [
    { id: 'vendor/chat-image-reader', pricing: { input: 1, outputs: ['text'] } },
    { id: 'vendor/painter', pricing: { input: 1, outputs: ['image', 'text'] } },
  ]);
  assert.equal(isImageGenerationModelId('vendor/chat-image-reader', 'or'), false, 'text-only listing overrides the name');
  assert.equal(isImageGenerationModelId('vendor/painter', 'or'), true, 'image output without an image-like name');
  assert.equal(isImageGenerationModelId('unlisted/flux-2', 'or'), true, 'unlisted model falls back to the name');
  assert.equal(isImageGenerationModelId('unlisted/chat-1', 'or'), false);
  setModelPricingFileForTest(undefined);
  pass('image detection prefers listed output modalities');

  // Plain chat streams (image models picked in chat) carry session + provider into the usage log.
  const orchSrc = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  assert.match(orchSrc, /withLlmUsageContext\(\{ cqrRoot: this\.cqrRoot, sessionId, providerId, collect: usageCollector\.collect \}, \(\) => this\.cloudChat\.completeStream\(/);
  assert.match(orchSrc, /withLlmUsageContext\(\{ cqrRoot: this\.cqrRoot, sessionId, providerId \}, \(\) => this\.cloudChat\.complete\(/);
  pass('plain chat calls carry usage context');

  // Bubble usage: a reply-scoped collector sums every finished call (tokens + billed cost), jobs give cost only.
  {
    const { createLlmUsageCollector } = await load('providers/llm-usage-log');
    const c = createLlmUsageCollector();
    assert.equal(c.result(), undefined);
    await withLlmUsageContext({ purpose: 'image', collect: c.collect }, async () => {
      await (await fetchWithUsage(`${base}/v1/chat/completions`, post({ model: 'img-model', messages: [] }))).text();
      await withLlmUsageContext({ sessionId: 'nested' }, async () => (await fetchWithUsage(`${base}/v1/chat/completions`, post({ model: 'img-model', messages: [] }))).text());
    });
    const r = c.result();
    assert.equal(r.input_tokens, 20);
    assert.equal(r.output_tokens, 4);
    assert.ok(Math.abs(r.cost_usd - 0.04) < 1e-9, String(r.cost_usd));
    const v = createLlmUsageCollector();
    withLlmUsageContext({ purpose: 'video', collect: v.collect }, () => recordLlmUsageEvent({ purpose: 'video', model: 'vendor/video-3', outcome: 'completed', costUsd: 0.61 }));
    assert.deepEqual(v.result(), { cost_usd: 0.61 });
    for (const rel of ['core/src/chat/modes/image-gen.ts', 'core/src/chat/modes/video-gen.ts']) {
      assert.match(readFileSync(path.join(root, rel), 'utf8'), /collect: usageCollector\.collect/, rel);
    }
    const clientSrc = readFileSync(path.join(root, 'ui/workspace/src/api/myAgentClient.ts'), 'utf8');
    assert.match(clientSrc, /out\.costUsd = record\.cost_usd/);
    pass('reply usage collector feeds image/video bubble cost');
  }
  delete process.env.MY_AGENT_LLM_USAGE_BACKFILL_DELAYS_MS;
  process.env.MY_AGENT_LLM_USAGE_LOG_DIR = usageDir;

  // Route takes only a boolean switch (no past points).
  const dispatchSrc = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
  assert.match(dispatchSrc, /typeof body\.enabled !== 'boolean'/);
  assert.ok(!dispatchSrc.includes('llm-usage-count-since'));
  pass('tracking route accepts only boolean');

  console.log(`verify-llm-usage-purpose: ${passed} passed`);
} finally {
  server?.close();
  server2?.close();
  rmSync(temp, { recursive: true, force: true });
}
