#!/usr/bin/env node
// Golden: checkpoint housekeeping. Two guarantees:
//   1. explicit paths pointing into runtime dirs (data/, node_modules) are never snapshotted
//      — this is what recursively nested data/agent-checkpoints into 310-char paths;
//   2. sweepCheckpoints prunes by age, per-session keep, and a global size cap.
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const mod = await import(
  pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'agent-checkpoint.js')).href
);
const {
  createWorkspaceCheckpoint,
  isRuntimeCheckpointPath,
  sweepCheckpoints,
  resolveCheckpointSweepPolicy,
} = mod;

const scratchRoot = path.join(repo, 'data', 'outputs', 'verify-checkpoint-sweep');
mkdirSync(scratchRoot, { recursive: true });
const cqrRoot = mkdtempSync(path.join(scratchRoot, 'run-'));

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- Part 1: runtime-path guard ---
for (const p of [
  'data/agent-checkpoints/x/files/a.txt',
  'node_modules/pkg/index.js',
  'core/dist/main.js',
  'runtime/node/node.exe',
]) {
  check(`isRuntimeCheckpointPath blocks ${p}`, isRuntimeCheckpointPath(p) === true);
}
for (const p of ['core/src/agent/agent-checkpoint.ts', 'tools/verify.mjs', 'README.md']) {
  check(`isRuntimeCheckpointPath allows ${p}`, isRuntimeCheckpointPath(p) === false);
}

// A workspace whose root IS the cqrRoot (self-editing) with a real file + a data/ file.
const wsRoot = cqrRoot;
mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
writeFileSync(path.join(wsRoot, 'src', 'keep.ts'), 'export const keep = 1;\n', 'utf8');
mkdirSync(path.join(wsRoot, 'data', 'vault'), { recursive: true });
writeFileSync(path.join(wsRoot, 'data', 'vault', 'secret.json'), '{"k":"v"}\n', 'utf8');

const meta = createWorkspaceCheckpoint(wsRoot, cqrRoot, {
  sessionKey: 'guard-test',
  label: 'guard',
  paths: ['src/keep.ts', 'data/vault/secret.json', 'data/agent-checkpoints/prev/files/x.ts'],
});
check('checkpoint saves the real src file', meta.paths.includes('src/keep.ts'));
check(
  'checkpoint drops data/ paths',
  !meta.paths.some((p) => p.startsWith('data/')),
  JSON.stringify(meta.paths),
);
check('checkpoint fileCount is 1', meta.fileCount === 1, `count=${meta.fileCount}`);

// --- Part 2: sweep by age / keep / size ---
const ckptRoot = path.join(cqrRoot, 'data', 'agent-checkpoints');

function seedSession(sessionKey, checkpoints) {
  // checkpoints: [{ ageDays, bytes }]
  const dir = path.join(ckptRoot, sessionKey);
  checkpoints.forEach((c, i) => {
    const id = `${sessionKey}-${i}`;
    const filesDir = path.join(dir, id, 'files');
    mkdirSync(filesDir, { recursive: true });
    const createdAt = new Date(Date.now() - c.ageDays * 86400000).toISOString();
    writeFileSync(
      path.join(dir, id, 'meta.json'),
      JSON.stringify({ id, createdAt, workspaceRoot: wsRoot, fileCount: 1, paths: ['f'] }),
      'utf8',
    );
    writeFileSync(path.join(filesDir, 'blob.bin'), Buffer.alloc(c.bytes, 1));
  });
}

// Clean the guard-test session so counts are predictable.
rmSync(ckptRoot, { recursive: true, force: true });

seedSession('fresh', [
  { ageDays: 0, bytes: 1000 },
  { ageDays: 0, bytes: 1000 },
]);
seedSession('stale', [{ ageDays: 30, bytes: 1000 }]); // older than 7d → whole session dropped
seedSession('overkeep', Array.from({ length: 9 }, (_, i) => ({ ageDays: i * 0.01, bytes: 1000 })));

const policy = { maxAgeMs: 7 * 86400000, keepPerSession: 5, maxTotalBytes: 100 * 1024 * 1024 };
const res = sweepCheckpoints(cqrRoot, policy);

check('stale session removed', !existsSync(path.join(ckptRoot, 'stale')));
check('fresh session kept', existsSync(path.join(ckptRoot, 'fresh')));
check(
  'overkeep trimmed to keepPerSession',
  existsSync(path.join(ckptRoot, 'overkeep')) &&
    readdirSync(path.join(ckptRoot, 'overkeep')).length === 5,
  `count=${existsSync(path.join(ckptRoot, 'overkeep')) ? readdirSync(path.join(ckptRoot, 'overkeep')).length : 'gone'}`,
);
check('reported removedSessions >= 1', res.removedSessions >= 1, `n=${res.removedSessions}`);
check('reported removedCheckpoints >= 4', res.removedCheckpoints >= 4, `n=${res.removedCheckpoints}`);

// --- Part 3: global size cap drops oldest sessions first ---
rmSync(ckptRoot, { recursive: true, force: true });
seedSession('old-big', [{ ageDays: 2, bytes: 6 * 1024 * 1024 }]);
seedSession('new-big', [{ ageDays: 0, bytes: 6 * 1024 * 1024 }]);
const capPolicy = { maxAgeMs: 7 * 86400000, keepPerSession: 5, maxTotalBytes: 8 * 1024 * 1024 };
const capRes = sweepCheckpoints(cqrRoot, capPolicy);
check('size cap drops the older session', !existsSync(path.join(ckptRoot, 'old-big')));
check('size cap keeps the newer session', existsSync(path.join(ckptRoot, 'new-big')));
check('remaining under budget', capRes.remainingBytes <= capPolicy.maxTotalBytes, `bytes=${capRes.remainingBytes}`);

// --- Part 4: env policy defaults ---
const def = resolveCheckpointSweepPolicy({});
check('default maxAge is 7 days', def.maxAgeMs === 7 * 86400000);
check('default keep is 5', def.keepPerSession === 5);
check('default cap is 200MB', def.maxTotalBytes === 200 * 1024 * 1024);
const tuned = resolveCheckpointSweepPolicy({
  MY_AGENT_CHECKPOINT_MAX_AGE_DAYS: '3',
  MY_AGENT_CHECKPOINT_KEEP: '2',
  MY_AGENT_CHECKPOINT_MAX_MB: '50',
});
check(
  'env overrides apply',
  tuned.maxAgeMs === 3 * 86400000 && tuned.keepPerSession === 2 && tuned.maxTotalBytes === 50 * 1024 * 1024,
);

rmSync(scratchRoot, { recursive: true, force: true });

if (failed > 0) {
  console.error(`verify-checkpoint-sweep FAILED (${failed})`);
  process.exit(1);
}
console.log('verify-checkpoint-sweep OK');
