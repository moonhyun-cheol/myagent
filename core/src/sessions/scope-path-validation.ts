import {
  assertDevWorkspaceRoot,
  isAbsoluteUserPath,
  normalizeWorkspacePath,
} from '../security/dev-workspace-guard.js';
import { SecurityError } from '../security/errors.js';

export type ScopePathValidation =
  | { ok: true; roots: string[] }
  | { ok: false; error: 'INVALID_ALLOWED_PATH' | 'ALLOWED_PATH_NOT_ALLOWED'; path: string; message: string };

const sameRoot = (a: string, b: string): boolean =>
  normalizeWorkspacePath(a).toLowerCase() === normalizeWorkspacePath(b).toLowerCase();

/**
 * Validate conversation `allowed_paths` before they are stored.
 *
 * A stored entry becomes the conversation's filesystem root, so it passes the same
 * guard as an explicit folder binding (`PUT /sessions/:id/workspace`): absolute path,
 * existing directory, NAS consent. Any absolute folder is still accepted — it does not
 * have to be a registered workspace.
 *
 * Entries already stored on the conversation are kept without re-checking, so a folder
 * that disappeared later cannot block an unrelated settings save.
 */
export function validateScopeAllowedPaths(
  entries: unknown,
  opts: { allowNas: boolean; existing?: readonly string[] },
): ScopePathValidation {
  if (!Array.isArray(entries)) {
    return { ok: false, error: 'INVALID_ALLOWED_PATH', path: '', message: '허용 경로는 목록이어야 합니다.' };
  }
  const existing = opts.existing ?? [];
  const roots: string[] = [];
  for (const raw of entries) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    if (!isAbsoluteUserPath(entry)) {
      return { ok: false, error: 'INVALID_ALLOWED_PATH', path: entry, message: `절대 경로만 저장할 수 있습니다: ${entry}` };
    }
    if (!existing.some((stored) => sameRoot(stored, entry))) {
      try {
        assertDevWorkspaceRoot(entry, { allowNas: opts.allowNas });
      } catch (e: unknown) {
        const message = e instanceof SecurityError && e.code === 'NAS_CONSENT_REQUIRED'
          ? e.message
          : `폴더를 찾을 수 없거나 폴더가 아닙니다: ${entry}`;
        return { ok: false, error: 'ALLOWED_PATH_NOT_ALLOWED', path: entry, message };
      }
    }
    if (!roots.some((kept) => sameRoot(kept, entry))) roots.push(entry);
  }
  return { ok: true, roots };
}
