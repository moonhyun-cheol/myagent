#!/usr/bin/env node
/** Portable document/search sidecars, explicit MCP, SQLite embeddings, deploy parity. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
assert.equal(build.status, 0, build.error?.message || `build exited ${build.status}`);

for (const rel of [
  'tools/bootstrap-oss-sidecars.ps1',
  'tools/bootstrap-oss-sidecars-if-needed.ps1',
  'tools/requirements-oss-sidecars.txt',
  'core/config/defaults/mcp-catalog.json',
  'core/config/defaults/user-mcp-servers.default.json',
]) assert.ok(existsSync(path.join(root, rel)), rel);

const catalog = JSON.parse(readFileSync(path.join(root, 'core/config/defaults/mcp-catalog.json'), 'utf8'));
const defaults = JSON.parse(readFileSync(path.join(root, 'core/config/defaults/user-mcp-servers.default.json'), 'utf8'));
assert.deepEqual(catalog.servers, []);
assert.deepEqual(defaults.servers, []);

const { CODE_AGENT_TOOL_NAMES } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/agent-tool-definitions.js')).href
);
assert.ok(CODE_AGENT_TOOL_NAMES.includes('markitdown_convert'));
for (const removed of ['heavy_coder_edit', 'continue_context_pack', 'stagehand_probe']) {
  assert.equal(CODE_AGENT_TOOL_NAMES.includes(removed), false, removed);
}

const { loadMcpCatalog } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/mcp-catalog.js')).href
);
assert.deepEqual(loadMcpCatalog(root).servers, []);

const { resolveEmbeddingStoreKind, embeddingStoreBackend } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/index/embedding-sqlite-store.js')).href
);
assert.equal(resolveEmbeddingStoreKind({ MY_AGENT_EMBED_STORE: 'sqlite-vec' }), 'sqlite');
assert.equal(embeddingStoreBackend('sqlite'), 'sqlite');
assert.equal(embeddingStoreBackend('json'), 'json');

const { resolveBundledMarkitdownBinary, resolveBundledAstGrepBinary } = await import(
  pathToFileURL(path.join(root, 'core/dist/sidecars/oss-paths.js')).href
);
console.log(
  `OK catalog=0 markitdown=${resolveBundledMarkitdownBinary() || '(pending)'} ast-grep=${resolveBundledAstGrepBinary() || '(pending)'}`,
);
console.log('verify-oss-wave3: ok');
