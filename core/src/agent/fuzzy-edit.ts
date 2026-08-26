/**
 * Tolerant fuzzy SEARCH/REPLACE:
 * exact → EOL → trailing WS → indent-insensitive → blank-line flexible →
 * line-trimmed → unique first/last-line anchors.
 */

export interface FuzzyReplaceResult {
  ok: boolean;
  content: string;
  message: string;
  mode: 'exact' | 'fuzzy' | 'none';
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripTrailingWsPerLine(s: string): string {
  return normalizeEol(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
}

/** Collapse 2+ blank lines to one to tolerate blank-line drift. */
function collapseBlankLines(s: string): string {
  return normalizeEol(s).replace(/\n{3,}/g, '\n\n');
}

function commonIndent(lines: string[]): string {
  let indent: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^[ \t]*/);
    const ind = m ? m[0] : '';
    if (indent === null) indent = ind;
    else {
      let i = 0;
      while (i < indent.length && i < ind.length && indent[i] === ind[i]) i++;
      indent = indent.slice(0, i);
    }
  }
  return indent ?? '';
}

function dedentBlock(block: string): string {
  const lines = normalizeEol(block).split('\n');
  const ind = commonIndent(lines);
  if (!ind) return lines.join('\n');
  return lines.map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l)).join('\n');
}

function lineTrimKey(block: string): string {
  return normalizeEol(block)
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
}

function reindentTo(windowLines: string[], newText: string): string[] {
  const ind = commonIndent(windowLines);
  const nDedent = dedentBlock(newText).split('\n');
  return nDedent.map((l, li) => {
    if (!l.trim() && li === nDedent.length - 1) return l;
    return l.trim() ? ind + l : l;
  });
}

function replaceWindow(
  cLines: string[],
  start: number,
  len: number,
  newText: string,
): string {
  const window = cLines.slice(start, start + len);
  const rebuilt = reindentTo(window, newText);
  return [...cLines.slice(0, start), ...rebuilt, ...cLines.slice(start + len)].join('\n');
}

/** Line-trimmed match: each line compared after trim(); file indent preserved. */
function tryLineTrimmed(
  content: string,
  oldText: string,
  newText: string,
): FuzzyReplaceResult | null {
  const cLines = normalizeEol(content).split('\n');
  const oKey = lineTrimKey(oldText);
  const oLines = oKey.split('\n');
  if (oLines.length < 1 || oLines.length > 120) return null;
  let found = -1;
  for (let i = 0; i <= cLines.length - oLines.length; i++) {
    const key = cLines
      .slice(i, i + oLines.length)
      .map((l) => l.trim())
      .join('\n');
    if (key !== oKey) continue;
    if (found >= 0) return null; // ambiguous
    found = i;
  }
  if (found < 0) return null;
  return {
    ok: true,
    content: replaceWindow(cLines, found, oLines.length, newText),
    message: `fuzzy: line-trimmed @ line ${found + 1}`,
    mode: 'fuzzy',
  };
}

/**
 * Unique anchor: first + last non-empty lines of old_text uniquely locate a window,
 * then require middle line-trim similarity ≥ 0.6 (Codex near-miss).
 */
function tryUniqueAnchors(
  content: string,
  oldText: string,
  newText: string,
): FuzzyReplaceResult | null {
  const cLines = normalizeEol(content).split('\n');
  const oLines = normalizeEol(oldText).split('\n');
  if (oLines.length < 4 || oLines.length > 120) return null;
  const head = oLines.find((l) => l.trim())?.trim();
  const tail = [...oLines].reverse().find((l) => l.trim())?.trim();
  if (!head || !tail || head === tail) return null;

  const headHits: number[] = [];
  const tailHits: number[] = [];
  for (let i = 0; i < cLines.length; i++) {
    if (cLines[i]!.trim() === head) headHits.push(i);
    if (cLines[i]!.trim() === tail) tailHits.push(i);
  }
  if (headHits.length !== 1 || tailHits.length !== 1) return null;
  const start = headHits[0]!;
  const end = tailHits[0]!;
  if (end < start || end - start + 1 > 200) return null;
  const window = cLines.slice(start, end + 1);
  const oSet = new Set(oLines.map((l) => l.trim()).filter(Boolean));
  const wSet = new Set(window.map((l) => l.trim()).filter(Boolean));
  let inter = 0;
  for (const x of oSet) if (wSet.has(x)) inter++;
  const union = new Set([...oSet, ...wSet]).size || 1;
  const jaccard = inter / union;
  if (jaccard < 0.6) return null;
  return {
    ok: true,
    content: replaceWindow(cLines, start, end - start + 1, newText),
    message: `fuzzy: unique-anchors jaccard=${jaccard.toFixed(2)} @ line ${start + 1}`,
    mode: 'fuzzy',
  };
}

/** Find oldText in content with fuzzy strategies; return replacement content. */
export function fuzzyReplaceOnce(
  content: string,
  oldText: string,
  newText: string,
): FuzzyReplaceResult {
  if (!oldText) {
    return { ok: false, content, message: 'old_text is required', mode: 'none' };
  }

  const exactIdx = content.indexOf(oldText);
  if (exactIdx >= 0) {
    const next = content.slice(0, exactIdx) + newText + content.slice(exactIdx + oldText.length);
    return { ok: true, content: next, message: 'exact match', mode: 'exact' };
  }

  // Normalized EOL
  const cEol = normalizeEol(content);
  const oEol = normalizeEol(oldText);
  const nEol = normalizeEol(newText);
  let idx = cEol.indexOf(oEol);
  if (idx >= 0) {
    const next = cEol.slice(0, idx) + nEol + cEol.slice(idx + oEol.length);
    return { ok: true, content: next, message: 'fuzzy: EOL normalized', mode: 'fuzzy' };
  }

  // Trailing whitespace per line
  const cTrim = stripTrailingWsPerLine(content);
  const oTrim = stripTrailingWsPerLine(oldText);
  idx = cTrim.indexOf(oTrim);
  if (idx >= 0) {
    const next = cTrim.slice(0, idx) + stripTrailingWsPerLine(newText) + cTrim.slice(idx + oTrim.length);
    return { ok: true, content: next, message: 'fuzzy: trailing whitespace', mode: 'fuzzy' };
  }

  // Blank-line collapse
  const cBlank = collapseBlankLines(content);
  const oBlank = collapseBlankLines(oldText);
  idx = cBlank.indexOf(oBlank);
  if (idx >= 0) {
    const next = cBlank.slice(0, idx) + collapseBlankLines(newText) + cBlank.slice(idx + oBlank.length);
    return { ok: true, content: next, message: 'fuzzy: blank-line collapse', mode: 'fuzzy' };
  }

  // Indent-insensitive: find dedented needle inside dedented windows
  const oDedent = dedentBlock(oldText);
  const cLines = normalizeEol(content).split('\n');
  const oLines = oDedent.split('\n');
  if (oLines.length >= 1 && oLines.length <= 80) {
    for (let i = 0; i <= cLines.length - oLines.length; i++) {
      const window = cLines.slice(i, i + oLines.length);
      if (dedentBlock(window.join('\n')) !== oDedent) continue;
      return {
        ok: true,
        content: replaceWindow(cLines, i, oLines.length, newText),
        message: `fuzzy: indent-insensitive @ line ${i + 1}`,
        mode: 'fuzzy',
      };
    }
  }

  const lineTrim = tryLineTrimmed(content, oldText, newText);
  if (lineTrim) return lineTrim;

  const anchors = tryUniqueAnchors(content, oldText, newText);
  if (anchors) return anchors;

  return { ok: false, content, message: 'old_text not found (exact+fuzzy)', mode: 'none' };
}

export function fuzzyReplaceAll(
  content: string,
  oldText: string,
  newText: string,
): FuzzyReplaceResult {
  if (!oldText) {
    return { ok: false, content, message: 'old_text is required', mode: 'none' };
  }
  if (content.includes(oldText)) {
    const parts = content.split(oldText);
    const count = parts.length - 1;
    return {
      ok: true,
      content: parts.join(newText),
      message: `exact replace_all (${count})`,
      mode: 'exact',
    };
  }

  // Fuzzy replace_all: repeatedly apply fuzzyReplaceOnce
  let next = content;
  let count = 0;
  let mode: 'exact' | 'fuzzy' = 'fuzzy';
  for (let i = 0; i < 50; i++) {
    const r = fuzzyReplaceOnce(next, oldText, newText);
    if (!r.ok) break;
    next = r.content;
    count++;
    if (r.mode === 'exact') mode = 'exact';
  }
  if (!count) {
    return { ok: false, content, message: 'old_text not found (replace_all)', mode: 'none' };
  }
  return {
    ok: true,
    content: next,
    message: `fuzzy replace_all (${count})`,
    mode,
  };
}
