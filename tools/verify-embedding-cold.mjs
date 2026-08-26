/**
 * Cold embedding index golden — empty/min workspace → 0 hits + empty-retrieval hint.
 * Usage: node tools/verify-embedding-cold.mjs
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cold = path.join(root, 'data', '_skill_tool_lab', 'cold-embed');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`OK: ${msg}`);
}

if (!existsSync(path.join(root, 'core/dist/agent/tools.js'))) {
  fail('build first: node tools/build.mjs');
}

const { executeAgentTool } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
);
const { formatEmptyRetrievalHint } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/tool-self-correction.js')).href
);

if (existsSync(cold)) rmSync(cold, { recursive: true, force: true });
mkdirSync(cold, { recursive: true });
// Intentionally no source files — cold workspace index should be empty or near-empty.
writeFileSync(path.join(cold, 'README.md'), '# empty\n', 'utf8');

const call = {
  id: 'cold_embed',
  type: 'function',
  function: {
    name: 'search_embeddings',
    arguments: JSON.stringify({ query: 'nonexistent_symbol_xyz_cold' }),
  },
};

const res = await executeAgentTool(
  cold,
  call,
  { allowNas: false },
  { cqrRoot: root, sessionId: 'lab_cold_embed' },
);
const out = String(res.output || '');

let count = null;
try {
  const j = JSON.parse(out.split('\n\n')[0] || out);
  count = j.count;
} catch {
  /* fall through */
}

if (count == null) {
  const m = out.match(/"count"\s*:\s*(\d+)/);
  count = m ? Number(m[1]) : null;
}
if (count == null) fail(`could not parse count from output:\n${out.slice(0, 400)}`);
if (count !== 0) fail(`expected cold count=0, got ${count}`);

const hintSample = formatEmptyRetrievalHint('search_embeddings', 'q', []);
if (!/0 hits/i.test(hintSample)) fail('formatEmptyRetrievalHint shape');
if (!/Empty retrieval/i.test(out) && !/0 hits/i.test(out)) {
  fail(`expected empty-retrieval hint in tool output:\n${out.slice(0, 500)}`);
}
if (/ERROR:/i.test(out) && !/BARE_MODULE/i.test(out)) {
  // hard ERROR is not the cold empty path
  fail(`cold embed should soft-hint, not hard ERROR:\n${out.slice(0, 300)}`);
}

ok('cold search_embeddings count=0 + empty hint');
console.log('verify-embedding-cold: ok');
