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

  await (await fetchWithUsage(`${base}/alpha/decisions`, post({ model: 'typesafe/jev-1', state: {}, questions: {} }))).text();
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
  assert.ok(!probed.models.some((m) => m.key === 'microsoft/microsoft-decision-2'));
  assert.ok(probed.models.some((m) => m.key === 'microsoft/microsoft-decision-1.1'));
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

  // Route takes only a boolean switch (no past points).
  const dispatchSrc = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
  assert.match(dispatchSrc, /typeof body\.enabled !== 'boolean'/);
  assert.ok(!dispatchSrc.includes('llm-usage-count-since'));
  pass('tracking route accepts only boolean');

  console.log(`verify-llm-usage-purpose: ${passed} passed`);
} finally {
  server?.close();
  rmSync(temp, { recursive: true, force: true });
}
