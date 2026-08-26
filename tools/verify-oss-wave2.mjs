#!/usr/bin/env node
/** Wave 2: repomix / ast-grep sidecar tool registration (ADR-009). */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
assert.equal(build.status, 0, build.error?.message || `build exited ${build.status}`);

const { CODE_AGENT_TOOL_NAMES } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/agent-tool-definitions.js')).href
);

assert.ok(CODE_AGENT_TOOL_NAMES.includes('repomix_pack'));
assert.ok(CODE_AGENT_TOOL_NAMES.includes('ast_grep_search'));

console.log('verify-oss-wave2: ok');
