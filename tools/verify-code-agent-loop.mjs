/**
 * Coding-loop smoke (P2): fixture repo → apply_patch → run_tests → git_commit(confirm).
 * Usage: node tools/verify-code-agent-loop.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cqrRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(cqrRoot, 'data', '_p2_loop_fixture');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

async function main() {
  const { executeAgentTool, normalizeToolCall } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/tools.js'))
  );

  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });

  writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'p2-loop-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node --test test/math.test.js' },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(fixtureRoot, 'math.js'),
    'export function add(a, b) {\n  return a - b; // intentional bug\n}\n',
  );
  mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, 'test/math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../math.js';",
      "test('add', () => { assert.equal(add(2, 3), 5); });",
      '',
    ].join('\n'),
  );

  git(fixtureRoot, ['init']);
  git(fixtureRoot, ['config', 'user.email', 'p2@cqr.local']);
  git(fixtureRoot, ['config', 'user.name', 'P2 Loop']);
  git(fixtureRoot, ['add', '-A']);
  git(fixtureRoot, ['commit', '-m', 'chore: seed fixture with failing test']);

  // 1) run_tests should fail (bug)
  const failOut = await executeAgentTool(
    fixtureRoot,
    normalizeToolCall({
      id: '1',
      type: 'function',
      function: { name: 'run_tests', arguments: '{}' },
    }),
  );
  const failDoc = JSON.parse(failOut.output);
  if (failDoc.ok) {
    fail('expected initial run_tests to fail');
    return;
  }
  console.log('OK run_tests detects failure');

  // 2) apply_patch fix
  const patchOut = await executeAgentTool(
    fixtureRoot,
    normalizeToolCall({
      id: '2',
      type: 'function',
      function: {
        name: 'apply_patch',
        arguments: JSON.stringify({
          files: [
            {
              path: 'math.js',
              edits: [{ old_text: 'return a - b; // intentional bug', new_text: 'return a + b;' }],
            },
          ],
        }),
      },
    }),
  );
  const patchDoc = JSON.parse(patchOut.output);
  if (!patchDoc.ok) {
    fail(`apply_patch failed: ${patchOut.output}`);
    return;
  }
  console.log('OK apply_patch');

  // 3) run_tests green
  const passOut = await executeAgentTool(
    fixtureRoot,
    normalizeToolCall({
      id: '3',
      type: 'function',
      function: { name: 'run_tests', arguments: '{}' },
    }),
  );
  const passDoc = JSON.parse(passOut.output);
  if (!passDoc.ok) {
    fail(`expected tests green after fix: ${passOut.output}`);
    return;
  }
  console.log('OK run_tests green');

  // 4) git_commit without confirm rejected
  const deny = await executeAgentTool(
    fixtureRoot,
    normalizeToolCall({
      id: '4',
      type: 'function',
      function: {
        name: 'git_commit',
        arguments: JSON.stringify({ message: 'fix: add', confirm: false }),
      },
    }),
  );
  if (JSON.parse(deny.output).ok) {
    fail('git_commit without confirm should fail');
    return;
  }
  console.log('OK git_commit requires confirm');

  // 5) git_commit with confirm
  const commitOut = await executeAgentTool(
    fixtureRoot,
    normalizeToolCall({
      id: '5',
      type: 'function',
      function: {
        name: 'git_commit',
        arguments: JSON.stringify({
          message: 'fix: add returns sum',
          confirm: true,
          paths: ['math.js'],
        }),
      },
    }),
  );
  const commitDoc = JSON.parse(commitOut.output);
  if (!commitDoc.ok || !commitDoc.commit) {
    fail(`git_commit failed: ${commitOut.output}`);
    return;
  }
  console.log('OK git_commit', commitDoc.commit);

  const body = readFileSync(path.join(fixtureRoot, 'math.js'), 'utf8');
  if (!body.includes('a + b')) {
    fail('math.js not fixed on disk');
    return;
  }

  console.log('PASS verify-code-agent-loop');
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function pathToFileUrl(p) {
  const resolved = path.resolve(p);
  return 'file:///' + resolved.replace(/\\/g, '/');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  try {
    if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
