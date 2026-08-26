// Concurrency lock for `npm run verify`.
//
// Two concurrent runs share one `.verify-backup` dir and the fixed 10293-10299 ports.
// The second run's restore deleted the first run's snapshot, so the outer run then wiped
// the user's provider keys and user-overrides — plus phase4 died on EADDRINUSE.
// Refuse to interleave instead.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A full verify run is ~8-9 min; used only for the "wait then retry" hint. */
export const TYPICAL_RUN_MINUTES = 9;

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `pid startedAtMs` since v1.2.4; a bare `pid` from older runs still parses. */
export function readLock(lockPath) {
  try {
    const [pidRaw, startedRaw] = readFileSync(lockPath, 'utf8').trim().split(/\s+/);
    const pid = Number(pidRaw);
    const startedAt = Number(startedRaw);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
    };
  } catch {
    return { pid: null, startedAt: null };
  }
}

/**
 * Decide without touching the filesystem, so the policy is testable.
 * Returns `{ action: 'acquire' }`, `{ action: 'clear-stale', pid }`, or
 * `{ action: 'refuse', pid, elapsedMinutes }`.
 */
export function evaluateLock(lock, selfPid, now = Date.now()) {
  const { pid, startedAt } = lock;
  if (!pid || pid === selfPid) return { action: 'acquire' };
  if (!pidAlive(pid)) return { action: 'clear-stale', pid };
  return {
    action: 'refuse',
    pid,
    elapsedMinutes: startedAt === null ? null : Math.round((now - startedAt) / 60_000),
  };
}

export function refusalMessage(decision, lockPathForHint) {
  const forPart =
    decision.elapsedMinutes === null ? '' : `, ${decision.elapsedMinutes} min so far`;
  return [
    `verify is already running (pid ${decision.pid}${forPart}).`
    + ' Running two verifies at once corrupts the vault snapshot and collides on ports'
    + ' 10293-10299, so this run was refused — nothing was changed.',
    `A full run takes ~${TYPICAL_RUN_MINUTES} min. Wait for it to finish, then retry.`
    + ` If that pid is gone, delete ${lockPathForHint} and retry.`,
  ];
}

/** Exits the process with code 1 when another live run holds the lock. */
export function acquireVerifyLock(lockPath, { root = process.cwd(), log = console } = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const decision = evaluateLock(readLock(lockPath), process.pid);
    if (decision.action === 'refuse') {
      for (const line of refusalMessage(decision, path.relative(root, lockPath))) {
        log.error(line);
      }
      process.exit(1);
    }
    if (decision.action === 'clear-stale') {
      log.log(`verify: clearing stale lock from dead pid ${decision.pid}`);
    }
  }
  writeFileSync(lockPath, `${process.pid} ${Date.now()}`);
}

export function releaseVerifyLock(lockPath) {
  try {
    if (!existsSync(lockPath)) return;
    if (readLock(lockPath).pid !== process.pid) return;
    unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}
