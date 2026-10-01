#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TokenEfficiencyAdvisor, TOKEN_EFFICIENCY_PRINCIPLES } from '../core/dist/agent/agent-token-efficiency.js';
import { mergeStableToolCatalog } from '../core/dist/agent/agent-tool-registry.js';
import { getCodeAgentToolsForPack } from '../core/dist/agent/agent-tool-pack.js';

const definition = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } });
const base = [definition('read_file'), definition('apply_patch')];
const extensions = [definition('plugin_z'), definition('read_file'), definition('plugin_a'), definition('plugin_a')];
const before = JSON.stringify({ base, extensions });
assert.deepEqual(mergeStableToolCatalog(base, extensions).map((t) => t.function.name),
  ['read_file', 'apply_patch', 'plugin_a', 'plugin_z']);
assert.deepEqual(mergeStableToolCatalog(base, extensions), mergeStableToolCatalog(base, [...extensions].reverse()));
assert.equal(JSON.stringify({ base, extensions }), before, 'do not sort/mutate caller arrays');
assert.strictEqual(mergeStableToolCatalog(base, [definition('read_file')]), base);
const conflicts = [definition('plugin_conflict'), {
  ...definition('plugin_conflict'), function: { ...definition('plugin_conflict').function, description: 'different' },
}];
assert.deepEqual(mergeStableToolCatalog(base, conflicts), mergeStableToolCatalog(base, [...conflicts].reverse()));
for (const pack of ['files', 'browser', 'files+browser']) {
  assert.deepEqual(getCodeAgentToolsForPack(pack, true), getCodeAgentToolsForPack(pack, false),
    'runtime browser availability must not filter schemas');
}

let sequence = 0;
const sha = 'a'.repeat(64);
function read(advisor, { start = 10, end = 30, sourceSha = sha, cache = 'hit', fresh = false, ok = true, complete = true, file = 'a.ts' } = {}) {
  const output = `[read_file meta] path=${file} lines=${start}-${end}/200 bytes=40 complete=true cache=${cache} sha256=${sourceSha}\nconst a = 1;`;
  const record = {
    tool: 'read_file', args: { path: file, fresh }, source: { path: file }, ok, complete,
    evidenceId: `ev_${++sequence}`, fingerprint: `result-${sequence}`,
  };
  advisor.observe(record, output);
  return { record, output };
}
function other(advisor, tool, args = {}, output = '[]', extra = {}) {
  advisor.observe({ tool, args, ok: true, complete: true, fingerprint: output, ...extra }, output);
}

// Same source/range, different cache/result metadata: advisory only after repeats.
{
  const advisor = new TokenEfficiencyAdvisor();
  const { record, output } = read(advisor, { cache: 'miss' });
  const copy = JSON.stringify(record);
  assert.equal(advisor.consumeNote(), null);
  read(advisor);
  assert.equal(advisor.consumeNote(), null);
  read(advisor, { start: 9, end: 31 }); // >80% overlap
  assert.match(advisor.consumeNote(), /Repeated unchanged\/overlapping/);
  assert.equal(JSON.stringify(record), copy, 'record is not rewritten');
  assert.equal(output.includes('const a = 1;'), true, 'raw body retained');
  assert.equal(advisor.consumeNote(), null);
}
// Fresh, changed, missing coverage, failed and incomplete reads never count as repeat.
{
  const advisor = new TokenEfficiencyAdvisor();
  for (let i = 0; i < 15; i++) read(advisor, { sourceSha: i.toString(16).padStart(64, '0') });
  for (let i = 0; i < 4; i++) read(advisor, { fresh: true });
  for (let i = 0; i < 4; i++) read(advisor, { ok: false });
  for (let i = 0; i < 4; i++) read(advisor, { complete: false });
  for (let i = 0; i < 4; i++) other(advisor, 'read_file', { path: 'b.ts' }, 'body without source meta');
  assert.equal(advisor.consumeNote(), null);
}
// Novel read-only exploration is progress; no forced mutation after long discovery.
{
  const advisor = new TokenEfficiencyAdvisor();
  for (let i = 0; i < 40; i++) {
    read(advisor, { start: i + 1, end: i + 1 });
    assert.equal(advisor.consumeNote(), null);
  }
}
// Disk-changing operations invalidate history, including opaque terminal/test writes.
for (const tool of ['apply_patch', 'run_terminal', 'run_tests', 'workspace_rollback', 'git_switch']) {
  const advisor = new TokenEfficiencyAdvisor();
  read(advisor); read(advisor);
  other(advisor, tool);
  read(advisor);
  assert.equal(advisor.consumeNote(), null, `reset after ${tool}`);
}
// Search arg order is canonical; changed result fingerprints are new evidence.
{
  const advisor = new TokenEfficiencyAdvisor();
  other(advisor, 'search_files', { query: 'symbol', path: '.' }, 'hit:a.ts');
  other(advisor, 'search_files', { path: '.', query: 'symbol' }, 'hit:a.ts');
  other(advisor, 'search_files', { query: 'symbol', path: '.' }, 'hit:a.ts');
  assert.match(advisor.consumeNote(), /Repeated/);
  const novel = new TokenEfficiencyAdvisor();
  for (let i = 0; i < 10; i++) other(novel, 'search_files', { query: 'symbol' }, `hit:${i}`);
  assert.equal(novel.consumeNote(), null);
}
// Large result advisory leaves output intact, is cooldown-limited and capped.
{
  const advisor = new TokenEfficiencyAdvisor();
  const raw = 'x'.repeat(24_001);
  other(advisor, 'search_files', { query: 'large' }, raw);
  assert.match(advisor.consumeNote(), /large exploration result/);
  assert.equal(raw.length, 24_001);
  other(advisor, 'search_files', { query: 'large2' }, raw);
  assert.equal(advisor.consumeNote(), null);
  let emitted = 1;
  for (let i = 0; i < 100; i++) {
    other(advisor, 'search_files', { query: `large${i + 3}` }, raw);
    if (advisor.consumeNote()) emitted++;
  }
  assert.equal(emitted, 4, 'bounded note overhead');
}
assert.match(TOKEN_EFFICIENCY_PRINCIPLES.join('\n'), /Never omit required manual sections/);
assert.match(TOKEN_EFFICIENCY_PRINCIPLES.join('\n'), /Do not force a mutation/);

// Integration contract: one observer per run, raw evidence first, tail after batch.
const source = readFileSync(new URL('../core/src/agent/agent-run-step-loop.ts', import.meta.url), 'utf8');
assert.match(source, /const efficiencyAdvisor = new TokenEfficiencyAdvisor\(\)/);
assert.match(source, /recordToolEvidence\(state, execCall, rawEvidenceOutput\);\s*efficiencyAdvisor.observe\(evidenceRecord, rawEvidenceOutput\)/);
assert.match(source, /const efficiencyNote = efficiencyAdvisor.consumeNote\(\);\s*if \(efficiencyNote\) state.messages.push\(\{ role: 'system', content: efficiencyNote \}\)/);
const helpers = readFileSync(new URL('../core/src/agent/agent-run-helpers.ts', import.meta.url), 'utf8');
assert.match(helpers, /\.\.\.TOKEN_EFFICIENCY_PRINCIPLES/);
const registry = readFileSync(new URL('../core/src/agent/agent-tool-registry.ts', import.meta.url), 'utf8');
// MY Agent port: plugin + MCP merges go through shared helpers (mergePluginTools /
// mergeMcpTools) that both sync/async and by-pack getters call.
assert.match(registry, /mergeStableToolCatalog\(base, listEnabledPluginToolDefinitions\(cqrRoot\)\)/);
assert.match(registry, /mergeStableToolCatalog\(base, await listUserMcpToolDefinitions\(cqrRoot\)\)/);
assert.equal((registry.match(/return mergeMcpTools\(cqrRoot, base/g) ?? []).length, 2);
console.log('fixed tool catalog + token efficiency advisory: PASS');
