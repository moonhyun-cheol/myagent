/**
 * Repository map: extract key symbols per file and rank by
 * cross-file reference weight so the LLM gets a compact codebase overview.
 * Uses portable regex extractors so clean installs do not need parser runtimes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDevWorkspaceReadPath } from '../../security/dev-workspace-guard.js';

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
  'bin',
  'data',
  'logs',
  'runtime',
  'test-results',
  // Staged/deploy copies pollute path hits (e.g. tools.ts → deploy/output/... before core/).
  'deploy',
  'output',
]);

const CODE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|hpp|vue|svelte|rb|php|swift)$/i;

const MAX_FILES = 400;
const MAX_FILE_BYTES = 200_000;
const DEFAULT_MAX_CHARS = 6_000;
const REPO_MAP_TTL_MS = 60_000;

type FileFingerprint = { mtimeMs: number; size: number };

type RepoMapCacheEntry = {
  builtAt: number;
  /** Base map (no focusTokens) — re-rank on read. */
  maps: RepoFileMap[];
  /** Merkle-lite: mtime+size per path for dirty-only rebuild. */
  fingerprints: Record<string, FileFingerprint>;
};

const repoMapCache = new Map<string, RepoMapCacheEntry>();

/** Cheap relative-import edge extraction for dependency hints. */
export function extractImportEdges(relPath: string, content: string): string[] {
  const edges: string[] = [];
  const lines = content.split(/\r?\n/).slice(0, 120);
  for (const line of lines) {
    const match =
      line.match(/^\s*import\s+.+?\s+from\s+['"]([^'"]+)['"]/)
      || line.match(/^\s*export\s+.+?\s+from\s+['"]([^'"]+)['"]/)
      || line.match(/^\s*const\s+\w+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/)
      || line.match(/^\s*from\s+([.\w/]+)\s+import\s+/);
    if (match?.[1] && (match[1].startsWith('.') || match[1].startsWith('/'))) {
      const edge = `${relPath} → ${match[1]}`;
      if (!edges.includes(edge)) edges.push(edge);
    }
  }
  return edges.slice(0, 12);
}

function cacheKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase();
}

/**
 * Expire cache so the next getOrBuild does a dirty-file incremental rebuild
 * (keeps fingerprints — not a full wipe unless workspaceRoot omitted).
 */
export function invalidateRepoMapCache(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    repoMapCache.clear();
    return;
  }
  const key = cacheKey(workspaceRoot);
  const entry = repoMapCache.get(key);
  if (entry) {
    entry.builtAt = 0;
  }
}

/** Test/helper: expose whether next rebuild can reuse fingerprints. */
export function repoMapCacheStats(workspaceRoot: string): {
  hasEntry: boolean;
  fileCount: number;
  builtAt: number;
} {
  const entry = repoMapCache.get(cacheKey(workspaceRoot));
  return {
    hasEntry: Boolean(entry),
    fileCount: entry ? Object.keys(entry.fingerprints).length : 0,
    builtAt: entry?.builtAt ?? 0,
  };
}

function fingerprintFile(abs: string): FileFingerprint | null {
  try {
    const st = statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function scoreFileMaps(fileMaps: RepoFileMap[], focus: string[]): void {
  const mentionCount = new Map<string, number>();
  for (const fm of fileMaps) {
    for (const s of fm.symbols) {
      mentionCount.set(s.name, (mentionCount.get(s.name) ?? 0) + 1);
    }
  }
  for (const fm of fileMaps) {
    let ref = 0;
    for (const s of fm.symbols) {
      const c = mentionCount.get(s.name) ?? 1;
      ref += Math.min(c, 12);
      if (tokenOverlap(s.name, focus)) ref += 6;
    }
    const focusBoost = tokenOverlap(fm.path, focus) * 8;
    const importBoost = (fm.imports ?? []).reduce(
      (n, e) => n + tokenOverlap(e, focus) * 2,
      0,
    );
    fm.score = focusBoost + importBoost + fm.symbols.length + ref;
    const base = path.basename(fm.path).toLowerCase();
    if (/^(index|main|app|server|agent|orchestrator)\./.test(base)) fm.score += 10;
  }
  fileMaps.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Incremental (dirty-only) map rebuild using mtime+size fingerprints.
 * Unchanged files reuse prior symbol rows; deleted paths drop out.
 */
function buildRepoMapIncremental(
  workspaceRoot: string,
  prev: RepoMapCacheEntry | undefined,
  opts: RepoMapOptions = {},
): RepoMapCacheEntry {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const paths = collectCodeFiles(workspaceRoot, maxFiles);
  const prevByPath = new Map((prev?.maps ?? []).map((m) => [m.path, m]));
  const prevFp = prev?.fingerprints ?? {};
  const fingerprints: Record<string, FileFingerprint> = {};
  const fileMaps: RepoFileMap[] = [];
  let reused = 0;
  let rebuilt = 0;

  for (const rel of paths) {
    let abs: string;
    try {
      abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch {
      continue;
    }
    const fp = fingerprintFile(abs);
    if (!fp) continue;
    fingerprints[rel] = fp;
    const oldFp = prevFp[rel];
    const oldMap = prevByPath.get(rel);
    if (
      oldMap
      && oldFp
      && oldFp.mtimeMs === fp.mtimeMs
      && oldFp.size === fp.size
    ) {
      fileMaps.push({
        path: oldMap.path,
        symbols: oldMap.symbols.map((s) => ({ ...s })),
        imports: oldMap.imports ? [...oldMap.imports] : undefined,
        score: oldMap.symbols.length,
      });
      reused += 1;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const symbols = extractSymbols(rel, content);
    const imports = extractImportEdges(rel, content);
    // Keep export-only façades (re-export files often have imports but zero symbols).
    if (!symbols.length && !(imports?.length)) continue;
    fileMaps.push({
      path: rel,
      symbols,
      imports,
      score: Math.max(1, symbols.length + (imports?.length ?? 0)),
    });
    rebuilt += 1;
  }

  scoreFileMaps(fileMaps, []);
  void reused;
  void rebuilt;
  return { builtAt: Date.now(), maps: fileMaps, fingerprints };
}

function cloneMaps(maps: RepoFileMap[]): RepoFileMap[] {
  return maps.map((fm) => ({
    path: fm.path,
    score: fm.score,
    symbols: fm.symbols.map((s) => ({ ...s })),
    imports: fm.imports ? [...fm.imports] : undefined,
  }));
}

/** Re-apply focus ranking onto a cached base map. */
function applyFocusRanking(maps: RepoFileMap[], focusTokens: string[]): RepoFileMap[] {
  const focus = focusTokens.filter((t) => t.trim().length >= 2);
  const out = cloneMaps(maps);
  if (!focus.length) return out;
  for (const fm of out) {
    fm.score += tokenOverlap(fm.path, focus) * 8;
    for (const e of fm.imports ?? []) {
      fm.score += tokenOverlap(e, focus) * 2;
    }
    for (const s of fm.symbols) {
      if (tokenOverlap(s.name, focus)) fm.score += 6;
    }
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out;
}

/**
 * TTL-cached repo map with dirty-file incremental rebuild.
 * Builds without focus, then re-ranks per request.
 * Call invalidateRepoMapCache after workspace mutations.
 */
export function getOrBuildRepoMap(
  workspaceRoot: string,
  opts: RepoMapOptions = {},
): RepoFileMap[] {
  const key = cacheKey(workspaceRoot);
  const now = Date.now();
  let entry = repoMapCache.get(key);
  if (!entry || now - entry.builtAt > REPO_MAP_TTL_MS) {
    entry = buildRepoMapIncremental(workspaceRoot, entry, {
      maxFiles: opts.maxFiles,
      focusTokens: [],
    });
    repoMapCache.set(key, entry);
  }
  return applyFocusRanking(entry.maps, opts.focusTokens ?? []);
}

export interface QueryRepoMapOptions {
  kind?: RepoSymbol['kind'];
  maxResults?: number;
}

function queryMatchTokens(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const fromFocus = focusTokensFromMessage(q).map((t) => t.toLowerCase());
  const spaced = q
    .toLowerCase()
    .split(/[^a-z0-9_.\uac00-\ud7a3/-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const out: string[] = [];
  for (const t of [...fromFocus, ...spaced, q.toLowerCase()]) {
    if (t.length < 2) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function hayMatchesAny(hay: string, tokens: string[]): boolean {
  const h = hay.toLowerCase();
  return tokens.some((t) => t.length >= 2 && h.includes(t));
}

function pathRankBoost(relPath: string): number {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  let boost = 0;
  if (p.includes('core/src/')) boost += 15;
  if (p.includes('/deploy/') || p.startsWith('deploy/') || p.includes('/output/')) boost -= 40;
  return boost;
}

/** Queryable view over the cached repo map (symbols / paths / imports). */
export function queryRepoMap(
  workspaceRoot: string,
  query: string,
  opts: QueryRepoMapOptions = {},
): {
  path: string;
  score: number;
  symbols: RepoSymbol[];
  imports?: string[];
}[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = queryMatchTokens(query);
  const max = opts.maxResults ?? 24;
  const maps = getOrBuildRepoMap(workspaceRoot, {
    focusTokens: tokens.length ? tokens : [query],
  });
  const hits: {
    path: string;
    score: number;
    symbols: RepoSymbol[];
    imports?: string[];
  }[] = [];

  for (const fm of maps) {
    const pathHit = hayMatchesAny(fm.path, tokens);
    const syms = fm.symbols.filter((s) => {
      if (opts.kind && s.kind !== opts.kind) return false;
      return hayMatchesAny(s.name, tokens) || hayMatchesAny(s.signature, tokens);
    });
    const importHit = (fm.imports ?? []).some((e) => hayMatchesAny(e, tokens));
    if (!pathHit && !syms.length && !importHit) continue;
    const tokenHits = tokens.filter(
      (t) =>
        fm.path.toLowerCase().includes(t)
        || (fm.imports ?? []).some((e) => e.toLowerCase().includes(t))
        || fm.symbols.some(
          (s) => s.name.toLowerCase().includes(t) || s.signature.toLowerCase().includes(t),
        ),
    ).length;
    hits.push({
      path: fm.path,
      score:
        fm.score
        + (pathHit ? 20 : 0)
        + syms.length * 5
        + tokenHits * 8
        + pathRankBoost(fm.path),
      symbols: syms.length ? syms : fm.symbols.slice(0, 8),
      imports: fm.imports,
    });
    if (hits.length >= max * 3) break;
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, max);
}

export interface RepoSymbol {
  name: string;
  kind: 'class' | 'function' | 'method' | 'type' | 'const' | 'interface' | 'enum';
  line: number;
  signature: string;
}

export interface RepoFileMap {
  path: string;
  symbols: RepoSymbol[];
  score: number;
  /** Relative import edges (local modules only). */
  imports?: string[];
}

export interface RepoMapOptions {
  maxChars?: number;
  maxFiles?: number;
  /** Prefer files whose path/name matches these tokens (chat query hints). */
  focusTokens?: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function extractSymbols(relPath: string, content: string): RepoSymbol[] {
  const ext = path.extname(relPath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const out: RepoSymbol[] = [];
  const push = (kind: RepoSymbol['kind'], name: string, line: number, sig: string) => {
    if (!name || name.length > 80) return;
    if (out.some((s) => s.name === name && s.kind === kind)) return;
    out.push({ kind, name, line, signature: sig.slice(0, 160).trim() });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(ext)) {
      let m =
        line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/) ||
        line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/) ||
        line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/);
      if (m) push('function', m[1], n, line);
      m = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
      if (m) push('class', m[1], n, line);
      m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type)\s+(\w+)/);
      if (m) push(line.includes('interface') ? 'interface' : 'type', m[1], n, line);
      m = line.match(
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/,
      );
      if (m) push('const', m[1], n, line);
      m = line.match(/^\s*export\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/);
      if (m) {
        for (const part of m[1].split(',')) {
          const name = part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/i)
            .pop()
            ?.trim();
          if (name && /^[A-Za-z_][\w]*$/.test(name)) {
            push('const', name, n, line);
          }
        }
      }
      m = line.match(/^\s*(?:public|private|protected|async)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^;]*\)\s*\{/);
      if (m && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) {
        push('method', m[1], n, line);
      }
      continue;
    }

    if (ext === '.py') {
      let m = line.match(/^\s*def\s+(\w+)\s*\(/);
      if (m) push(line.match(/^\s{0,1}def/) ? 'function' : 'method', m[1], n, line);
      m = line.match(/^\s*async\s+def\s+(\w+)\s*\(/);
      if (m) push('function', m[1], n, line);
      m = line.match(/^\s*class\s+(\w+)/);
      if (m) push('class', m[1], n, line);
      continue;
    }

    if (ext === '.go') {
      let m = line.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/);
      if (m) push('function', m[1], n, line);
      m = line.match(/^type\s+(\w+)\s+(?:struct|interface)/);
      if (m) push('type', m[1], n, line);
      continue;
    }

    if (ext === '.rs') {
      let m = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (m) push('function', m[1], n, line);
      m = line.match(/^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+(\w+)/);
      if (m) push('type', m[1], n, line);
      continue;
    }

    if (/\.(java|kt|cs)$/i.test(ext)) {
      let m = line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:class|interface|enum|record|struct)\s+(\w+)/);
      if (m) {
        const kind = line.includes('interface')
          ? 'interface'
          : line.includes('enum')
            ? 'enum'
            : 'class';
        push(kind, m[1], n, line);
      }
      m = line.match(
        /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?[\w.<>,\[\]?]+\s+(\w+)\s*\(/,
      );
      if (m && !['if', 'for', 'while', 'switch', 'catch', 'new'].includes(m[1])) {
        push('method', m[1], n, line);
      }
    }
  }

  return out.slice(0, 40);
}

function collectCodeFiles(workspaceRoot: string, maxFiles: number): string[] {
  const files: string[] = [];

  function walk(rel: string): void {
    if (files.length >= maxFiles) return;
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
      if (CODE_EXT_RE.test(abs) && st.size <= MAX_FILE_BYTES) {
        files.push(toPosix(path.relative(workspaceRoot, abs) || path.basename(abs)));
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
      if (name.startsWith('.') && name !== '.env') continue;
      if (SKIP_DIRS.has(name)) continue;
      walk(rel === '.' ? name : `${rel}/${name}`);
      if (files.length >= maxFiles) break;
    }
  }

  walk('.');
  return files;
}

function tokenOverlap(hay: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const lower = hay.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (lower.includes(t.toLowerCase())) score += 1;
  }
  return score;
}

/**
 * Build ranked file→symbol map. Scores boost frequently referenced symbols
 * and files matching focusTokens (from the user message).
 * Fresh full scan (no cache) — preferred for one-off scripts/tests.
 */
export function buildRepoMap(
  workspaceRoot: string,
  opts: RepoMapOptions = {},
): RepoFileMap[] {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const focus = (opts.focusTokens ?? []).filter((t) => t.trim().length >= 2);
  const paths = collectCodeFiles(workspaceRoot, maxFiles);
  const fileMaps: RepoFileMap[] = [];

  for (const rel of paths) {
    let content: string;
    try {
      const abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const symbols = extractSymbols(rel, content);
    const imports = extractImportEdges(rel, content);
    if (!symbols.length && !(imports?.length)) continue;
    fileMaps.push({
      path: rel,
      symbols,
      imports,
      score: Math.max(1, symbols.length + (imports?.length ?? 0)),
    });
  }

  scoreFileMaps(fileMaps, focus);
  return fileMaps;
}

/** Render a budget-limited ranked repository map string. */
export function formatRepoMap(fileMaps: RepoFileMap[], maxChars = DEFAULT_MAX_CHARS): string {
  if (!fileMaps.length) return '';
  const lines: string[] = ['## Repository map (key symbols)', ''];
  let used = lines.join('\n').length;

  for (const fm of fileMaps) {
    const header = `${fm.path}:`;
    const symLines = fm.symbols
      .slice(0, 12)
      .map((s) => `  ${s.kind} ${s.name}  L${s.line}`)
      .join('\n');
    const importLines =
      fm.imports && fm.imports.length
        ? `\n  imports: ${fm.imports
            .map((e) => e.split(' → ')[1] ?? e)
            .slice(0, 6)
            .join(', ')}`
        : '';
    const block = `${header}\n${symLines}${importLines}`;
    if (used + block.length + 2 > maxChars) {
      lines.push('… (repo map truncated)');
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }

  return lines.join('\n');
}

/** Extract rough focus tokens from a user message for map ranking. */
export function focusTokensFromMessage(message: string): string[] {
  const raw = message.match(/[A-Za-z_][\w.-]{2,}|[\uac00-\ud7a3]{2,}/g) ?? [];
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'please', 'file', 'code',
    'read', 'write', 'edit', 'fix', 'path', 'tool', '파일', '코드', '수정', '확인',
    '만들어', '작성', '해줘', '주세요',
  ]);
  const out: string[] = [];
  for (const t of raw) {
    const k = t.toLowerCase();
    if (stop.has(k)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 24) break;
  }
  return out;
}

export function buildRepoMapContext(
  workspaceRoot: string,
  opts: RepoMapOptions = {},
): string {
  try {
    const maps = getOrBuildRepoMap(workspaceRoot, opts);
    const body = formatRepoMap(maps, opts.maxChars ?? DEFAULT_MAX_CHARS);
    return body;
  } catch {
    return '';
  }
}

/** Async compatibility entry point; uses the same portable extractor. */
export async function buildRepoMapAsync(
  workspaceRoot: string,
  opts: RepoMapOptions & { cqrRoot?: string } = {},
): Promise<RepoFileMap[]> {
  return buildRepoMap(workspaceRoot, opts);
}
