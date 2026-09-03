/**
 * Keep agent browser scratch (`.playwright/`) and document scratch out of the user's git repo.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWritablePath } from '../security/path-guard.js';

const PLAYWRIGHT_IGNORE_LINE = '.playwright/';

type DocumentScratchDefaults = {
  scratchDir: string;
  dumpsSubdir: string;
  gitignoreLine: string;
  gitignoreComment: string;
};

function loadDocumentScratchDefaults(): DocumentScratchDefaults {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsonPath = path.resolve(here, '../../config/defaults/document-scratch.json');
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as DocumentScratchDefaults;
    return {
      scratchDir: String(raw.scratchDir || '.my-agent/docs'),
      dumpsSubdir: String(raw.dumpsSubdir || 'dumps'),
      gitignoreLine: String(raw.gitignoreLine || '.my-agent/docs/'),
      gitignoreComment: String(raw.gitignoreComment || '# MY Agent document scratch (session temp)'),
    };
  } catch {
    return {
      scratchDir: '.my-agent/docs',
      dumpsSubdir: 'dumps',
      gitignoreLine: '.my-agent/docs/',
      gitignoreComment: '# MY Agent document scratch (session temp)',
    };
  }
}

function ensureIgnoreLine(workspaceRoot: string, line: string, comment: string): void {
  const root = workspaceRoot.trim();
  if (!root || !line.trim()) return;
  const gi = path.join(root, '.gitignore');
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '\\/?');
  const re = new RegExp(`(?:^|[\\r\\n])${escaped}(?:\\s|$)`, 'm');
  try {
    if (existsSync(gi)) {
      const raw = readFileSync(gi, 'utf8');
      if (re.test(raw)) return;
      const sep = raw.endsWith('\n') || raw.length === 0 ? '' : '\n';
      assertWritablePath(gi, root);
      writeFileSync(gi, `${raw}${sep}\n${comment}\n${line}\n`, 'utf8');
      return;
    }
    assertWritablePath(gi, root);
    writeFileSync(gi, `${comment}\n${line}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

export function ensurePlaywrightGitignore(workspaceRoot: string): void {
  ensureIgnoreLine(
    workspaceRoot,
    PLAYWRIGHT_IGNORE_LINE,
    '# MY Agent agent screenshots (session temp)',
  );
  const doc = loadDocumentScratchDefaults();
  ensureIgnoreLine(workspaceRoot, doc.gitignoreLine, doc.gitignoreComment);
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

export function removeDocumentSessionScratch(
  workspaceRoot: string | null | undefined,
  sessionId: string,
): void {
  const root = workspaceRoot?.trim();
  const sid = sessionId.trim();
  if (!root || !sid || sid === '.' || sid.includes('..')) return;
  const doc = loadDocumentScratchDefaults();
  const safeSid = sid.replace(/[\\/]/g, '_');
  const scratchFile = path.join(root, doc.scratchDir, `${safeSid}.md`);
  const dumpsDir = path.join(root, doc.scratchDir, doc.dumpsSubdir);
  try {
    if (existsSync(scratchFile)) {
      assertWritablePath(scratchFile, root);
      rmSync(scratchFile, { force: true });
    }
  } catch {
    /* ignore */
  }
  try {
    if (!existsSync(dumpsDir)) return;
    for (const name of readdirSync(dumpsDir)) {
      if (!name.startsWith(`${safeSid}-`)) continue;
      const abs = path.join(dumpsDir, name);
      try {
        assertWritablePath(abs, root);
        rmSync(abs, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
