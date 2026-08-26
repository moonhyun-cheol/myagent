export type RetrievalHitLike = {
  path: string;
  preview: string;
  score: number;
};

/** Pure retrieval-result dedupe; intentionally has no persistence/database dependency. */
export function dedupeEmbeddingHits<T extends RetrievalHitLike>(hits: T[], maxHits = 8): T[] {
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();
  const out: T[] = [];
  const ranked = [...hits].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const hit of ranked) {
    const pathKey = hit.path.replace(/\\/g, '/').toLowerCase();
    const contentKey = hit.preview.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seenPaths.has(pathKey) || (contentKey && seenContent.has(contentKey))) continue;
    seenPaths.add(pathKey);
    if (contentKey) seenContent.add(contentKey);
    out.push(hit);
    if (out.length >= maxHits) break;
  }
  return out;
}
