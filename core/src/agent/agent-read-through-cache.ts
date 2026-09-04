import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import {
  resolveDevWorkspaceReadPath,
  type WorkspaceGuardOptions,
} from '../security/dev-workspace-guard.js';
import { isNasPath } from '../security/path-guard.js';

const CACHE_VERSION = 1 as const;
const MAX_CACHE_ENTRIES = 1_024;
const MAX_CACHE_SOURCE_BYTES = 2_000_000;
export const MAX_COMPLETE_READ_BYTES = 120_000;
export const MAX_COMPLETE_READ_LINES = 1_200;

type ReadCacheEntry = {
  version: typeof CACHE_VERSION;
  source_key: string;
  stat_fingerprint: string;
  content_sha256: string;
  content: string;
};

export type CachedWorkspaceRead = {
  text: string;
  cache: 'hit' | 'miss' | 'bypass';
  content_sha256: string;
  stat_fingerprint: string;
  total_lines: number;
  start_line: number;
  end_line: number;
  status: 'exact' | 'selection_required' | 'range_too_large';
  complete: boolean;
  returned_ranges: Array<{ start: number; end: number }>;
  omitted_ranges: Array<{ start: number; end: number }>;
  suggested_max_lines: number;
  outline?: Array<{ label: string; start_line: number }>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceKey(absPath: string): string {
  const normalized = path.resolve(absPath).replace(/\\/g, '/');
  return sha256(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function statFingerprint(st: Stats): string {
  return sha256([
    st.size,
    st.mtimeMs,
    st.ctimeMs,
    String(st.dev),
    String(st.ino),
  ].join('|'));
}

export function agentReadCacheDir(cqrRoot: string): string {
  return path.join(path.resolve(cqrRoot), 'data', 'cache', 'tool-reads-v1');
}

function entryPath(cqrRoot: string, absPath: string): string {
  return path.join(agentReadCacheDir(cqrRoot), `${sourceKey(absPath)}.json`);
}

function loadEntry(filePath: string, expectedSource: string, expectedStat: string): ReadCacheEntry | null {
  if (!existsSync(filePath)) return null;
  try {
    const entry = JSON.parse(readFileSync(filePath, 'utf8')) as ReadCacheEntry;
    if (
      entry.version !== CACHE_VERSION
      || entry.source_key !== expectedSource
      || entry.stat_fingerprint !== expectedStat
      || sha256(entry.content) !== entry.content_sha256
    ) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function pruneCache(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtimeMs: statSync(file).mtimeMs };
      });
    if (entries.length <= MAX_CACHE_ENTRIES) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries.slice(0, entries.length - MAX_CACHE_ENTRIES)) {
      try { unlinkSync(entry.file); } catch { /* best-effort eviction */ }
    }
  } catch {
    /* cache pruning must never block a source read */
  }
}

function saveEntry(cqrRoot: string, absPath: string, entry: ReadCacheEntry): void {
  try {
    const dir = agentReadCacheDir(cqrRoot);
    mkdirSync(dir, { recursive: true });
    const target = entryPath(cqrRoot, absPath);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(entry)}\n`, 'utf8');
    renameSync(temp, target);
    pruneCache(dir);
  } catch {
    /* read-through cache is an optimization; the live read remains authoritative */
  }
}

function sliceLines(content: string, startLine?: number, endLine?: number) {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const start = Math.min(total, Math.max(1, Math.trunc(startLine ?? 1)));
  const end = Math.max(start, Math.min(total, Math.trunc(endLine ?? total)));
  return {
    text: lines.slice(start - 1, end).join('\n'),
    total,
    start: Math.min(start, total),
    end,
  };
}

function readAuthoritativeText(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}

function buildOutline(content: string): Array<{ label: string; start_line: number }> {
  const outline: Array<{ label: string; start_line: number }> = [];
  const lines = content.split(/\r?\n/);
  const heading = /^(?:#{1,6}\s+.+|(?:export\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const)\s+[A-Za-z_$][\w$]*)/;
  for (let i = 0; i < lines.length && outline.length < 80; i += 1) {
    const text = lines[i]?.trim() ?? '';
    if (heading.test(text)) outline.push({ label: text.slice(0, 180), start_line: i + 1 });
  }
  if (!outline.length) {
    const stride = Math.max(1, Math.ceil(lines.length / 12));
    for (let i = 0; i < lines.length; i += stride) {
      const label = lines.slice(i, Math.min(lines.length, i + 20)).find((line) => line.trim())?.trim();
      outline.push({ label: (label || `Lines ${i + 1}+`).slice(0, 180), start_line: i + 1 });
    }
  }
  return outline;
}

function omittedAround(start: number, end: number, total: number): Array<{ start: number; end: number }> {
  const omitted: Array<{ start: number; end: number }> = [];
  if (start > 1) omitted.push({ start: 1, end: start - 1 });
  if (end < total) omitted.push({ start: end + 1, end: total });
  return omitted;
}

/**
 * Permission/path checks and a live stat always precede a cache hit. The cache stores exact
 * source text, never an LLM answer. NAS reads bypass the cache because remote metadata may lag.
 */
export function readWorkspaceFileThroughCache(input: {
  cqrRoot?: string;
  workspaceRoot: string;
  relPath: string;
  guard?: WorkspaceGuardOptions;
  fresh?: boolean;
  startLine?: number;
  endLine?: number;
}): CachedWorkspaceRead {
  const abs = resolveDevWorkspaceReadPath(input.workspaceRoot, input.relPath);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${input.relPath}`);
  const statHash = statFingerprint(st);
  const key = sourceKey(abs);
  const mayPersist = Boolean(input.cqrRoot) && !isNasPath(abs) && st.size <= MAX_CACHE_SOURCE_BYTES;
  const cachePath = mayPersist ? entryPath(input.cqrRoot!, abs) : null;
  const entry = !input.fresh && cachePath
    ? loadEntry(cachePath, key, statHash)
    : null;

  let content: string;
  let cache: CachedWorkspaceRead['cache'];
  let contentHash: string;
  if (entry) {
    content = entry.content;
    contentHash = entry.content_sha256;
    cache = 'hit';
  } else {
    content = readAuthoritativeText(abs);
    contentHash = sha256(content);
    cache = input.fresh || !mayPersist ? 'bypass' : 'miss';
    if (mayPersist) {
      saveEntry(input.cqrRoot!, abs, {
        version: CACHE_VERSION,
        source_key: key,
        stat_fingerprint: statHash,
        content_sha256: contentHash,
        content,
      });
    }
  }

  const sliced = sliceLines(content, input.startLine, input.endLine);
  const selectedBytes = Buffer.byteLength(sliced.text, 'utf8');
  const selectedLines = Math.max(0, sliced.end - sliced.start + 1);
  const averageBytesPerLine = Math.max(1, Buffer.byteLength(content, 'utf8') / Math.max(1, sliced.total));
  const suggestedMaxLines = Math.max(
    1,
    Math.min(MAX_COMPLETE_READ_LINES, Math.floor(MAX_COMPLETE_READ_BYTES / averageBytesPerLine)),
  );
  const tooLarge = selectedBytes > MAX_COMPLETE_READ_BYTES || selectedLines > MAX_COMPLETE_READ_LINES;
  const explicitRange = input.startLine != null || input.endLine != null;
  const status: CachedWorkspaceRead['status'] = tooLarge
    ? explicitRange ? 'range_too_large' : 'selection_required'
    : 'exact';
  const returnedRanges = status === 'exact' ? [{ start: sliced.start, end: sliced.end }] : [];
  const omittedRanges = status === 'exact'
    ? omittedAround(sliced.start, sliced.end, sliced.total)
    : [{ start: 1, end: sliced.total }];
  return {
    text: status === 'exact' ? sliced.text : '',
    cache,
    content_sha256: contentHash,
    stat_fingerprint: statHash,
    total_lines: sliced.total,
    start_line: sliced.start,
    end_line: sliced.end,
    status,
    complete: status === 'exact',
    returned_ranges: returnedRanges,
    omitted_ranges: omittedRanges,
    suggested_max_lines: suggestedMaxLines,
    ...(status === 'exact' ? {} : { outline: buildOutline(content) }),
  };
}

export function invalidateWorkspaceReadCache(
  cqrRoot: string | undefined,
  workspaceRoot: string,
  relPath: string,
): void {
  if (!cqrRoot) return;
  try {
    const abs = resolveDevWorkspaceReadPath(workspaceRoot, relPath);
    const target = entryPath(cqrRoot, abs);
    if (existsSync(target)) unlinkSync(target);
  } catch {
    /* a missing/deleted source is already an effective cache invalidation */
  }
}
