// SQLite usage store: one-time JSONL import with per-date reconciliation, live writes, turn ids.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(root, 'data', 'verify-llm-usage-sqlite-'));
const env = { ...process.env };
let server;
let passed = 0;
const pass = (name) => { passed += 1; console.log(`PASS ${name}`); };
try {
  process.env.MY_AGENT_LLM_LOG = 'off';
  const usageDir = path.join(temp, 'usage');
  process.env.MY_AGENT_LLM_USAGE_LOG_DIR = usageDir;
  delete process.env.MY_AGENT_LLM_USAGE_LOG;
  delete process.env.MY_AGENT_LLM_USAGE_STORE;
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json'), '--outDir', path.join(temp, 'compiled'), '--declaration', 'false'], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  pass('core TypeScript (isolated output)');
  const load = (rel) => import(pathToFileURL(path.join(temp, 'compiled', rel + '.js')));
  const store = await load('providers/llm-usage-store');
  const { fetchWithUsage } = await load('providers/llm-usage-log');
  const { summarizeLlmUsage } = await load('providers/llm-usage-summary');
  const chatRuns = await load('chat/chat-runs');

  // Legacy fixtures: two UTC dates, billed + estimated + backfilled + probe + error-detail + no call id.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const d0 = now - 2 * 3_600_000;
  const d1 = now - 26 * 3_600_000;
  const fin = (ms, extra) => ({ version: 1, event: 'finish', started_at: iso(ms), finished_at: iso(ms + 1000), outcome: 'completed', endpoint_host: 'openrouter.ai', provider_id: 'openrouter', ...extra });
  const files = new Map();
  const add = (ms, row) => {
    const name = `llm-usage-${iso(ms).slice(0, 10)}.jsonl`;
    files.set(name, [...(files.get(name) ?? []), row]);
  };
  add(d0, { version: 1, event: 'start', call_id: 'a', started_at: iso(d0) });
  add(d0, fin(d0, { call_id: 'a', model: 'openai/gpt-4o-mini', total_input_tokens: 1000, cached_tokens: 600, cache_write_tokens: 100, output_tokens: 50, provider_cost_usd: 0.01, cache_discount_usd: 0.002, session_id: 'old-session' }));
  add(d0, fin(d0 + 1, { call_id: 'b', model: 'openai/gpt-4o-mini', total_input_tokens: 500, output_tokens: 20, generation_id: 'gen-abc123', provider_cost_usd: null }));
  add(d0, { version: 1, event: 'cost_backfill', call_id: 'b', provider_cost_usd: 0.03 });
  add(d0, fin(d0 + 2, { call_id: 'c', model: '~typesafe/jev-latest', probe: true, http_status: 400, outcome: 'http_error' }));
  add(d0, fin(d0 + 3, { call_id: 'd', model: 'openai/gpt-4o-mini', outcome: 'http_error', http_status: 500 }));
  add(d0, { version: 1, event: 'http_error_detail', call_id: 'd', http_status: 500 });
  add(d0, fin(d0 + 4, { call_id: 'e', model: 'openai/gpt-4o-mini', total_input_tokens: 300, output_tokens: 10, generation_id: 'gen-pending1', provider_cost_usd: null }));
  add(d1, fin(d1, { model: 'unknown/model-x', total_input_tokens: 100, output_tokens: 5 }));
  add(d1, fin(d1 + 1, { call_id: 'f', model: 'openai/gpt-4o-mini', total_input_tokens: 2000, cached_tokens: 1500, output_tokens: 40 }));
  mkdirSync(usageDir, { recursive: true });
  for (const [name, rows] of files) writeFileSync(path.join(usageDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sizes = () => Object.fromEntries(readdirSync(usageDir).filter((f) => f.endsWith('.jsonl')).map((f) => [f, statSync(path.join(usageDir, f)).size]));
  const before = sizes();

  const tracking = { enabled: true, first_started_at: iso(now - 7 * 86_400_000), periods: [{ from: iso(now - 7 * 86_400_000), to: null }] };
  const summary = () => summarizeLlmUsage({ cqrRoot: temp, days: 7, tracking });
  const strip = (s) => ({ totals: s.totals, models: s.models, providers: s.providers, purposes: s.purposes, daily: s.daily, cache_requests: s.cache_requests });

  // Baseline from the legacy JSONL reader.
  process.env.MY_AGENT_LLM_USAGE_STORE = 'jsonl';
  const legacy = summary();
  assert.equal(legacy.storage, 'jsonl');
  assert.ok(legacy.totals.requests >= 6, `legacy counted ${legacy.totals.requests}`);
  store.resetLlmUsageStoresForTest();
  delete process.env.MY_AGENT_LLM_USAGE_STORE;

  const handle = store.prepareLlmUsageStore(usageDir);
  assert.equal(handle.mode, 'sqlite');
  assert.equal(handle.report.status, 'done');
  assert.equal(handle.report.files, 2);
  assert.equal(handle.report.rows, 7, 'finish rows only (start/backfill/detail rows are merged, not stored)');
  assert.equal(handle.migratedNow, true);
  pass('JSONL import: every date reconciled, store switched to SQLite');

  const migrated = summary();
  assert.equal(migrated.storage, 'sqlite');
  assert.deepEqual(strip(migrated), strip(legacy));
  pass('summary from SQLite equals legacy JSONL summary (totals/groups/daily/cache rows)');

  const all = store.readAllLlmUsageRows(usageDir);
  assert.equal(all.find((r) => r.call_id === 'b').provider_cost_usd, 0.03, 'backfill merged');
  assert.equal(all.find((r) => r.call_id === 'd')._error_detail.http_status, 500, 'error detail kept');
  assert.ok(all.some((r) => String(r._call_id).startsWith('legacy:')), 'row without call id gets synthetic id');
  assert.deepEqual(sizes(), before, 'JSONL files untouched');
  pass('backfill/error detail joined; JSONL files kept as-is');

  const pending = store.pendingLlmUsageBackfills(usageDir, now - 3 * 86_400_000, 10);
  assert.deepEqual(pending.map((p) => p.callId), ['e'], 'only the uncosted generation row is pending');
  pass('pending cost backfills come from SQLite');

  // Re-open (next app start): no second import, no duplicates.
  store.resetLlmUsageStoresForTest();
  const again = store.prepareLlmUsageStore(usageDir);
  assert.equal(again.mode, 'sqlite');
  assert.equal(again.migratedNow, false);
  assert.equal(store.readAllLlmUsageRows(usageDir).length, 7);
  pass('migration runs once');

  // Live write inside a chat run: turn id = run id, nothing appended to JSONL, no start rows stored.
  server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'openai/gpt-4o-mini', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 800, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 700 }, cost: 0.004 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const run = chatRuns.beginChatRun('sess-live', 'turn-live-1');
  await chatRuns.executeChatRun(run, undefined, async () => {
    for (let i = 0; i < 2; i += 1) {
      await (await fetchWithUsage(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [] }) })).text();
    }
  }, () => {});
  const live = store.readAllLlmUsageRows(usageDir).filter((r) => r._source === 'live');
  assert.equal(live.length, 2);
  assert.ok(live.every((r) => r.turn_id === 'turn-live-1' && r.session_id === 'sess-live' && r.event === 'finish'));
  assert.deepEqual(sizes(), before, 'no JSONL writes after migration');
  pass('chat run: every AI call carries session + turn id, written to SQLite only');

  const withLive = summary();
  assert.equal(withLive.totals.requests, legacy.totals.requests + 2);
  const liveCache = withLive.cache_requests.filter((r) => r.turn_id === 'turn-live-1');
  assert.equal(liveCache.length, 2);
  assert.ok(liveCache.every((r) => r.session_id === 'sess-live' && r.cached_tokens === 700));
  pass('summary includes live rows with session/turn on cache rows');

  // A legacy date that does not reconcile is recorded, not fatal: SQLite is still adopted for good.
  const mmDir = path.join(temp, 'mismatch');
  mkdirSync(mmDir, { recursive: true });
  for (const [name, rows] of files) writeFileSync(path.join(mmDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const mmDate = iso(d1).slice(0, 10);
  const mm = store.prepareLlmUsageStore(mmDir, process.env, {
    afterImport: (db) => db.prepare("UPDATE llm_usage SET row_json = json_set(row_json, '$.output_tokens', 999999) WHERE log_date = ? AND call_id = 'f'").run(mmDate),
  });
  assert.equal(mm.mode, 'sqlite');
  assert.equal(mm.report.status, 'mismatch');
  assert.equal(mm.report.imported, true);
  assert.deepEqual(store.llmUsageMismatchedDates(mmDir), [mmDate]);
  assert.equal(store.readAllLlmUsageRows(mmDir).length, 7, 'import committed despite mismatch');
  store.resetLlmUsageStoresForTest();
  const mmAgain = store.prepareLlmUsageStore(mmDir);
  assert.equal(mmAgain.mode, 'sqlite');
  assert.equal(mmAgain.migratedNow, false, 'mismatch is final, not retried every start');
  assert.equal(store.readAllLlmUsageRows(mmDir).length, 7);
  assert.equal(summary().legacy_mismatch_dates, undefined, 'clean store has no notice');
  process.env.MY_AGENT_LLM_USAGE_LOG_DIR = mmDir;
  try {
    const mmSummary = summarizeLlmUsage({ cqrRoot: temp, days: 7, tracking });
    assert.equal(mmSummary.storage, 'sqlite');
    assert.deepEqual(mmSummary.legacy_mismatch_dates, [mmDate]);
  } finally { process.env.MY_AGENT_LLM_USAGE_LOG_DIR = usageDir; }
  pass('reconcile mismatch: dates recorded, SQLite adopted once, no retry');

  // Forced JSONL (tests/ops) and an unusable DB both fall back to the legacy store.
  const brokenDir = path.join(temp, 'broken');
  mkdirSync(path.join(brokenDir, 'llm-usage.sqlite'), { recursive: true });
  const broken = store.prepareLlmUsageStore(brokenDir);
  assert.equal(broken.mode, 'jsonl');
  assert.equal(broken.report.status, 'error');
  store.resetLlmUsageStoresForTest();
  assert.equal(store.prepareLlmUsageStore(path.join(temp, 'forced'), { MY_AGENT_LLM_USAGE_STORE: 'jsonl' }).mode, 'jsonl');
  pass('unusable DB / forced jsonl keep the JSONL store');

  console.log(`verify-llm-usage-sqlite: ${passed} checks passed`);
} finally {
  try { server?.close(); } catch { /* ignore */ }
  try { (await import(pathToFileURL(path.join(temp, 'compiled/providers/llm-usage-store.js')))).resetLlmUsageStoresForTest(); } catch { /* not built */ }
  for (const key of ['MY_AGENT_LLM_LOG', 'MY_AGENT_LLM_USAGE_LOG_DIR', 'MY_AGENT_LLM_USAGE_LOG', 'MY_AGENT_LLM_USAGE_STORE']) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  rmSync(temp, { recursive: true, force: true });
}
