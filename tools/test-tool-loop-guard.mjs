#!/usr/bin/env node
/**
 * Smoke test for code-agent tool-loop guard + schema compat.
 * node tools/test-tool-loop-guard.mjs
 */
import { applyToolSchemaCompat } from '../core/dist/agent/tool-schema-compat.js';
import {
  createToolLoopGuard,
  formatLoopGuardStop,
  formatLoopGuardUserMessage,
  formatSoftExplorationLoopCorrection,
  isSoftLoopGuardStop,
} from '../core/dist/agent/tool-loop-guard.js';
import { CODE_AGENT_TOOLS } from '../core/dist/agent/tools.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('ok:', msg);
  }
}

// edit_file missing old_text → write_file reroute
{
  const compat = applyToolSchemaCompat(
    {
      id: 't1',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({ filePath: 'a.py', newString: 'print(1)\n' }),
      },
    },
    CODE_AGENT_TOOLS,
  );
  assert(compat.toolCall.function.name === 'write_file', 'edit→write reroute');
  assert(compat.validation.ok, 'write_file validation ok');
}

// invalid write_file → repair hint
{
  const compat = applyToolSchemaCompat(
    {
      id: 't2',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.py' }) },
    },
    CODE_AGENT_TOOLS,
  );
  assert(!compat.validation.ok, 'write missing content fails');
  assert(Boolean(compat.validation.repairHint), 'repair hint present');
}

// loop guard blocks repeated identical errors
{
  process.env.MY_AGENT_TOOL_LOOP_MAX_REPEAT = '2';
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.py', content: '' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ERROR: write_file requires non-empty content' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'c2',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.py', content: '' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'c2', content: 'ERROR: write_file requires non-empty content' },
  ];
  const guard = createToolLoopGuard(messages);
  const next = {
    id: 'c3',
    type: 'function',
    function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.py', content: '' }) },
  };
  const decision = guard.admit(next);
  assert(decision.triggered, 'loop guard triggers on 3rd identical write error');
  assert(formatLoopGuardStop(decision).includes('TOOL_LOOP_GUARD'), 'stop message format');
  delete process.env.MY_AGENT_TOOL_LOOP_MAX_REPEAT;
}

// edit_file failures on the same path switch tactic after two failures, even if args differ
{
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'e1',
        type: 'function',
        function: {
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'scripts/serve.mjs', old_text: 'old-1', new_text: 'new-1' }),
        },
      }],
    },
    { role: 'tool', tool_call_id: 'e1', content: 'ERROR: old_text not found' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'e2',
        type: 'function',
        function: {
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'scripts/serve.mjs', old_text: 'old-2', new_text: 'new-2' }),
        },
      }],
    },
    { role: 'tool', tool_call_id: 'e2', content: 'ERROR: old_text not found' },
  ];
  const guard = createToolLoopGuard(messages);
  const next = {
    id: 'e3',
    type: 'function',
    function: {
      name: 'edit_file',
      arguments: JSON.stringify({ path: 'scripts/serve.mjs', old_text: 'old-3', new_text: 'new-3' }),
    },
  };
  const decision = guard.admit(next);
  assert(decision.triggered, '3rd same-path edit_file failure blocked');
  assert(isSoftLoopGuardStop(decision), 'edit_file failure loop changes tactic without abort');
  const correction = formatSoftExplorationLoopCorrection(decision, 'edit_file');
  assert(correction.includes('write_file'), 'edit failure correction forces whole-file fallback');
  assert(correction.includes('Do NOT call edit_file again'), 'edit failure correction forbids retry');
}

// Legacy JSON {ok:false} edit_file payloads still count as failures (pre-ERROR normalize)
{
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'j1',
        type: 'function',
        function: {
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'public/app.js', old_text: 'a', new_text: 'b' }),
        },
      }],
    },
    { role: 'tool', tool_call_id: 'j1', content: '{"ok":false,"message":"old_text not found (exact+fuzzy)"}' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'j2',
        type: 'function',
        function: {
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'public/app.js', old_text: 'c', new_text: 'd' }),
        },
      }],
    },
    { role: 'tool', tool_call_id: 'j2', content: '{"ok":false,"message":"old_text not found (exact+fuzzy)"}' },
  ];
  const guard = createToolLoopGuard(messages);
  const next = {
    id: 'j3',
    type: 'function',
    function: {
      name: 'edit_file',
      arguments: JSON.stringify({ path: 'public/app.js', old_text: 'e', new_text: 'f' }),
    },
  };
  const decision = guard.admit(next);
  assert(decision.triggered, 'JSON ok:false same-path edit_file blocked on 3rd');
  assert(isSoftLoopGuardStop(decision), 'JSON edit fail stays soft');
}

// Identical successful read_file must block on 2nd call (was unknown → *5 = 15)
{
  const pathArgs = JSON.stringify({ path: 'ui/workspace/src/components/EditorPane.tsx' });
  const body = 'export function EditorPane() { return null; }\n'.repeat(20);
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'r1',
        type: 'function',
        function: { name: 'read_file', arguments: pathArgs },
      }],
    },
    { role: 'tool', tool_call_id: 'r1', content: body },
  ];
  const guard = createToolLoopGuard(messages);
  const next = {
    id: 'r2',
    type: 'function',
    function: { name: 'read_file', arguments: pathArgs },
  };
  const decision = guard.admit(next);
  assert(decision.triggered, '2nd identical successful read_file blocked');
  assert(decision.errorClass === 'success', 'read_file body classified as success');
  assert(formatLoopGuardStop(decision).includes('edit_file'), 'mutate hint on read loop');
  assert(isSoftLoopGuardStop(decision), 'success loop is soft (do not abort run)');
  assert(
    formatLoopGuardUserMessage(decision).includes('실패가 아님'),
    'user message distinguishes success re-read from failure',
  );
}

// Identical successful search_files must soft-block with read→mutate instructions
{
  const args = JSON.stringify({ query: 'news', path: '.' });
  const hits = 'server.py:33:def get_news(...)\napp.js: (no match)\n';
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 's1',
        type: 'function',
        function: { name: 'search_files', arguments: args },
      }],
    },
    { role: 'tool', tool_call_id: 's1', content: hits },
  ];
  const guard = createToolLoopGuard(messages);
  const next = {
    id: 's2',
    type: 'function',
    function: { name: 'search_files', arguments: args },
  };
  const decision = guard.admit(next);
  assert(decision.triggered, '2nd identical successful search_files blocked');
  assert(decision.errorClass === 'success', 'search hits classified as success');
  assert(isSoftLoopGuardStop(decision), 'search success loop is soft');
  const soft = formatSoftExplorationLoopCorrection(decision, 'search_files');
  assert(soft.includes('read_file'), 'soft correction steers to read_file');
  assert(soft.includes('do not show to user'), 'soft correction forbids dumping to user');
  assert(formatLoopGuardStop(decision).includes('Search hits'), 'stop hint mentions search hits');

  // Soft TOOL_LOOP_GUARD noteResult must stay success (not flip to validation → re-allow search)
  guard.noteResult(next, soft);
  const third = {
    id: 's3',
    type: 'function',
    function: { name: 'search_files', arguments: args },
  };
  const again = guard.admit(third);
  assert(again.triggered, '3rd identical search stays blocked after soft TOOL_LOOP_GUARD note');
  assert(again.errorClass === 'success', 'soft guard note keeps success class');
}

// Within one step: first explore admits as unknown, but 2nd identical must still soft-block
{
  const args = JSON.stringify({ query: 'news', path: '.' });
  const guard = createToolLoopGuard([]);
  const call1 = {
    id: 'w1',
    type: 'function',
    function: { name: 'search_files', arguments: args },
  };
  const first = guard.admit(call1);
  assert(!first.triggered, 'first search_files in empty step allowed');
  guard.noteResult(call1, 'server.py:1: news helper\n');
  const call2 = {
    id: 'w2',
    type: 'function',
    function: { name: 'search_files', arguments: args },
  };
  const second = guard.admit(call2);
  assert(second.triggered, '2nd identical search in same step blocked after success note');
  assert(second.errorClass === 'success', 'same-step re-search uses success class');
  assert(isSoftLoopGuardStop(second), 'same-step re-search is soft');
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tool-loop guard tests passed');
