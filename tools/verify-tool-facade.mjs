#!/usr/bin/env node
/**
 * Public tool façade contract: tool names from definitions match tools.ts re-export surface.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  CODE_AGENT_TOOLS,
  CODE_AGENT_TOOL_NAMES,
  getCodeAgentToolNames,
  getCodeAgentTools,
  normalizeToolName,
  parseClientToolCalls,
  executeAgentTool,
} = await import('../core/dist/agent/tools.js');

const { CODE_AGENT_TOOLS: FROM_DEFS } = await import(
  '../core/dist/agent/agent-tool-definitions.js'
);

const defNames = FROM_DEFS.map((t) => t.function.name);

assert.equal(CODE_AGENT_TOOLS.length, defNames.length, 'TOOLS length vs definitions');
assert.deepEqual(
  CODE_AGENT_TOOLS.map((t) => t.function.name),
  defNames,
  'TOOLS order/names vs definitions module',
);
assert.deepEqual(CODE_AGENT_TOOL_NAMES, defNames);

const names = getCodeAgentToolNames(root);
assert.ok(names.includes('read_file') && names.includes('apply_patch'));
assert.ok(typeof getCodeAgentTools === 'function');
assert.equal(normalizeToolName('Read_File'), 'read_file');
assert.ok(Array.isArray(parseClientToolCalls('TOOL_CALL: {"name":"list_directory","arguments":{}}')));
{
  // Live slip from order-tracker probe: no colon + flat {tool,path}
  const flat = parseClientToolCalls(
    '먼저 읽겠습니다.\nTOOL_CALL {"tool":"read_file","path":"data/seed.json"}',
  );
  assert.equal(flat.length, 1, 'flat TOOL_CALL without colon');
  assert.equal(flat[0].function.name, 'read_file');
  assert.equal(JSON.parse(flat[0].function.arguments).path, 'data/seed.json');
}
assert.equal(typeof executeAgentTool, 'function');

const facade = readFileSync(path.join(root, 'core/src/agent/tools.ts'), 'utf8');
assert.match(facade, /Compatibility facade/);
assert.match(facade, /agent-tool-registry/);
assert.match(facade, /agent-tool-normalize/);
assert.match(facade, /agent-tool-execute/);
assert.ok(!/export const CODE_AGENT_TOOLS:\s*AgentToolDefinition\[]\s*=\s*\[/.test(facade));

console.log(`verify-tool-facade: ok (tools=${defNames.length})`);
