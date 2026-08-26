import path from 'node:path';

/** Tracks paths inspected this agent run — mutate tools must touch known paths. */
export class WorkspaceReadGate {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();

  static normalizeRel(rel: string): string {
    const raw = rel.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!raw || raw === '.') return '.';
    const parts = raw.split('/').filter((p) => p && p !== '.');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') {
        if (out.length) out.pop();
        continue;
      }
      out.push(p);
    }
    return out.join('/') || '.';
  }

  noteReadFile(rel: string): void {
    const n = WorkspaceReadGate.normalizeRel(rel);
    if (n !== '.') this.files.add(n);
  }

  /** True when this run (or session seed) already marked the path as read. */
  hasReadFile(rel: string): boolean {
    return this.isKnownFile(rel);
  }

  noteListDirectory(rel: string): void {
    this.dirs.add(WorkspaceReadGate.normalizeRel(rel));
  }

  noteWritten(rel: string): void {
    this.noteReadFile(rel);
  }

  private parentDir(rel: string): string {
    const n = WorkspaceReadGate.normalizeRel(rel);
    if (n === '.' || !n.includes('/')) return '.';
    return n.slice(0, n.lastIndexOf('/')) || '.';
  }

  private isKnownFile(rel: string): boolean {
    return this.files.has(WorkspaceReadGate.normalizeRel(rel));
  }

  private isKnownDir(rel: string): boolean {
    return this.dirs.has(WorkspaceReadGate.normalizeRel(rel));
  }

  /** Null = ok; otherwise ERROR string for the model. */
  assertCanMutate(toolName: string, args: Record<string, unknown>): string | null {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const rel = typeof args.path === 'string' ? args.path : '';
      if (!rel.trim()) return null;
      const n = WorkspaceReadGate.normalizeRel(rel);
      if (this.isKnownFile(n)) return null;
      // New file: parent directory must have been listed (or root listed).
      const parent = this.parentDir(n);
      if (this.isKnownDir(parent) || this.isKnownDir('.')) return null;
      return [
        'ERROR: read_before_write',
        `path: ${n}`,
        'Call read_file on this path first before edit/write.',
        'For a brand-new file, call list_directory on the parent folder first, then write_file.',
      ].join('\n');
    }

    if (toolName === 'delete_file' || toolName === 'rename_file') {
      const rel = typeof args.path === 'string' ? args.path : '';
      if (!rel.trim()) return null;
      const n = WorkspaceReadGate.normalizeRel(rel);
      if (this.isKnownFile(n)) return null;
      return [
        'ERROR: read_before_write',
        `path: ${n}`,
        `Call read_file on this path before ${toolName}.`,
      ].join('\n');
    }

    if (toolName === 'apply_patch') {
      const paths = extractPatchPaths(args);
      const missing = paths.filter((p) => !this.isKnownFile(p) && !this.isKnownDir(this.parentDir(p)) && !this.isKnownDir('.'));
      if (!missing.length) return null;
      return [
        'ERROR: read_before_write',
        `unread_paths: ${missing.join(', ')}`,
        'Call read_file on each path (or list_directory on parent for new files) before apply_patch.',
      ].join('\n');
    }

    return null;
  }

  /**
   * Rehydrate gate from prior assistant tool_calls in this run.
   * Prevents false read_before_write when noteReadFile was skipped (self-correction / protocol switch).
   */
  syncFromAssistantToolCalls(
    toolCalls: Array<{ function?: { name?: string; arguments?: string } }>,
  ): void {
    for (const call of toolCalls) {
      const name = call.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      if (name === 'read_file' && typeof args.path === 'string') {
        this.noteReadFile(args.path);
      } else if (name === 'list_directory') {
        this.noteListDirectory(typeof args.path === 'string' ? args.path : '.');
      } else if (
        (name === 'write_file' || name === 'edit_file')
        && typeof args.path === 'string'
      ) {
        this.noteWritten(args.path);
      }
    }
  }
}

/** Paths named in a read_before_write ERROR (for Cursor-like auto-read heal). */
export function unreadPathsFromReadBeforeWriteError(err: string): string[] {
  const t = String(err || '');
  if (!/ERROR:\s*read_before_write/i.test(t)) return [];
  const out: string[] = [];
  const multi = t.match(/unread_paths:\s*([^\n]+)/i);
  if (multi?.[1]) {
    for (const p of multi[1].split(/[,，]/)) {
      const n = WorkspaceReadGate.normalizeRel(p.trim());
      if (n && n !== '.') out.push(n);
    }
  }
  const single = t.match(/(?:^|\n)path:\s*(\S+)/i);
  if (single?.[1]) {
    const n = WorkspaceReadGate.normalizeRel(single[1].trim());
    if (n && n !== '.') out.push(n);
  }
  return [...new Set(out)];
}

function extractPatchPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const patches = args.patches;
  if (Array.isArray(patches)) {
    for (const row of patches) {
      if (row && typeof row === 'object' && typeof (row as { path?: unknown }).path === 'string') {
        out.push(WorkspaceReadGate.normalizeRel((row as { path: string }).path));
      }
    }
  }
  const single = typeof args.path === 'string' ? args.path : '';
  if (single) out.push(WorkspaceReadGate.normalizeRel(single));
  const patchText = typeof args.patch === 'string' ? args.patch : typeof args.input === 'string' ? args.input : '';
  if (patchText) {
    for (const m of patchText.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(\S+)/gm)) {
      out.push(WorkspaceReadGate.normalizeRel(m[1]));
    }
    for (const m of patchText.matchAll(/^diff --git a\/(\S+)/gm)) {
      out.push(WorkspaceReadGate.normalizeRel(m[1]));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const doc = JSON.parse(raw || '{}') as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function pathPosix(rel: string): string {
  return path.posix.normalize(rel.replace(/\\/g, '/'));
}
