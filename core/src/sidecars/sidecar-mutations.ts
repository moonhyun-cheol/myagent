/**
 * Sidecar mutation paths: keep files under the bound workspace.
 * Never promote untracked sibling directories from parent-repo `git status`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export function pathUnderWorkspace(raw: string, workspaceRoot: string): string | null {
  const root = path.resolve(workspaceRoot);
  const cleaned = String(raw || '').trim().replace(/^[`'"[]+|[`'"\]]+$/g, '');
  if (!cleaned) return null;
  const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function pushUnique(out: string[], raw: string, workspaceRoot: string): void {
  const p = pathUnderWorkspace(raw, workspaceRoot);
  if (p && !out.includes(p)) out.push(p);
}

export function collectStdoutMutationPaths(stdout: string, workspaceRoot: string): string[] {
  const out: string[] = [];
  const re =
    /(?:Applied edit to|Wrote|Updated|Edited|Created|Modified)\s+[`'"]?([^\s`'"\n]+)[`'"]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(stdout || ''))) !== null) {
    pushUnique(out, m[1], workspaceRoot);
  }
  return out;
}

export function parseGitPorcelainFileMutations(
  porcelain: string,
  workspaceRoot: string,
): string[] {
  const out: string[] = [];
  const root = path.resolve(workspaceRoot);
  for (const line of String(porcelain || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const body = line.slice(3).trim();
    const arrow = body.includes(' -> ') ? body.split(' -> ').pop()! : body;
    const rel = arrow.replace(/^"|"$/g, '').replace(/\/+$/, '');
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    pushUnique(out, rel, workspaceRoot);
  }
  return out;
}

export function collectGitPorcelainFileMutations(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const st = spawnSync('git', ['status', '--porcelain', '--', '.'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (st.status !== 0) return [];
  return parseGitPorcelainFileMutations(String(st.stdout || ''), root);
}

export function parseSidecarMutatedPaths(stdout: string, workspaceRoot: string): string[] {
  const fromLog = collectStdoutMutationPaths(stdout, workspaceRoot);
  const fromGit = collectGitPorcelainFileMutations(workspaceRoot);
  const out: string[] = [...fromLog];
  for (const p of fromGit) {
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 40);
}
