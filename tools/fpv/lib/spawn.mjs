#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './paths.mjs';

export function runNode(relOrAbs, args = [], env = {}) {
  const script = relOrAbs.includes(':') || relOrAbs.startsWith('/') || /^[A-Za-z]:/.test(relOrAbs)
    ? relOrAbs
    : `${REPO_ROOT}/${relOrAbs}`.replace(/\\/g, '/');
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 40 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

export function runNpm(script, args = [], env = {}) {
  const isWin = process.platform === 'win32';
  // Windows needs shell to resolve npm.cmd; DEP0190 accepted for local lab harness.
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 40 * 1024 * 1024,
    shell: isWin,
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}
