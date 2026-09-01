/** Mechanical status produced only by an explicit diagnostics tool call. */
export type DiagnosticsEvidenceStatus = true | false | null | 'weak';

export function diagnosticsEvidenceStatus(diag: {
  ok?: boolean;
  skipped?: boolean;
  weak?: boolean;
} | null): DiagnosticsEvidenceStatus {
  if (!diag || typeof diag.ok !== 'boolean') return null;
  if (diag.ok === false && !diag.skipped) return false;
  if (diag.skipped === true || diag.weak === true) return 'weak';
  return diag.ok === true ? true : 'weak';
}

const PATH_IN_PROSE_RE =
  /(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|html|css|json|py|cs|xaml|md)/gi;

/** Explicit path hints only; this function never classifies intent or selects tools. */
export function extractPathsFromUserMessage(message: string, maxPaths = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of String(message || '').matchAll(PATH_IN_PROSE_RE)) {
    const filePath = hit[0].replace(/\\/g, '/');
    const key = filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(filePath);
    if (out.length >= maxPaths) break;
  }
  return out;
}
