import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  assertBrowsePath,
  isAbsoluteUserPath,
  resolveDevWorkspaceReadPath,
  resolveDevWorkspaceRelPath,
  toAgentPath,
  type WorkspaceGuardOptions,
} from '../security/dev-workspace-guard.js';
import { isNasPath } from '../security/path-guard.js';
import { execFileSync } from 'node:child_process';
import { fuzzyReplaceAll, fuzzyReplaceOnce } from './fuzzy-edit.js';
import {
  buildRepoMapContext,
  focusTokensFromMessage,
  invalidateEmbeddingIndex,
  invalidateRepoMapCache,
} from './index/public.js';
import {
  invalidateWorkspaceSearchCache,
  searchWorkspaceFilesAdvanced,
} from './workspace-search.js';

const MAX_READ_BYTES = 200_000;
const MAX_LIST = 500;
const MAX_SEARCH_HITS = 50;
const MAX_TREE_DEPTH = 4;
const MAX_TREE_ENTRIES = 400;
const MAX_TREE_CHARS = 7_000;

/** Never list these directories in trees / full-file snapshots. */
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

/**
 * Show at top-level but do not expand. Prevents runtime/cache/binary trees from
 * consuming MAX_TREE_CHARS before source dirs like `ui/` appear.
 */
const TREE_SHALLOW_DIRS = new Set([
  'bin',
  'data',
  'logs',
  'runtime',
  'test-results',
]);

/** Prefer these when expanding depth-1 detail so source roots are not starved. */
const TREE_ROOT_PRIORITY = [
  'ui',
  'core',
  'docs',
  'rulebook',
  'tools',
  'shell',
  'deploy',
  'assets',
  'activation-server',
];

export interface WorkspaceTreeOptions extends WorkspaceGuardOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxChars?: number;
}

export interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export function listWindowsDrives(): BrowseEntry[] {
  const drives: BrowseEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) {
        drives.push({ name: `${letter}:`, path: root, is_dir: true });
      }
    } catch {
      /* ignore inaccessible drive */
    }
  }
  return drives;
}

/** Connected UNC shares (net use) so NAS is visible without a drive letter. */
export function listConnectedUncShares(): BrowseEntry[] {
  if (process.platform !== 'win32') return [];
  try {
    // Force UTF-8 so Korean share names (공용_…) survive; default OEM codepage breaks existsSync.
    const raw = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
          '$OutputEncoding = [Console]::OutputEncoding',
          'Get-CimInstance Win32_NetworkConnection | Select-Object -ExpandProperty RemoteName',
        ].join('; '),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8_000 },
    );
    const seen = new Set<string>();
    const out: BrowseEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const remote = line.trim();
      if (!remote.startsWith('\\\\')) continue;
      const norm = remote.replace(/\//g, '\\');
      if (seen.has(norm.toLowerCase())) continue;
      seen.add(norm.toLowerCase());
      try {
        if (!existsSync(norm)) continue;
      } catch {
        continue;
      }
      const name = norm.split('\\').filter(Boolean).slice(1).join('\\') || norm;
      out.push({ name, path: norm, is_dir: true });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out;
  } catch {
    return [];
  }
}

export function browseDirectories(requestedPath?: string): {
  path: string | null;
  parent: string | null;
  entries: BrowseEntry[];
} {
  if (!requestedPath?.trim()) {
    return {
      path: null,
      parent: null,
      entries: [...listWindowsDrives(), ...listConnectedUncShares()],
    };
  }

  const resolved = assertBrowsePath(requestedPath);
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    const parent = path.dirname(resolved);
    return browseDirectories(parent);
  }

  const entries: BrowseEntry[] = [];
  for (const name of readdirSync(resolved)) {
    if (name.startsWith('.')) continue;
    const full = isNasPath(resolved) || resolved.startsWith('\\\\')
      ? path.win32.join(resolved, name)
      : path.join(resolved, name);
    try {
      const child = statSync(full);
      if (child.isDirectory()) {
        entries.push({ name, path: full, is_dir: true });
      }
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(resolved);
  const parentPath = parent && parent !== resolved ? parent : null;
  const enriched = entries.map((e) => ({
    ...e,
    is_nas: isNasPath(e.path),
  }));
  return { path: resolved, parent: parentPath, entries: enriched };
}

export function listWorkspaceDirectory(workspaceRoot: string, relPath = '.', _guard: WorkspaceGuardOptions = {}) {
  const abs = resolveDevWorkspaceReadPath(workspaceRoot, relPath);
  const st = statSync(abs);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${relPath}`);
  }

  const entries: { name: string; path: string; is_dir: boolean; size?: number }[] = [];
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = isAbsoluteUserPath(abs) ? path.win32.join(abs, name) : path.join(abs, name);
    try {
      const child = statSync(full);
      entries.push({
        name,
        path: toAgentPath(workspaceRoot, full),
        is_dir: child.isDirectory(),
        size: child.isFile() ? child.size : undefined,
      });
      if (entries.length >= MAX_LIST) break;
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
  return { path: toAgentPath(workspaceRoot, abs), entries };
}

export function readWorkspaceFile(workspaceRoot: string, relPath: string, _guard: WorkspaceGuardOptions = {}): string {
  const abs = resolveDevWorkspaceReadPath(workspaceRoot, relPath);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (st.size > MAX_READ_BYTES) {
    const buf = readFileSync(abs);
    return buf.subarray(0, MAX_READ_BYTES).toString('utf8') + '\n\n[... truncated ...]';
  }
  return readFileSync(abs, 'utf8');
}

/** Nested file tree for the workspace UI explorer (not agent tools). */
export interface WorkspaceUiTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: WorkspaceUiTreeNode[];
}

export function buildWorkspaceUiTree(
  workspaceRoot: string,
  relPath = '.',
  opts: WorkspaceTreeOptions = {},
): { root: string; tree: WorkspaceUiTreeNode[] } {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? MAX_TREE_ENTRIES;
  let entryCount = 0;

  const walk = (rel: string, depth: number): WorkspaceUiTreeNode[] => {
    if (depth > maxDepth || entryCount >= maxEntries) return [];
    let listed: ReturnType<typeof listWorkspaceDirectory>;
    try {
      listed = listWorkspaceDirectory(workspaceRoot, rel, opts);
    } catch {
      return [];
    }
    const nodes: WorkspaceUiTreeNode[] = [];
    for (const e of listed.entries) {
      if (entryCount >= maxEntries) break;
      if (e.is_dir && SKIP_DIRS.has(e.name)) continue;
      entryCount += 1;
      if (e.is_dir) {
        const shallow = TREE_SHALLOW_DIRS.has(e.name) || depth >= maxDepth;
        nodes.push({
          name: e.name,
          path: e.path,
          is_dir: true,
          children: shallow ? [] : walk(e.path, depth + 1),
        });
      } else {
        nodes.push({ name: e.name, path: e.path, is_dir: false });
      }
    }
    return nodes;
  };

  return { root: toPosix(workspaceRoot), tree: walk(relPath, 0) };
}

export function writeWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
  guard: WorkspaceGuardOptions = {},
): void {
  const abs = resolveDevWorkspaceRelPath(workspaceRoot, relPath, guard);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  invalidateWorkspaceSearchCache(workspaceRoot);
  invalidateRepoMapCache(workspaceRoot);
  invalidateEmbeddingIndex(workspaceRoot);
}

export function editWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  oldText: string,
  newText: string,
  guard: WorkspaceGuardOptions = {},
  replaceAll = false,
): { ok: boolean; message: string } {
  if (!oldText) return { ok: false, message: 'old_text is required' };
  const abs = resolveDevWorkspaceRelPath(workspaceRoot, relPath, guard);
  if (!existsSync(abs)) return { ok: false, message: `File not found: ${relPath}` };
  const content = readFileSync(abs, 'utf8');
  const result = replaceAll
    ? fuzzyReplaceAll(content, oldText, newText)
    : fuzzyReplaceOnce(content, oldText, newText);
  if (!result.ok) return { ok: false, message: result.message };
  writeFileSync(abs, result.content, 'utf8');
  invalidateWorkspaceSearchCache(workspaceRoot);
  invalidateRepoMapCache(workspaceRoot);
  invalidateEmbeddingIndex(workspaceRoot);
  const modeNote = result.mode === 'fuzzy' ? ` [${result.mode}]` : '';
  return { ok: true, message: `Updated ${relPath}${modeNote} (${result.message})` };
}

export function searchWorkspaceFiles(
  workspaceRoot: string,
  query: string,
  relDir = '.',
  _guard: WorkspaceGuardOptions = {},
  opts?: { regex?: boolean },
): { path: string; line: number; text: string; score?: number }[] {
  return searchWorkspaceFilesAdvanced(workspaceRoot, query, {
    path: relDir,
    maxHits: MAX_SEARCH_HITS,
    regex: opts?.regex === true,
  });
}

export function buildWorkspaceTree(
  workspaceRoot: string,
  opts: WorkspaceTreeOptions = {},
): string {
  const maxDepth = opts.maxDepth ?? MAX_TREE_DEPTH;
  const maxEntries = opts.maxEntries ?? MAX_TREE_ENTRIES;
  const maxChars = opts.maxChars ?? MAX_TREE_CHARS;
  let count = 0;
  let truncated = false;

  function isDir(rel: string, name: string): boolean {
    try {
      const childRel = rel === '.' ? name : path.join(rel, name);
      const abs = resolveDevWorkspaceReadPath(workspaceRoot, childRel);
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  function listChildNames(rel: string): string[] {
    const abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    if (!statSync(abs).isDirectory()) return [];
    const names: string[] = [];
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      if (SKIP_DIRS.has(name)) continue;
      names.push(name);
    }
    const atRoot = rel === '.' || rel === '';
    names.sort((a, b) => {
      const aDir = isDir(rel, a);
      const bDir = isDir(rel, b);
      if (aDir !== bDir) return Number(bDir) - Number(aDir);
      if (atRoot) {
        const ap = TREE_ROOT_PRIORITY.indexOf(a);
        const bp = TREE_ROOT_PRIORITY.indexOf(b);
        const aPri = ap === -1 ? TREE_ROOT_PRIORITY.length : ap;
        const bPri = bp === -1 ? TREE_ROOT_PRIORITY.length : bp;
        if (aPri !== bPri) return aPri - bPri;
      }
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return names;
  }

  function walk(rel: string, prefix: string, depth: number): string[] {
    if (depth > maxDepth || count >= maxEntries) {
      if (count >= maxEntries) truncated = true;
      return [];
    }

    const names = listChildNames(rel);
    const lines: string[] = [];
    for (let i = 0; i < names.length; i++) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      const name = names[i];
      const isLast = i === names.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const childRel = rel === '.' ? name : path.join(rel, name);
      const dir = isDir(rel, name);
      const shallow = dir && TREE_SHALLOW_DIRS.has(name);

      lines.push(
        `${prefix}${connector}${name}${dir ? '/' : ''}${shallow ? '  (detail omitted)' : ''}`,
      );
      count++;

      if (dir && !shallow && depth < maxDepth) {
        lines.push(...walk(childRel, prefix + childPrefix, depth + 1));
      }
    }
    return lines;
  }

  const rootName = path.basename(path.resolve(workspaceRoot)) || workspaceRoot;
  const topNames = listChildNames('.');
  const topDirs = topNames.filter((name) => isDir('.', name));
  const topFileCount = topNames.length - topDirs.length;
  const topIndex = [
    `${rootName}/`,
    'Top-level (complete):',
    ...topDirs.map((name) => {
      const shallow = TREE_SHALLOW_DIRS.has(name);
      return `- ${name}/${shallow ? '  (detail omitted)' : ''}`;
    }),
    ...(topFileCount > 0 ? [`- (${topFileCount} root files — see detail or list_directory)`] : []),
    '',
    'Directory detail:',
  ];

  const detailLines = walk('.', '', 1);
  if (truncated) detailLines.push('... (more entries omitted)');

  const header = topIndex.join('\n');
  let detail = detailLines.join('\n');
  const sep = detail ? '\n' : '';
  let result = `${header}${sep}${detail}`;
  if (result.length > maxChars) {
    truncated = true;
    const budget = Math.max(0, maxChars - header.length - sep.length - '\n... (truncated)'.length);
    detail = detail.slice(0, budget);
    result = `${header}${sep}${detail}\n... (truncated)`;
  }
  return result;
}

const MAX_CONTEXT_FILES = 500;
const MAX_CONTEXT_TOTAL_CHARS = 300_000;
const MAX_CONTEXT_PER_FILE_CHARS = 40_000;
const MAX_ENTRY_FILES_CHARS = 80_000;
const MAX_PER_FILE_CHARS = 12_000;
const ENTRY_FILE_CANDIDATES = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'AGENTS.md',
  'RULEBOOK.md',
];
const TEXT_FILE_RE =
  /\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|py|css|scss|html|htm|xml|yml|yaml|toml|ini|cfg|conf|sh|bat|ps1|sql|rs|go|java|kt|cs|cpp|c|h|hpp|vue|svelte|env|example)$/i;

function isTextWorkspaceFile(name: string): boolean {
  if (TEXT_FILE_RE.test(name)) return true;
  const base = path.basename(name).toLowerCase();
  return (
    base === 'readme' ||
    base === 'license' ||
    base === 'makefile' ||
    base === 'dockerfile' ||
    base.startsWith('.env')
  );
}

function buildWorkspaceAllFilesSnapshot(workspaceRoot: string): { body: string; fileCount: number; truncated: boolean } {
  const parts: string[] = [];
  let totalChars = 0;
  let fileCount = 0;
  let truncated = false;

  function walk(relDir: string): void {
    if (fileCount >= MAX_CONTEXT_FILES || totalChars >= MAX_CONTEXT_TOTAL_CHARS) {
      truncated = true;
      return;
    }
    let listed;
    try {
      listed = listWorkspaceDirectory(workspaceRoot, relDir);
    } catch {
      return;
    }
    for (const entry of listed.entries) {
      if (fileCount >= MAX_CONTEXT_FILES || totalChars >= MAX_CONTEXT_TOTAL_CHARS) {
        truncated = true;
        return;
      }
      if (entry.is_dir) {
        if (SKIP_DIRS.has(entry.name) || TREE_SHALLOW_DIRS.has(entry.name)) continue;
        walk(entry.path);
        continue;
      }
      if (!isTextWorkspaceFile(entry.name)) continue;
      try {
        let text = readWorkspaceFile(workspaceRoot, entry.path);
        if (text.length > MAX_CONTEXT_PER_FILE_CHARS) {
          text = `${text.slice(0, MAX_CONTEXT_PER_FILE_CHARS)}\n... (truncated)`;
          truncated = true;
        }
        parts.push(`### ${entry.path}\n\`\`\`\n${text}\n\`\`\``);
        totalChars += text.length;
        fileCount += 1;
      } catch {
        /* skip unreadable */
      }
    }
  }

  walk('.');
  if (!parts.length) return { body: '', fileCount: 0, truncated };
  const header = `작업 폴더 파일 내용 (${fileCount}개${truncated ? ', 일부 생략' : ''}):`;
  return { body: [header, '', ...parts].join('\n'), fileCount, truncated };
}

export type WorkspaceContextTier = 'light' | 'agent' | 'full';

export interface WorkspaceContextOptions {
  tier?: WorkspaceContextTier;
  /** User message — used to rank repo-map focus. */
  focusMessage?: string;
  /** Include the ranked symbol map (default true for agent/full). */
  includeRepoMap?: boolean;
  repoMapMaxChars?: number;
}

export function buildDevWorkspaceContext(
  workspaceRoot: string | undefined | null,
  _guard: WorkspaceGuardOptions = {},
  opts: WorkspaceContextOptions = {},
): string {
  const root = workspaceRoot?.trim();
  if (!root) return '';
  const tier = opts.tier ?? 'light';
  try {
    const tree = buildWorkspaceTree(root, {
      maxDepth: tier === 'full' ? 6 : 4,
      maxEntries: tier === 'full' ? 800 : 400,
      maxChars: tier === 'full' ? 12_000 : 7_000,
    });
    const resolved = path.resolve(root);
    const sections = [
      '## 작업 폴더 (Dev Workspace)',
      '',
      `Root: ${resolved}`,
      '',
      '디렉터리 구조:',
      '```',
      tree,
      '```',
    ];

    const wantMap =
      opts.includeRepoMap ?? (tier === 'agent' || tier === 'full' || Boolean(opts.focusMessage));
    if (wantMap) {
      const map = buildRepoMapContext(root, {
        maxChars: opts.repoMapMaxChars ?? (tier === 'light' ? 3_500 : 6_000),
        focusTokens: opts.focusMessage ? focusTokensFromMessage(opts.focusMessage) : [],
      });
      if (map.trim()) {
        sections.push('', map);
      }
    }

    if (tier === 'full') {
      const files = buildWorkspaceAllFilesSnapshot(root);
      if (files.body) {
        sections.push('', files.body);
      }
    } else {
      sections.push(
        '',
        '(파일 내용은 Code Agent의 read_file / search_files 도구 또는 UI 활성 파일 힌트로 제공됩니다.)',
      );
    }
    return sections.join('\n');
  } catch {
    return '';
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
