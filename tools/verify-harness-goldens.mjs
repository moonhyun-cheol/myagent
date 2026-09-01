#!/usr/bin/env node
/** Offline goldens for current checklist and path guard contracts. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTaskChecklist,
  retrievalToolsUsed,
} from '../core/dist/agent/agent-task-checklist.js';
import { isBlockedBareModuleRead } from '../core/dist/agent/agent-bare-module-guard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checklist = buildTaskChecklist(
  '리팩토링: adapters/example.js 필드 normalize 포함; delivery 경로 유지.',
);
assert.equal(checklist.labels.includes('structural split'), false);
assert.equal(retrievalToolsUsed(['read_file'], checklist), false);
assert.equal(retrievalToolsUsed(['search_files'], checklist), true);

assert.equal(isBlockedBareModuleRead(root, 'discord.js'), true);
assert.equal(isBlockedBareModuleRead(root, 'src/lib/date.js'), false);

console.log('verify-harness-goldens: ok');
