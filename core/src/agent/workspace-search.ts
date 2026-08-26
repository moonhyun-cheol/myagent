/**
 * Continue-inspired workspace search: prefer ripgrep when available,
 * else a lightweight in-memory token index (FTS-like) with substring fallback.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDevWorkspaceReadPath } from '../security/dev-workspace-guard.js';

const MAX_HITS = 50;
const MAX_READ_BYTES = 200_000;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
]);

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  score?: number;
}

export interface SearchOptions {
  path?: string;
  maxHits?: number;
  /** Prefer regex when true (ripgrep -e). Default: literal substring / FTS tokens. */
  regex?: boolean;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function hasRipgrep(): boolean {
  try {
    const r = spawnSync('rg', ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

let rgAvailable: boolean | null = null;

function ripgrepAvailable(): boolean {
  if (rgAvailable === null) rgAvailable = hasRipgrep();
  return rgAvailable;
}

function searchWithRipgrep(
  workspaceRoot: string,
  query: string,
  relDir: string,
  maxHits: number,
  regex: boolean,
): SearchHit[] | null {
  if (!ripgrepAvailable()) return null;
  let absRoot: string;
  try {
    absRoot = resolveDevWorkspaceReadPath(workspaceRoot, relDir);
  } catch {
    return null;
  }

  const args = [
    '--json',
    '--max-count',
    String(maxHits),
    '--glob',
    '!node_modules',
    '--glob',
    '!.git',
    '--glob',
    '!.venv',
    '--glob',
    '!dist',
    '--glob',
    '!build',
    '--glob',
    '!.next',
    '-i',
  ];
  if (!regex) args.push('-F');
  args.push('--', query, absRoot);

  const r = spawnSync('rg', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  // rg exits 1 when no matches
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;

  const hits: SearchHit[] = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (!line.trim() || hits.length >= maxHits) break;
    try {
      const row = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (row.type !== 'match' || !row.data) continue;
      const abs = row.data.path?.text;
      if (!abs) continue;
      const rel = toPosix(path.relative(workspaceRoot, abs));
      hits.push({
        path: rel,
        line: row.data.line_number ?? 0,
        text: (row.data.lines?.text ?? '').trim().slice(0, 240),
        score: 1,
      });
    } catch {
      /* skip bad json line */
    }
  }
  return hits;
}

/** Simple inverted index cache per workspace root. */
type IndexEntry = { path: string; line: number; text: string; tokens: Set<string> };
type WorkspaceIndex = {
  builtAt: number;
  entries: IndexEntry[];
  byToken: Map<string, number[]>;
};

const indexCache = new Map<string, WorkspaceIndex>();
const INDEX_TTL_MS = 60_000;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_\uac00-\ud7a3]{2,}/g) ?? []).slice(0, 40);
}

function buildIndex(workspaceRoot: string, relDir: string): WorkspaceIndex {
  const key = `${path.resolve(workspaceRoot)}::${relDir}`;
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached;

  const entries: IndexEntry[] = [];
  const byToken = new Map<string, number[]>();

  function walk(rel: string): void {
    if (entries.length >= 20_000) return;
    let abs: string;
    try {
      abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch {
      return;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (st.size > MAX_READ_BYTES) return;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      // Skip obvious binaries
      if (text.includes('\0')) return;
      const relFile = toPosix(path.relative(workspaceRoot, abs));
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const tokens = new Set(tokenize(line));
        if (!tokens.size) continue;
        const idx = entries.length;
        entries.push({
          path: relFile,
          line: i + 1,
          text: line.trim().slice(0, 240),
          tokens,
        });
        for (const t of tokens) {
          const list = byToken.get(t);
          if (list) list.push(idx);
          else byToken.set(t, [idx]);
        }
        if (entries.length >= 20_000) break;
      }
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.env')) continue;
      walk(rel === '.' ? name : path.join(rel, name));
      if (entries.length >= 20_000) break;
    }
  }

  walk(relDir);
  const built: WorkspaceIndex = { builtAt: Date.now(), entries, byToken };
  indexCache.set(key, built);
  return built;
}

function searchWithFts(
  workspaceRoot: string,
  query: string,
  relDir: string,
  maxHits: number,
): SearchHit[] {
  const qTokens = tokenize(query);
  const needle = query.toLowerCase().trim();
  if (!needle) return [];

  const index = buildIndex(workspaceRoot, relDir);
  const scores = new Map<number, number>();

  if (qTokens.length) {
    for (const t of qTokens) {
      const idxs = index.byToken.get(t);
      if (!idxs) continue;
      for (const i of idxs) {
        scores.set(i, (scores.get(i) ?? 0) + 1);
      }
    }
  }

  // Also boost exact substring matches
  for (let i = 0; i < index.entries.length; i++) {
    const e = index.entries[i];
    if (e.text.toLowerCase().includes(needle)) {
      scores.set(i, (scores.get(i) ?? 0) + 3);
    }
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, maxHits);

  return ranked.map(([i, score]) => {
    const e = index.entries[i];
    return { path: e.path, line: e.line, text: e.text, score };
  });
}

function searchSubstringWalk(
  workspaceRoot: string,
  query: string,
  relDir: string,
  maxHits: number,
): SearchHit[] {
  const needle = query.toLowerCase();
  if (!needle.trim()) return [];
  const hits: SearchHit[] = [];

  function walk(rel: string): void {
    if (hits.length >= maxHits) return;
    let abs: string;
    try {
      abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch {
      return;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (st.size > MAX_READ_BYTES) return;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      if (text.includes('\0')) return;
      const relFile = toPosix(path.relative(workspaceRoot, abs));
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= maxHits) return;
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({
            path: relFile,
            line: i + 1,
            text: lines[i].trim().slice(0, 240),
            score: 1,
          });
        }
      }
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || name === 'node_modules' || name === '.git') continue;
      walk(path.join(rel, name));
      if (hits.length >= maxHits) break;
    }
  }

  walk(relDir);
  return hits;
}

export function searchWorkspaceFilesAdvanced(
  workspaceRoot: string,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const relDir = opts.path?.trim() || '.';
  const maxHits = opts.maxHits ?? MAX_HITS;
  const regex = opts.regex === true;
  if (!query.trim()) return [];

  const rg = searchWithRipgrep(workspaceRoot, query, relDir, maxHits, regex);
  if (rg) return rg;

  if (!regex) {
    return searchWithFts(workspaceRoot, query, relDir, maxHits);
  }

  // Regex without rg: fall back to safe substring of the pattern body
  return searchSubstringWalk(workspaceRoot, query, relDir, maxHits);
}

/** Invalidate FTS cache (e.g. after large writes). */
export function invalidateWorkspaceSearchCache(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    indexCache.clear();
    return;
  }
  const prefix = `${path.resolve(workspaceRoot)}::`;
  for (const key of indexCache.keys()) {
    if (key.startsWith(prefix)) indexCache.delete(key);
  }
}
