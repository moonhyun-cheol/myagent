/**
 * Dedicated public-inspect git ops under `.my_agent_remote/` (ADR-009 Wave 1).
 * Avoids run_terminal safety wars (format= / bare git fetch).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeWorkspacePath, resolveDevWorkspaceReadPath } from '../security/dev-workspace-guard.js';

function remoteRepoCloneFolderName(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    const owner = parts.at(-2) ?? 'remote';
    const repo = parts.at(-1) ?? 'repo';
    return `${owner}__${repo}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  } catch {
    return 'remote__repo';
  }
}

export type RemoteGitInspectAction = 'status' | 'unshallow' | 'log' | 'count' | 'ensure_full';

function runGit(cwd: string, args: string[], timeoutMs = 180_000): {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
} {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    exit_code: r.status,
  };
}

export function resolveCqrRemoteRepoPath(
  workspaceRoot: string,
  opts: { repo?: string; url?: string },
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  let rel = (opts.repo || '').trim().replace(/\\/g, '/');
  if (!rel && opts.url?.trim()) {
    rel = `.my_agent_remote/${remoteRepoCloneFolderName(opts.url.trim())}`;
  }
  if (!rel) {
    return { ok: false, error: 'repo= (.my_agent_remote/...) or url= required' };
  }
  if (!/^\.my_agent_remote\//i.test(rel)) {
    return { ok: false, error: 'repo must be under .my_agent_remote/<owner>__<repo>' };
  }
  try {
    const abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    if (!existsSync(path.join(abs, '.git')) && !existsSync(abs)) {
      return { ok: false, error: `path missing: ${rel}` };
    }
    if (!existsSync(path.join(abs, '.git'))) {
      return { ok: false, error: `not a git repo: ${rel}` };
    }
    return { ok: true, abs, rel };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function remoteGitInspect(
  workspaceRoot: string,
  opts: {
    action?: RemoteGitInspectAction;
    repo?: string;
    url?: string;
    max?: number;
  },
): string {
  const root = normalizeWorkspacePath(workspaceRoot);
  const resolved = resolveCqrRemoteRepoPath(root, opts);
  if (!resolved.ok) {
    return JSON.stringify({ ok: false, error: resolved.error }, null, 2);
  }
  const { abs, rel } = resolved;
  const action: RemoteGitInspectAction = opts.action || 'ensure_full';
  const max = Math.min(Math.max(Number(opts.max) || 80, 1), 200);

  const shallow = runGit(abs, ['rev-parse', '--is-shallow-repository']);
  const isShallow = String(shallow.stdout || '').trim() === 'true';

  if (action === 'status') {
    const count = runGit(abs, ['rev-list', '--all', '--count']);
    return JSON.stringify(
      {
        ok: true,
        repo: rel,
        shallow: isShallow,
        commit_count: Number(String(count.stdout || '').trim()) || null,
        head: runGit(abs, ['rev-parse', '--short', 'HEAD']).stdout.trim(),
      },
      null,
      2,
    );
  }

  if (action === 'unshallow' || action === 'ensure_full') {
    if (isShallow) {
      const fetch = runGit(abs, ['fetch', '--unshallow', '--tags', '--prune']);
      if (!fetch.ok) {
        // Some remotes reject --unshallow; try deepen
        const deepen = runGit(abs, ['fetch', '--deepen=2147483647', '--tags', '--prune']);
        if (!deepen.ok) {
          return JSON.stringify(
            {
              ok: false,
              repo: rel,
              error: fetch.stderr || deepen.stderr || 'unshallow failed',
              hint: 'Clone without --depth 1, or check network.',
            },
            null,
            2,
          );
        }
      }
    }
    if (action === 'unshallow') {
      const after = runGit(abs, ['rev-parse', '--is-shallow-repository']);
      const count = runGit(abs, ['rev-list', '--all', '--count']);
      return JSON.stringify(
        {
          ok: true,
          repo: rel,
          shallow: String(after.stdout || '').trim() === 'true',
          commit_count: Number(String(count.stdout || '').trim()) || null,
        },
        null,
        2,
      );
    }
  }

  if (action === 'count') {
    const count = runGit(abs, ['rev-list', '--all', '--count']);
    return JSON.stringify(
      {
        ok: count.ok,
        repo: rel,
        commit_count: Number(String(count.stdout || '').trim()) || null,
        stderr: count.stderr || undefined,
      },
      null,
      2,
    );
  }

  // log (and ensure_full after unshallow)
  const log = runGit(abs, [
    'log',
    '--all',
    '--reverse',
    `--max-count=${max}`,
    '--date=iso-strict',
    '--pretty=format:%h\t%ad\t%an\t%s',
  ]);
  const count = runGit(abs, ['rev-list', '--all', '--count']);
  const shallowAfter = runGit(abs, ['rev-parse', '--is-shallow-repository']);
  return JSON.stringify(
    {
      ok: log.ok,
      repo: rel,
      shallow: String(shallowAfter.stdout || '').trim() === 'true',
      commit_count: Number(String(count.stdout || '').trim()) || null,
      log: (log.stdout || '').trim(),
      stderr: log.stderr || undefined,
      note: 'Use this tool for public .my_agent_remote history — do not invent git bundle handoffs.',
    },
    null,
    2,
  );
}
