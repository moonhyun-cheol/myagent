#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const root = process.cwd();
const cache = await import(pathToFileURL(path.join(root, 'core/dist/providers/prompt-context-cache.js')).href);
const compatible = await import(pathToFileURL(path.join(root, 'core/dist/providers/openai-compatible.js')).href);
const embedding = await import(pathToFileURL(path.join(root, 'core/dist/agent/index/embedding-hit-dedupe.js')).href);
const readCache = await import(pathToFileURL(path.join(root, 'core/dist/agent/agent-read-through-cache.js')).href);

cache.clearPromptContextCache();
assert.deepEqual(cache.promptContextCacheStats(), { entries: 0, max_entries: 128 });

const userText = '  preserve exact user text\n  including spaces  ';
const toolsA = [
  { type: 'function', function: { parameters: { type: 'object' }, name: 'z_tool', description: 'Z' } },
  { function: { description: 'A', name: 'a_tool', parameters: { properties: {}, type: 'object' } }, type: 'function' },
  { type: 'function', function: { parameters: { type: 'object' }, name: 'z_tool', description: 'Z' } },
];
const first = cache.compilePromptContext([
  { role: 'system', content: ' stable rules  \r\n' },
  { role: 'system', content: 'stable rules' },
  { role: 'user', content: userText },
], toolsA);
assert.equal(first.metadata.local_cache_hit, false);
assert.equal(first.metadata.duplicate_system_blocks_removed, 1);
assert.equal(first.metadata.duplicate_tools_removed, 1);
assert.equal(first.messages.at(-1).content, userText);
assert.deepEqual(first.tools.map((tool) => tool.function.name), ['a_tool', 'z_tool']);

const second = cache.compilePromptContext([
  { role: 'system', content: 'stable rules' },
  { role: 'user', content: userText },
], [toolsA[1], toolsA[0]]);
assert.equal(second.metadata.prefix_hash, first.metadata.prefix_hash);
assert.equal(second.metadata.local_cache_hit, true);

const deduped = embedding.dedupeEmbeddingHits([
  { path: 'a.ts', startLine: 1, endLine: 5, preview: 'same body', score: 0.9, engine: 'local-hashed-tf' },
  { path: 'a.ts', startLine: 6, endLine: 9, preview: 'other', score: 0.8, engine: 'local-hashed-tf' },
  { path: 'copy.ts', startLine: 1, endLine: 5, preview: ' same   body ', score: 0.7, engine: 'local-hashed-tf' },
  { path: 'b.ts', startLine: 1, endLine: 5, preview: 'unique', score: 0.6, engine: 'local-hashed-tf' },
], 8);
assert.deepEqual(deduped.map((hit) => hit.path), ['a.ts', 'b.ts']);

const cleanPcRoot = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-clean-pc-'));
const cleanWorkspace = path.join(cleanPcRoot, 'workspace');
const cleanApp = path.join(cleanPcRoot, 'app');
mkdirSync(cleanWorkspace, { recursive: true });
mkdirSync(cleanApp, { recursive: true });
writeFileSync(path.join(cleanWorkspace, 'facts.txt'), 'alpha\nbeta\ngamma', 'utf8');
const readCall = (args) => readCache.readWorkspaceFileThroughCache({
  cqrRoot: cleanApp,
  workspaceRoot: cleanWorkspace,
  relPath: args.path,
  fresh: args.fresh,
  startLine: args.start_line,
  endLine: args.end_line,
});
try {
  const firstRead = readCall({ path: 'facts.txt', start_line: 2, end_line: 2 });
  assert.equal(firstRead.cache, 'miss');
  assert.deepEqual([firstRead.start_line, firstRead.end_line, firstRead.total_lines], [2, 2, 3]);
  assert.equal(firstRead.text, 'beta');
  const secondRead = readCall({ path: 'facts.txt', start_line: 2, end_line: 2 });
  assert.equal(secondRead.cache, 'hit');

  writeFileSync(path.join(cleanWorkspace, 'facts.txt'), 'alpha\nbeta-2\ngamma', 'utf8');
  readCache.invalidateWorkspaceReadCache(cleanApp, cleanWorkspace, 'facts.txt');
  const afterToolWrite = readCall({ path: 'facts.txt', start_line: 2, end_line: 2 });
  assert.equal(afterToolWrite.cache, 'miss');
  assert.equal(afterToolWrite.text, 'beta-2');

  writeFileSync(path.join(cleanWorkspace, 'facts.txt'), 'alpha\nBETA!\ngamma', 'utf8');
  const externallyChanged = readCall({ path: 'facts.txt', start_line: 2, end_line: 2 });
  assert.equal(externallyChanged.cache, 'miss');
  assert.equal(externallyChanged.text, 'BETA!');

  const forcedFresh = readCall({ path: 'facts.txt', fresh: true });
  assert.equal(forcedFresh.cache, 'bypass');
  const cacheFiles = readdirSync(path.join(cleanApp, 'data', 'cache', 'tool-reads-v1'));
  assert.ok(cacheFiles.some((name) => name.endsWith('.json')));
  assert.ok(!cacheFiles.some((name) => /sqlite|\.db$/i.test(name)));
  const executorSource = readFileSync(path.join(root, 'core/src/agent/agent-tool-execute.ts'), 'utf8');
  assert.match(executorSource, /readWorkspaceFileThroughCache/);
  assert.match(executorSource, /invalidateWorkspaceReadCache/);
} finally {
  rmSync(cleanPcRoot, { recursive: true, force: true });
}

const originalAnthropicFetch = globalThis.fetch;
let anthropicBody;
globalThis.fetch = async (_url, init) => {
  anthropicBody = JSON.parse(String(init.body));
  return new Response(JSON.stringify({
    id: 'msg_test',
    model: 'claude-test',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 5,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 20,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const result = await compatible.chatCompletion(
    'https://anthropic.test/v1',
    'test-key',
    'claude-test',
    [{ role: 'system', content: 'stable rules' }, { role: 'user', content: 'hello' }],
    { wireApi: 'messages' },
  );
  assert.deepEqual(anthropicBody.cache_control, { type: 'ephemeral' });
  assert.equal(result.usage.cached_tokens, 20);
  assert.equal(result.usage.cache_write_tokens, 80);
} finally {
  globalThis.fetch = originalAnthropicFetch;
}

console.log('cache pipeline: stable prefix, RAG candidate dedupe, persistent verified reads, Anthropic usage PASS');
