#!/usr/bin/env node
/** Smoke: capabilities come from the registered tool schema, not prose classifiers. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_AGENT_TOOLS } from '../core/dist/agent/tools.js';
import {
  contentLooksLikeToolMimic,
} from '../core/dist/agent/tool-content-guards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(existsSync(path.join(root, 'core/src/agent/agent-capability-policy.ts')), false);
assert.equal(existsSync(path.join(root, 'core/src/agent/agent-surface-plane.ts')), false);

const names = new Set(CODE_AGENT_TOOLS.map(tool => tool.function.name));
for (const required of ['read_file', 'search_files', 'run_terminal', 'apply_patch']) {
  assert.equal(names.has(required), true, `registered capability missing: ${required}`);
}

assert.equal(contentLooksLikeToolMimic('TOOL_CALL: {"name":"read_file"}'), true);

console.log('verify-capability-policy: ok (schema-directed capabilities)');
