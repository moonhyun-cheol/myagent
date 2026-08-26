/**
 * Resolve portable OSS sidecar binaries under runtime/oss-sidecars (ADR-009).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCqrRoot } from '../bootstrap.js';

export function ossSidecarsDir(cqrRoot?: string): string {
  return path.join(cqrRoot ?? resolveCqrRoot(), 'runtime', 'oss-sidecars');
}

function which(cmd: string): string | null {
  const bin = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(bin, [cmd], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  if (r.status !== 0) return null;
  return (
    String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean) || null
  );
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** markitdown CLI. */
export function resolveBundledMarkitdownBinary(
  env: NodeJS.ProcessEnv = process.env,
  cqrRoot?: string,
): string | null {
  const pinned = (env.MY_AGENT_MARKITDOWN_BIN || '').trim();
  if (pinned && existsSync(pinned)) return pinned;
  const root = cqrRoot ?? resolveCqrRoot();
  const bundled = firstExisting([
    path.join(root, 'runtime', 'oss-sidecars', 'venv', 'Scripts', 'markitdown.exe'),
    path.join(root, 'runtime', 'oss-sidecars', 'venv', 'bin', 'markitdown'),
    path.join(root, 'runtime', 'pipeline-venv', 'Scripts', 'markitdown.exe'),
  ]);
  if (bundled) return bundled;
  return which('markitdown');
}

/** repomix CLI. */
export function resolveBundledRepomixBinary(
  env: NodeJS.ProcessEnv = process.env,
  cqrRoot?: string,
): string | null {
  const pinned = (env.MY_AGENT_REPOMIX_BIN || '').trim();
  if (pinned && existsSync(pinned)) return pinned;
  const root = cqrRoot ?? resolveCqrRoot();
  const bundled = firstExisting([
    path.join(root, 'runtime', 'oss-sidecars', 'node_modules', '.bin', 'repomix.cmd'),
    path.join(root, 'runtime', 'oss-sidecars', 'node_modules', '.bin', 'repomix'),
    path.join(root, 'runtime', 'oss-sidecars', 'node_modules', 'repomix', 'bin', 'repomix.cjs'),
  ]);
  if (bundled) return bundled;
  return which('repomix');
}

/** ast-grep / sg CLI. */
export function resolveBundledAstGrepBinary(
  env: NodeJS.ProcessEnv = process.env,
  cqrRoot?: string,
): string | null {
  const pinned = (env.MY_AGENT_AST_GREP_BIN || '').trim();
  if (pinned && existsSync(pinned)) return pinned;
  const root = cqrRoot ?? resolveCqrRoot();
  const bundled = firstExisting([
    path.join(root, 'runtime', 'oss-sidecars', 'bin', 'ast-grep.exe'),
    path.join(root, 'runtime', 'oss-sidecars', 'bin', 'sg.exe'),
    path.join(root, 'runtime', 'oss-sidecars', 'bin', 'ast-grep'),
  ]);
  if (bundled) return bundled;
  return which('ast-grep') || which('sg');
}
