/**
 * Keep agent browser scratch (`.playwright/`) out of the user's git repo.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';

const IGNORE_LINE = '.playwright/';

export function ensurePlaywrightGitignore(workspaceRoot: string): void {
  const root = workspaceRoot.trim();
  if (!root) return;
  const gi = path.join(root, '.gitignore');
  try {
    if (existsSync(gi)) {
      const raw = readFileSync(gi, 'utf8');
      if (/(?:^|[\r\n])\.playwright\/?(?:\s|$)/m.test(raw)) return;
      const sep = raw.endsWith('\n') || raw.length === 0 ? '' : '\n';
      assertWritablePath(gi, root);
      writeFileSync(gi, `${raw}${sep}\n# MY Agent agent screenshots (session temp)\n${IGNORE_LINE}\n`, 'utf8');
      return;
    }
    assertWritablePath(gi, root);
    writeFileSync(gi, `# MY Agent agent screenshots (session temp)\n${IGNORE_LINE}\n`, 'utf8');
  } catch {
    /* best-effort — never fail a screenshot over gitignore */
  }
}

export function removePlaywrightSessionDir(workspaceRoot: string | null | undefined, sessionId: string): void {
  const root = workspaceRoot?.trim();
  const sid = sessionId.trim();
  if (!root || !sid || sid === '.' || sid.includes('..')) return;
  const dir = path.join(root, '.playwright', sid);
  if (!existsSync(dir)) return;
  try {
    assertWritablePath(dir, root);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
