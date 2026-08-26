import { normalizeAgentPath } from './agent-grounding.js';

/** Accept raw JSON or the `[tool=... path=...]` envelope used in agent messages. */
export function externalReportReadTargetsFromOutput(raw: string): string[] {
  const body = String(raw || '').replace(/^\[[^\]]+\]\s*\r?\n/, '').trim();
  try {
    const doc = JSON.parse(body) as {
      entries?: Array<{ name?: string; path?: string; is_dir?: boolean }>;
    };
    if (!Array.isArray(doc.entries)) return [];
    const candidates = new Set<string>();
    for (const entry of doc.entries) {
      if (entry.is_dir || !entry.name) continue;
      if (!/(?:manifest\.json|package\.json|README(?:\.md)?|background\.[cm]?[jt]s|main\.[cm]?[jt]s|index\.[cm]?[jt]sx?)$/i.test(entry.name)) {
        continue;
      }
      candidates.add(normalizeAgentPath(entry.path || entry.name));
    }
    const priority = (target: string): number => {
      if (/manifest\.json$/i.test(target)) return 0;
      if (/package\.json$/i.test(target)) return 1;
      if (/background\.[cm]?[jt]s$/i.test(target)) return 2;
      if (/README(?:\.md)?$/i.test(target)) return 3;
      return 4;
    };
    return [...candidates]
      .filter(Boolean)
      .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  } catch {
    return [];
  }
}
