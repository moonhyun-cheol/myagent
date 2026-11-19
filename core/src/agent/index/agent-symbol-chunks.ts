/**
 * Symbol-window retrieval (AST-lite chunking): pull function/class bodies
 * around ranked repo-map hits so the model gets adjacent code, not labels only.
 */
import { readFileSync } from 'node:fs';
import { resolveDevWorkspaceReadPath } from '../../security/dev-workspace-guard.js';
import {
  queryRepoMap,
  requestSearchSeeds,
  type RepoSymbol,
} from './repo-map.js';

const DEFAULT_MAX_CHARS = 4_500;
const DEFAULT_MAX_CHUNKS = 6;
const DEFAULT_CONTEXT_LINES = 28;

/** Symbol-window seeds: same rule as query search hits (repo-map requestSearchSeeds). */
const MAX_SEEDS = 5;

export interface SymbolChunk {
  path: string;
  kind: RepoSymbol['kind'] | 'hit';
  name: string;
  startLine: number;
  endLine: number;
  body: string;
}

function sliceWindow(
  lines: string[],
  centerLine: number,
  contextLines: number,
): { start: number; end: number; body: string } {
  const idx = Math.max(0, Math.min(lines.length - 1, centerLine - 1));
  const start = Math.max(0, idx - Math.floor(contextLines / 4));
  let end = Math.min(lines.length, idx + contextLines);
  // Prefer closing at a blank line or brace so chunks look like units.
  for (let i = idx + 1; i < end; i++) {
    if (/^\s*[{}]\s*$/.test(lines[i]!) && i > idx + 3) {
      end = Math.min(lines.length, i + 1);
      break;
    }
  }
  const body = lines.slice(start, end).join('\n');
  return { start: start + 1, end, body };
}

/** Ranked symbol windows for dynamic prompt assembly. */
export function collectSymbolChunks(
  workspaceRoot: string,
  message: string,
  opts?: { maxChunks?: number; contextLines?: number },
): SymbolChunk[] {
  const maxChunks = opts?.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const contextLines = opts?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const uniqQ = requestSearchSeeds(message, MAX_SEEDS);
  if (!uniqQ.length) return [];

  const chunks: SymbolChunk[] = [];
  const seen = new Set<string>();

  for (const q of uniqQ) {
    let hits: ReturnType<typeof queryRepoMap> = [];
    try {
      hits = queryRepoMap(workspaceRoot, q, { maxResults: 8 });
    } catch {
      continue;
    }
    for (const hit of hits) {
      for (const sym of hit.symbols.slice(0, 3)) {
        const key = `${hit.path}:${sym.line}:${sym.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let content: string;
        try {
          const abs = resolveDevWorkspaceReadPath(workspaceRoot, hit.path);
          content = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        const win = sliceWindow(lines, sym.line, contextLines);
        chunks.push({
          path: hit.path.replace(/\\/g, '/'),
          kind: sym.kind,
          name: sym.name,
          startLine: win.start,
          endLine: win.end,
          body: win.body.slice(0, 2_400),
        });
        if (chunks.length >= maxChunks) return chunks;
      }
    }
  }
  return chunks;
}

export function formatSymbolChunksBlock(
  chunks: SymbolChunk[],
  maxChars = DEFAULT_MAX_CHARS,
): string {
  if (!chunks.length) return '';
  const lines: string[] = [
    '## Adjacent code (symbol windows — prefer these over guessing)',
    '',
  ];
  let used = lines.join('\n').length;

  for (const c of chunks) {
    const header = `### ${c.path}:${c.startLine}-${c.endLine}  ${c.kind} ${c.name}`;
    const fence = '```';
    const block = `${header}\n${fence}\n${c.body}\n${fence}`;
    if (used + block.length + 2 > maxChars) {
      lines.push('… (symbol windows truncated)');
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }
  return lines.join('\n');
}

/** Budget-capped symbol windows for code-agent system prompt. */
export function buildSymbolChunkContext(
  workspaceRoot: string,
  message: string,
  opts?: { maxChars?: number; maxChunks?: number; contextLines?: number },
): string {
  try {
    const chunks = collectSymbolChunks(workspaceRoot, message, opts);
    return formatSymbolChunksBlock(chunks, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  } catch {
    return '';
  }
}
