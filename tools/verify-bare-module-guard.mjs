#!/usr/bin/env node
/**
 * Bare npm module read guard + edit_file→write_file schema heal goldens.
 * (Split out of the retired verify-domain-registry.mjs.)
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isBlockedBareModuleRead,
  looksLikeBareNpmModuleId,
} from '../core/dist/agent/agent-bare-module-guard.js';
import { applyToolSchemaCompat } from '../core/dist/agent/tool-schema-compat.js';
import { CODE_AGENT_TOOLS } from '../core/dist/agent/agent-tool-definitions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(looksLikeBareNpmModuleId('discord.js'), true);
assert.equal(looksLikeBareNpmModuleId('dotenv'), true);
assert.equal(looksLikeBareNpmModuleId('app.js'), false);
assert.equal(looksLikeBareNpmModuleId('src/index.js'), false);
assert.equal(isBlockedBareModuleRead(root, 'discord.js'), true);
assert.equal(isBlockedBareModuleRead(root, 'package.json'), false);

{
  const compat = applyToolSchemaCompat(
    {
      id: '1',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({
          path: 'README.md',
          new_text: '# hello\n\nfull rewrite body here\n',
        }),
      },
    },
    CODE_AGENT_TOOLS,
  );
  assert.equal(compat.toolCall.function.name, 'write_file');
  assert.equal(compat.reroutedFrom, 'edit_file');
  assert.equal(compat.validation.ok, true);
}

{
  const compat = applyToolSchemaCompat(
    {
      id: '2',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({
          path: 'a.js',
          old_text: '',
          new_text: 'console.log(1)\n',
        }),
      },
    },
    CODE_AGENT_TOOLS,
  );
  assert.equal(compat.toolCall.function.name, 'write_file', 'empty old_text → write');
  assert.equal(compat.validation.ok, true);
}

console.log('verify-bare-module-guard: ok');
