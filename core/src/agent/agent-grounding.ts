/**
 * Path helpers shared by grounding-related checks (read evidence, mutation paths).
 */

export function normalizeAgentPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** Successful read_file paths from assistant tool_calls that already ran (message list). */
export function collectReadPathsFromMessages(
  messages: Array<{ role?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }>,
): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) {
      if (call.function?.name !== 'read_file') continue;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as { path?: string };
        if (typeof args.path === 'string' && args.path.trim()) {
          out.add(normalizeAgentPath(args.path));
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}
