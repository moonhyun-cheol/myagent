/**
 * Guard: models sometimes read_file("discord.js") meaning the npm package.
 * Block bare module names that are not real workspace files.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  isAbsoluteUserPath,
  resolveDevWorkspaceReadPath,
} from '../security/dev-workspace-guard.js';

const WORKSPACE_ROOT_FILE_RE =
  /^(?:index|app|main|server|client|script|package|tsconfig|vite\.config|README)\.(?:js|mjs|cjs|ts|tsx|json|md)$/i;

/** npm-like single segment or @scope/name with no deeper path. */
export function looksLikeBareNpmModuleId(rel: string): boolean {
  const t = String(rel || '').trim().replace(/\\/g, '/');
  if (!t || t === '.' || t === '..') return false;
  if (isAbsoluteUserPath(t) || t.startsWith('./') || t.startsWith('../')) return false;
  if (/^@[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(t)) return true;
  if (t.includes('/')) return false;
  if (WORKSPACE_ROOT_FILE_RE.test(t)) return false;
  // discord.js / left-pad style package ids
  if (/^[a-z0-9][a-z0-9._-]*\.(?:js|mjs|cjs)$/i.test(t)) return true;
  // unscoped package name without path (dotenv, exceljs)
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(t)) return true;
  return false;
}

/**
 * True when path is an npm package id and does not exist as a workspace file.
 */
export function isBlockedBareModuleRead(
  workspaceRoot: string,
  rel: string,
): boolean {
  const raw = String(rel || '').trim();
  if (!raw || !looksLikeBareNpmModuleId(raw)) return false;
  try {
    const abs = resolveDevWorkspaceReadPath(workspaceRoot, raw);
    if (existsSync(abs)) {
      const norm = abs.replace(/\\/g, '/').toLowerCase();
      if (norm.includes('/node_modules/')) return true;
      return false;
    }
  } catch {
    /* resolve failed — still block bare module */
  }
  return true;
}

export function formatBareModuleReadBlock(rel: string): string {
  return [
    `ERROR: BARE_MODULE_READ — "${rel}" looks like an npm package name, not a workspace file.`,
    'Do not read_file package ids (e.g. discord.js, dotenv).',
    'Read project source paths instead (e.g. src/discord/poster.js, package.json).',
    'If you need dependency info, read package.json only.',
    '',
    'Instructions for the model (do not show to user):',
    '- Do NOT retry this same path. Call list_directory/src read or mutate next.',
  ].join('\n');
}
