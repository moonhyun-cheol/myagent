import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { isNasPath } from './path-guard.js';
import { assertNasWriteAllowed } from './nas-write-consent.js';
import { SecurityError } from './errors.js';

export interface WorkspaceGuardOptions {
  /** Allow NAS write operations (requires user consent). */
  allowNas?: boolean;
}

/**
 * Drive / UNC absolute paths. Workspace folder is chat/repo context — not an FS cage.
 * Relative paths still resolve under the workspace root (and cannot `..` escape).
 */
export function isAbsoluteUserPath(input: string): boolean {
  const t = input.trim();
  if (!t) return false;
  const n = t.replace(/\//g, '\\');
  if (n.startsWith('\\\\')) {
    // UNC \\server\share... (reject bare \\)
    return /^\\\\[^\\]+\\[^\\]/.test(n);
  }
  return path.isAbsolute(t);
}

export function normalizeWorkspacePath(target: string): string {
  const t = target.trim();
  const n = t.replace(/\//g, '\\');
  // Keep UNC as Win32 path; path.resolve can mangle server roots on some Node builds.
  if (n.startsWith('\\\\')) {
    return path.win32.normalize(n);
  }
  return path.resolve(t);
}

/** Validate workspace root exists (read access — no NAS write consent). */
export function assertDevWorkspaceRootReadable(root: string): void {
  const resolved = normalizeWorkspacePath(root);
  if (!existsSync(resolved)) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Dev workspace does not exist: ${root}`);
  }
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Dev workspace is not a directory: ${root}`);
  }
}

export function assertDevWorkspaceRoot(root: string, opts: WorkspaceGuardOptions = {}): void {
  const resolved = normalizeWorkspacePath(root);
  assertNasWriteAllowed(resolved, opts.allowNas === true);
  assertDevWorkspaceRootReadable(root);
}

/**
 * Resolve a tool path for read/list/search.
 * - Relative → under workspace (no `..` escape)
 * - Absolute / UNC → allowed as-is (workspace is context, not a cage)
 */
export function resolveDevWorkspaceReadPath(
  workspaceRoot: string,
  relPath: string,
): string {
  assertDevWorkspaceRootReadable(workspaceRoot);
  const trimmed = (relPath || '.').trim() || '.';
  if (isAbsoluteUserPath(trimmed)) {
    return normalizeWorkspacePath(trimmed);
  }
  const root = normalizeWorkspacePath(workspaceRoot);
  const target = path.resolve(root, trimmed);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Path outside dev workspace: ${relPath}`);
  }
  return target;
}

/**
 * Resolve a tool path for write/edit/delete/rename.
 * Same absolute/UNC policy as reads; NAS writes still require consent (R-003).
 */
export function resolveDevWorkspaceRelPath(
  workspaceRoot: string,
  relPath: string,
  opts: WorkspaceGuardOptions = {},
): string {
  assertDevWorkspaceRoot(workspaceRoot, opts);
  const trimmed = (relPath || '.').trim() || '.';
  if (isAbsoluteUserPath(trimmed)) {
    const target = normalizeWorkspacePath(trimmed);
    assertNasWriteAllowed(target, opts.allowNas === true);
    return target;
  }
  const root = normalizeWorkspacePath(workspaceRoot);
  const target = path.resolve(root, trimmed);
  assertNasWriteAllowed(target, opts.allowNas === true);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Path outside dev workspace: ${relPath}`);
  }
  return target;
}

/** Browse is read-only — NAS folders may be listed without write consent. */
export function assertBrowsePath(target: string): string {
  const resolved = normalizeWorkspacePath(target);
  if (!existsSync(resolved)) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Path does not exist: ${target}`);
  }
  return resolved;
}

export function isNasWorkspaceRoot(root: string | undefined | null): boolean {
  if (!root?.trim()) return false;
  return isNasPath(normalizeWorkspacePath(root));
}

/**
 * Path string for tool results: relative when under workspace, else absolute/UNC as given.
 */
export function toAgentPath(workspaceRoot: string, absPath: string): string {
  const root = normalizeWorkspacePath(workspaceRoot);
  const target = normalizeWorkspacePath(absPath);
  const rel = path.relative(root, target);
  if (!rel) return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return target;
}
