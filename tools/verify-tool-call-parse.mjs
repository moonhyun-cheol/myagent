/**
 * Smoke: tool_call payload normalization (OWUI/Ollama quirks).
 * node tools/verify-tool-call-parse.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { normalizeToolCallPayloads, describeToolProtocolFallback } = await import(
  pathToFileURL(path.join(root, 'core/dist/providers/openai-compatible.js')).href
);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('ok:', msg);
  }
}

{
  const withId = normalizeToolCallPayloads([
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
    },
  ]);
  assert(withId.length === 1 && withId[0].id === 'call_1', 'keeps id');
}

{
  // OWUI sometimes omits id
  const noId = normalizeToolCallPayloads([
    { type: 'function', function: { name: 'list_directory', arguments: '{}' } },
  ]);
  assert(noId.length === 1 && noId[0].function.name === 'list_directory', 'accepts missing id');
  assert(Boolean(noId[0].id), 'synthesizes id');
}

{
  // arguments as object
  const objArgs = normalizeToolCallPayloads([
    { function: { name: 'read_file', arguments: { path: 'x.ts' } } },
  ]);
  assert(objArgs[0].function.arguments.includes('x.ts'), 'stringifies object arguments');
}

{
  // flat name/arguments (some gateways)
  const flat = normalizeToolCallPayloads([{ name: 'search_files', arguments: '{"query":"foo"}' }]);
  assert(flat[0]?.function.name === 'search_files', 'flat name/arguments shape');
}

{
  assert(
    describeToolProtocolFallback('EMPTY_COMPLETION') === 'API tools 응답 비어 있음',
    'EMPTY label',
  );
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-tool-call-parse: all passed');
