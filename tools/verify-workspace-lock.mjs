#!/usr/bin/env node
/**
 * Workspace lock: child-folder bind + sidecar porcelain must not list sibling dirs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
assert.equal(build.status, 0, build.error?.message || `build exited ${build.status}`);

const {
  isProjectBag,
  resolveTurnWorkspaceLock,
} = await import(pathToFileURL(path.join(root, 'core/dist/agent/agent-workspace-lock.js')).href);
const { parseGitPorcelainFileMutations } = await import(
  pathToFileURL(path.join(root, 'core/dist/sidecars/sidecar-mutations.js')).href
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cqr-wslock-'));
try {
  const bag = path.join(tmp, 'app');
  fs.mkdirSync(path.join(bag, 'amazon-cq-code'), { recursive: true });
  fs.mkdirSync(path.join(bag, 'my_agent'), { recursive: true });
  fs.mkdirSync(path.join(bag, 'full page screenshot'), { recursive: true });
  fs.mkdirSync(path.join(bag, 'vari6'), { recursive: true });
  fs.writeFileSync(path.join(bag, 'amazon-cq-code', 'package.json'), '{"name":"a"}\n');
  fs.writeFileSync(path.join(bag, 'my_agent', 'package.json'), '{"name":"cqr"}\n');
  fs.writeFileSync(path.join(bag, 'full page screenshot', 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(bag, 'vari6', 'package.json'), '{"name":"v"}\n');
  fs.writeFileSync(path.join(bag, 'notes.txt'), 'x\n');

  assert.equal(isProjectBag(bag), true);

  const pick = resolveTurnWorkspaceLock({
    sessionRoot: bag,
  });
  assert.equal(pick.status, 'session', JSON.stringify(pick));
  assert.equal(pick.narrowed, false);

  const named = resolveTurnWorkspaceLock({
    sessionRoot: bag,
    pathHint: path.join(bag, 'full page screenshot'),
  });
  assert.equal(named.status, 'path');
  assert.equal(named.matchedName, 'full page screenshot');
  assert.equal(path.basename(named.targetRoot), 'full page screenshot');

  const reuse = resolveTurnWorkspaceLock({
    sessionRoot: bag,
  });
  assert.equal(reuse.status, 'session');
  assert.equal(reuse.targetRoot, path.resolve(bag));

  const porcelain = [
    '?? amazon-cq-code/',
    '?? my_agent/',
    '?? full page screenshot/',
    '?? notes.txt',
    ' M notes.txt',
  ].join('\n');
  const files = parseGitPorcelainFileMutations(porcelain, bag);
  assert.deepEqual(files, ['notes.txt']);
  assert.ok(!files.some((p) => /my_agent|amazon|full page/i.test(p)));

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-workspace-lock (structured path only): ok');
