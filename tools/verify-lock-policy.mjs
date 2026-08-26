#!/usr/bin/env node
// Golden: the verify concurrency lock. It exists because two interleaved runs wiped the
// user's provider-keys/user-overrides (shared .verify-backup) and collided on ports
// 10293-10299. It must refuse a live peer, self-heal a dead pid, and say how long the
// peer has been running so a refusal is not mistaken for a stuck lock.
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const {
  readLock,
  evaluateLock,
  refusalMessage,
  releaseVerifyLock,
  acquireVerifyLock,
  pidAlive,
} = await import(pathToFileURL(path.join(repo, 'tools', 'verify-lock.mjs')).href);

const scratchRoot = path.join(repo, 'data', 'outputs', 'verify-lock-policy');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, 'run-'));

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const DEAD_PID = 0x7ffffffe; // never a live pid
check('pidAlive(self) is true', pidAlive(process.pid) === true);
check('pidAlive(dead) is false', pidAlive(DEAD_PID) === false);

// --- readLock parsing ---
const lockPath = path.join(scratch, '.verify.lock');
writeFileSync(lockPath, '1234 1700000000000');
check('readLock parses pid + startedAt', readLock(lockPath).pid === 1234 && readLock(lockPath).startedAt === 1700000000000);
writeFileSync(lockPath, '4321');
check('readLock accepts legacy bare pid', readLock(lockPath).pid === 4321 && readLock(lockPath).startedAt === null);
writeFileSync(lockPath, 'garbage');
check('readLock rejects garbage', readLock(lockPath).pid === null);
rmSync(lockPath, { force: true });
check('readLock on missing file is null', readLock(lockPath).pid === null);

// --- evaluateLock policy ---
const now = 1_000_000_000;
check(
  'live peer refuses',
  evaluateLock({ pid: process.pid + 0, startedAt: now - 180_000 }, process.pid + 1, now).action === 'refuse',
);
check(
  'refusal reports elapsed minutes',
  evaluateLock({ pid: process.pid, startedAt: now - 180_000 }, process.pid + 1, now).elapsedMinutes === 3,
);
check(
  'legacy lock without startedAt refuses with null elapsed',
  evaluateLock({ pid: process.pid, startedAt: null }, process.pid + 1, now).elapsedMinutes === null,
);
check('dead peer is cleared as stale', evaluateLock({ pid: DEAD_PID, startedAt: now }, process.pid, now).action === 'clear-stale');
check('own pid acquires', evaluateLock({ pid: process.pid, startedAt: now }, process.pid, now).action === 'acquire');
check('empty lock acquires', evaluateLock({ pid: null, startedAt: null }, process.pid, now).action === 'acquire');

// --- refusal message content ---
const msg = refusalMessage(
  { action: 'refuse', pid: 36336, elapsedMinutes: 3 },
  'data/logs/.verify.lock',
).join('\n');
check('message names the pid', msg.includes('pid 36336'));
check('message states elapsed time', msg.includes('3 min so far'));
check('message says nothing was changed', msg.includes('nothing was changed'));
check('message gives the stale-lock escape', msg.includes('data/logs/.verify.lock'));

// --- acquire / release round trip on an isolated path ---
acquireVerifyLock(lockPath, { root: scratch, log: { error: () => {}, log: () => {} } });
check('acquire writes the lock', existsSync(lockPath));
check('lock records our pid', readLock(lockPath).pid === process.pid);
check('lock records a startedAt', typeof readLock(lockPath).startedAt === 'number');

// A stale lock must be taken over, not refused.
writeFileSync(lockPath, `${DEAD_PID} ${Date.now() - 600_000}`);
let staleLogged = '';
acquireVerifyLock(lockPath, {
  root: scratch,
  log: { error: () => {}, log: (m) => { staleLogged += String(m); } },
});
check('stale lock is taken over', readLock(lockPath).pid === process.pid);
check('stale takeover is logged', /clearing stale lock/.test(staleLogged), staleLogged);

// Release only removes our own lock.
writeFileSync(lockPath, `${DEAD_PID} ${Date.now()}`);
releaseVerifyLock(lockPath);
check("release leaves another pid's lock alone", existsSync(lockPath));
writeFileSync(lockPath, `${process.pid} ${Date.now()}`);
releaseVerifyLock(lockPath);
check('release removes our own lock', !existsSync(lockPath));
releaseVerifyLock(lockPath);
check('release on missing lock is a no-op', !existsSync(lockPath));

rmSync(scratchRoot, { recursive: true, force: true });

if (failed > 0) {
  console.error(`verify-lock-policy FAILED (${failed})`);
  process.exit(1);
}
console.log('verify-lock-policy OK');
