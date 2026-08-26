/**
 * Workspace index (A): always-on repo map + queryable search hits for code agent.
 * Hybrid retrieval: repo-map labels + FTS/rg hits + symbol-window bodies.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { focusTokensFromMessage, buildRepoMapContext } from './repo-map.js';
import { buildSymbolChunkContext } from './agent-symbol-chunks.js';
import { buildEmbeddingSearchContext, invalidateEmbeddingIndex } from './agent-embedding-index.js';
import {
  invalidateWorkspaceSearchCache,
  searchWorkspaceFilesAdvanced,
  type SearchHit,
} from '../workspace-search.js';

const MAX_QUERY_CHARS = 3_500;
const MAX_HITS_PER_QUERY = 8;
const MAX_QUERIES = 3;
const MAX_SYMBOL_CHARS = 7_000;
const MAX_EMBED_CHARS = 4_500;

/** Prefer error-like / path-like tokens for pre-search. */
export function indexQueryCandidatesFromMessage(message: string): string[] {
  const out: string[] = [];
  const push = (q: string) => {
    const t = q.trim();
    if (t.length < 3 || t.length > 80) return;
    if (!out.includes(t)) out.push(t);
  };

  for (const m of message.matchAll(
    /\b(?:TS\d{3,5}|error\s+[A-Z]\d+|E\d{4}|Cannot find module ['"][^'"]+['"])\b/gi,
  )) {
    push(m[0]);
  }
  for (const m of message.matchAll(
    /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.\w{1,8}|[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|cs|xaml|json|md))\b/g,
  )) {
    push(m[1]);
  }
  for (const t of focusTokensFromMessage(message)) {
    if (/[A-Z]/.test(t) || t.includes('_') || t.includes('-') || /[가-힣]/.test(t)) {
      push(t);
    }
  }

  return out.slice(0, MAX_QUERIES);
}

export function formatSearchHitsBlock(hits: SearchHit[], title: string): string {
  if (!hits.length) return '';
  const lines = hits.slice(0, MAX_HITS_PER_QUERY).map((h) => {
    const text = h.text.length > 120 ? `${h.text.slice(0, 117)}…` : h.text;
    return `- ${h.path}:${h.line}  ${text}`;
  });
  return [`## ${title}`, ...lines].join('\n');
}

/** Filename hits when content search misses (query is a path/name, not file body text). */
export function findFilesByNameHint(workspaceRoot: string, hint: string, max = 8): SearchHit[] {
  const needle = hint.replace(/^.*[/\\]/, '').toLowerCase();
  if (needle.length < 3) return [];
  const stem = needle.replace(/\.[a-z0-9]{1,8}$/i, '');
  const hits: SearchHit[] = [];

  const walk = (rel: string, depth: number): void => {
    if (hits.length >= max || depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(path.join(workspaceRoot, rel));
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= max) break;
      if (
        name === 'node_modules'
        || name === '.git'
        || name === 'dist'
        || name === 'build'
        || name === '.venv'
      ) {
        continue;
      }
      const childRel = rel === '.' ? name : `${rel}/${name}`.replace(/\\/g, '/');
      let st;
      try {
        st = statSync(path.join(workspaceRoot, childRel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(childRel, depth + 1);
        continue;
      }
      const lower = name.toLowerCase();
      if (lower === needle || (stem.length >= 3 && lower.includes(stem))) {
        hits.push({
          path: childRel.replace(/\\/g, '/'),
          line: 1,
          text: `(filename match: ${name})`,
          score: lower === needle ? 10 : 5,
        });
      }
    }
  };

  walk('.', 0);
  return hits;
}

/** Pre-run workspace search for the user message (no tool call required). */
export function buildQuerySearchContext(
  workspaceRoot: string,
  message: string,
  maxChars = MAX_QUERY_CHARS,
): string {
  const queries = indexQueryCandidatesFromMessage(message);
  for (const q of [...queries]) {
    const base = q.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]{1,8}$/i, '');
    if (base.length >= 3 && !queries.includes(base)) queries.push(base);
  }
  if (!queries.length) return '';

  invalidateWorkspaceSearchCache(workspaceRoot);

  const sections: string[] = [
    '## Query search hits (index — prefer over guessing paths)',
  ];
  let used = sections[0].length;
  const seenHit = new Set<string>();

  for (const q of queries.slice(0, MAX_QUERIES + 2)) {
    let hits: SearchHit[] = [];
    try {
      hits = searchWorkspaceFilesAdvanced(workspaceRoot, q, { maxHits: MAX_HITS_PER_QUERY });
    } catch {
      hits = [];
    }
    if (!hits.length) {
      hits = findFilesByNameHint(workspaceRoot, q, MAX_HITS_PER_QUERY);
    }
    hits = hits.filter((h) => {
      const key = `${h.path}:${h.line}:${h.text.slice(0, 40)}`;
      if (seenHit.has(key)) return false;
      seenHit.add(key);
      return true;
    });
    if (!hits.length) continue;
    const block = formatSearchHitsBlock(hits, `search: ${q}`);
    if (!block) continue;
    if (used + block.length + 2 > maxChars) {
      sections.push('… (query search truncated)');
      break;
    }
    sections.push(block);
    used += block.length + 1;
  }

  return sections.length > 1 ? sections.join('\n\n') : '';
}

/**
 * Ensure repo-map is present and append query hits + symbol windows.
 * Safe to call when a lighter workspaceContext already exists.
 */
export function enrichWorkspaceIndexContext(
  workspaceRoot: string,
  existingContext: string | undefined,
  focusMessage: string,
  opts?: {
    repoMapMaxChars?: number;
    queryMaxChars?: number;
    symbolMaxChars?: number;
    embeddingMaxChars?: number;
    cqrRoot?: string;
  },
): string {
  const base = (existingContext ?? '').trim();
  const parts: string[] = [];

  if (base) parts.push(base);

  const hasMap = /##\s*Repository map/i.test(base);
  if (!hasMap) {
    try {
      const map = buildRepoMapContext(workspaceRoot, {
        maxChars: opts?.repoMapMaxChars ?? 6_000,
        focusTokens: focusTokensFromMessage(focusMessage),
      });
      if (map.trim()) parts.push(map);
    } catch {
      /* ignore */
    }
  }

  const hits = buildQuerySearchContext(
    workspaceRoot,
    focusMessage,
    opts?.queryMaxChars ?? MAX_QUERY_CHARS,
  );
  if (hits.trim()) parts.push(hits);

  const hasWindows = /##\s*Adjacent code \(symbol windows/i.test(base);
  if (!hasWindows) {
    try {
      const windows = buildSymbolChunkContext(workspaceRoot, focusMessage, {
        maxChars: opts?.symbolMaxChars ?? MAX_SYMBOL_CHARS,
      });
      if (windows.trim()) parts.push(windows);
    } catch {
      /* ignore */
    }
  }

  const hasEmbed = /##\s*Embedding retrieval/i.test(base);
  if (!hasEmbed && focusMessage.trim()) {
    try {
      const embed = buildEmbeddingSearchContext(workspaceRoot, focusMessage, {
        maxChars: opts?.embeddingMaxChars ?? MAX_EMBED_CHARS,
        cqrRoot: opts?.cqrRoot,
      });
      if (embed.trim()) parts.push(embed);
    } catch {
      /* ignore */
    }
  }

  return parts.filter(Boolean).join('\n\n');
}

/** Invalidate FTS + embedding caches together (mutations). */
export function invalidateWorkspaceIndexes(workspaceRoot?: string): void {
  invalidateWorkspaceSearchCache(workspaceRoot);
  invalidateEmbeddingIndex(workspaceRoot);
}
