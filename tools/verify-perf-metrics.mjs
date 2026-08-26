#!/usr/bin/env node
/**
 * P2: validate perf snapshot shape (env + wall_ms / ranking wall_ms).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, freemem, platform, totalmem, arch, release } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  collectPerfEnv,
  hostFromBaseUrl,
  isValidPerfReport,
  writePerfSnapshotFile,
  inferEarlyExitReason,
} = await import(pathToFileURL(path.join(root, 'core/dist/agent/agent-perf-metrics.js')).href);

const {
  calculateLlmUsageCost,
} = await import(pathToFileURL(path.join(root, 'core/dist/agent/llm-usage-cost.js')).href);

const env = collectPerfEnv({
  modelId: 'test-model',
  providerId: 'test-provider',
  baseUrlHost: hostFromBaseUrl('http://127.0.0.1:3000/v1'),
  protocol: 'client',
});
assert.equal(env.os, platform());
assert.equal(env.arch, arch());
assert.ok(env.cpuCores >= 1);
assert.ok(env.totalMemMb > 0);
assert.ok(env.node.startsWith('v'));
assert.equal(env.protocol, 'client');
assert.equal(env.providerId, 'test-provider');
assert.equal(env.baseUrlHost, '127.0.0.1:3000');

const pricedCost = calculateLlmUsageCost(
  { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 5 },
  'test-model',
  {
    MY_AGENT_LLM_PRICING_JSON: JSON.stringify({
      'test-model': {
        input_usd_per_million: 2,
        cached_input_usd_per_million: 0.5,
        output_usd_per_million: 8,
      },
    }),
  },
);
assert.equal(pricedCost.pricing_status, 'priced');
assert.equal(pricedCost.cache_hit_rate, 0.5);
assert.equal(pricedCost.total_cost_microusd, 29);
assert.equal(pricedCost.cache_savings_microusd, 8);
assert.equal(
  calculateLlmUsageCost(
    { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 5 },
    'unknown-model',
    {},
  ).pricing_status,
  'unpriced',
);

const sample = {
  at: new Date().toISOString(),
  wall_ms: 12,
  llm_round_trips: 1,
  tool_calls: 1,
  llm_completion_ms: 10,
  first_tool_ms: 4,
  autopilot_force_count: 0,
  approval_wait_ms: 3,
  orchestration_ms: 1,
  llm_trace: [{ step: 1, label: 'agent step', duration_ms: 10, wire_api: 'responses', responses_chain_advanced: true }],
  tool_trace: [{ step: 1, name: 'read_file', ok: false, duration_ms: 2, failure_type: 'not_found' }],
  approval_trace: [{ step: 1, name: 'run_terminal', duration_ms: 3, approved: true, delegable: false }],
  responses_state: { mode: 'client_replay', has_previous_response_id: true, next_message_index: 2, replay_item_count: 3 },
  usage: { prompt_tokens: 10, completion_tokens: 2, reasoning_tokens: 1, cached_tokens: 5, cache_write_tokens: 0 },
  cost: pricedCost,
  env,
};
assert.equal(isValidPerfReport(sample), true);
assert.equal(typeof sample.first_tool_ms, 'number');
assert.equal(sample.autopilot_force_count, 0);
assert.equal(sample.tool_trace[0].name, 'read_file');
assert.equal(sample.tool_trace[0].failure_type, 'not_found');
assert.equal(sample.llm_trace[0].wire_api, 'responses');
assert.equal(sample.responses_state.mode, 'client_replay');
assert.equal(sample.cost.total_cost_microusd, 29);
assert.equal(isValidPerfReport({ wall_ms: 1 }), false);
assert.equal(
  inferEarlyExitReason({
    content: 'TOOL_CALL {"tool":"read_file","path":"a.js"}\n',
    mutatedCount: 0,
  }),
  'unparsed_tool_call',
);
assert.equal(
  inferEarlyExitReason({ content: '반영 완료했습니다.\n### 변경 증거\n- `a.js`', mutatedCount: 1 }),
  'ok',
);
assert.equal(
  inferEarlyExitReason({ content: 'x', mutatedCount: 0, retrievalGateBlocks: 2 }),
  'retrieval_block',
);
assert.equal(
  inferEarlyExitReason({ content: '부분 / 미완료', mutatedCount: 1, claimsIncomplete: true }),
  'incomplete',
);
assert.equal(
  inferEarlyExitReason({ content: 'x', mutatedCount: 1, diagnostics: 'weak' }),
  'verification_weak',
);

const outDir = path.join(root, 'data', '_model_bakeoff');
mkdirSync(outDir, { recursive: true });
const samplePath = writePerfSnapshotFile(root, 'perf-sample.json', sample);
assert.ok(existsSync(samplePath));

// Enrich existing summary.json with env if missing (no live bakeoff required).
const summaryPath = path.join(outDir, 'summary.json');
if (existsSync(summaryPath)) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (!summary.env || !isValidPerfReport({ ...summary, wall_ms: summary.wall_ms ?? 1 })) {
    const wall = Array.isArray(summary.ranking)
      ? summary.ranking.reduce((a, r) => a + (r.wall_ms ?? r.ms ?? 0), 0)
      : summary.wall_ms ?? 0;
    summary.env = collectPerfEnv({
      modelId: summary.winner || undefined,
      protocol: summary.forceClient ? 'client' : summary.protocol || 'client',
    });
    summary.protocol = summary.protocol || (summary.forceClient ? 'client' : 'api');
    summary.wall_ms = wall;
    if (Array.isArray(summary.ranking)) {
      for (const row of summary.ranking) {
        if (row.ms != null && row.wall_ms == null) row.wall_ms = row.ms;
        if (!row.protocol) row.protocol = summary.protocol;
      }
    }
    summary.perf_enriched_at = new Date().toISOString();
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  assert.equal(isValidPerfReport(summary), true, 'bakeoff summary must be valid perf report');
}

console.log(
  `verify-perf-metrics: ok (cores=${cpus().length} memMb=${Math.round(totalmem() / 1e6)} freeMb=${Math.round(freemem() / 1e6)} release=${release()})`,
);
