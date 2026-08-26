import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveDevWorkspaceReadPath,
  resolveDevWorkspaceRelPath,
  type WorkspaceGuardOptions,
} from '../security/dev-workspace-guard.js';
import { fuzzyReplaceAll, fuzzyReplaceOnce } from './fuzzy-edit.js';
import { invalidateWorkspaceSearchCache } from './workspace-search.js';
import {
  invalidateEmbeddingIndex,
  invalidateRepoMapCache,
} from './index/public.js';

export interface PatchEdit {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

export interface FilePatch {
  path: string;
  /** update (default) | add | delete | move */
  action?: 'update' | 'add' | 'delete' | 'move';
  content?: string;
  new_path?: string;
  edits?: PatchEdit[];
}

export interface ApplyPatchResult {
  ok: boolean;
  applied: { path: string; action: string; message: string }[];
  errors: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Apply sequential edits with exact then fuzzy SEARCH/REPLACE fallback. */
export function applyEditsToContent(
  content: string,
  edits: PatchEdit[],
): { ok: boolean; content: string; message: string } {
  let next = content;
  let total = 0;
  const notes: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = edit.old_text ?? '';
    const newText = edit.new_text ?? '';
    if (!oldText) {
      return { ok: false, content, message: `edit[${i}]: old_text is required` };
    }
    const result = edit.replace_all
      ? fuzzyReplaceAll(next, oldText, newText)
      : fuzzyReplaceOnce(next, oldText, newText);
    if (!result.ok) {
      return { ok: false, content, message: `edit[${i}]: ${result.message}` };
    }
    next = result.content;
    total += 1;
    if (result.mode === 'fuzzy') notes.push(`edit[${i}] fuzzy`);
  }
  const extra = notes.length ? `; ${notes.join(', ')}` : '';
  return { ok: true, content: next, message: `applied ${total} replacement(s)${extra}` };
}

/**
 * Parse a compact V4A / Codex-style patch text:
 *
 * *** Begin Patch
 * *** Update File: path/to/file.ts
 * @@
 *  context
 * -old line
 * +new line
 * *** Add File: new.ts
 * +line
 * *** Delete File: gone.ts
 * *** End Patch
 */
export function parsePatchText(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let mode: 'hunk' | 'add' | null = null;
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let addLines: string[] = [];

  const flushHunk = () => {
    if (!current || mode !== 'hunk') return;
    const old_text = oldLines.join('\n');
    const new_text = newLines.join('\n');
    if (old_text || new_text) {
      if (!current.edits) current.edits = [];
      // Keep trailing newline consistency only when both sides had content lines
      current.edits.push({ old_text, new_text });
    }
    oldLines = [];
    newLines = [];
  };

  const flushAdd = () => {
    if (!current || mode !== 'add') return;
    current.content = addLines.join('\n');
    if (current.content && !current.content.endsWith('\n') && addLines.length) {
      /* keep as-is */
    }
    addLines = [];
  };

  const finishFile = () => {
    flushHunk();
    flushAdd();
    if (current) files.push(current);
    current = null;
    mode = null;
  };

  for (const raw of lines) {
    const line = raw;
    if (/^\*\*\*\s*Begin Patch\s*$/i.test(line.trim())) continue;
    if (/^\*\*\*\s*End Patch\s*$/i.test(line.trim())) {
      finishFile();
      break;
    }

    const updateMatch = line.match(/^\*\*\*\s*Update File:\s*(.+)\s*$/i);
    if (updateMatch) {
      finishFile();
      current = { path: updateMatch[1].trim().replace(/\\/g, '/'), action: 'update', edits: [] };
      mode = null;
      continue;
    }
    const addMatch = line.match(/^\*\*\*\s*Add File:\s*(.+)\s*$/i);
    if (addMatch) {
      finishFile();
      current = { path: addMatch[1].trim().replace(/\\/g, '/'), action: 'add', content: '' };
      mode = 'add';
      continue;
    }
    const deleteMatch = line.match(/^\*\*\*\s*Delete File:\s*(.+)\s*$/i);
    if (deleteMatch) {
      finishFile();
      current = { path: deleteMatch[1].trim().replace(/\\/g, '/'), action: 'delete' };
      mode = null;
      continue;
    }
    const moveMatch = line.match(/^\*\*\*\s*(?:Move|Rename) (?:File|to):\s*(.+)\s*$/i);
    if (moveMatch && current?.action === 'update') {
      // *** Move to: new/path
      current.action = 'move';
      current.new_path = moveMatch[1].trim().replace(/\\/g, '/');
      continue;
    }

    if (!current) continue;

    if (line.startsWith('@@')) {
      flushHunk();
      mode = 'hunk';
      continue;
    }

    if (mode === 'add') {
      if (line.startsWith('+')) addLines.push(line.slice(1));
      else if (line.startsWith('***')) {
        /* handled above */
      } else {
        addLines.push(line.startsWith(' ') ? line.slice(1) : line);
      }
      continue;
    }

    if (mode === 'hunk') {
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        const ctx = line.slice(1);
        oldLines.push(ctx);
        newLines.push(ctx);
      } else if (line.trim() === '') {
        oldLines.push('');
        newLines.push('');
      } else {
        // bare context line
        oldLines.push(line);
        newLines.push(line);
      }
    }
  }
  finishFile();
  return files;
}

export function applyFilePatches(
  workspaceRoot: string,
  patches: FilePatch[],
  guard: WorkspaceGuardOptions = {},
): ApplyPatchResult {
  const applied: ApplyPatchResult['applied'] = [];
  const errors: string[] = [];

  type PlannedOp =
    | { kind: 'write'; rel: string; abs: string; content: string; action: string; message: string }
    | { kind: 'delete'; rel: string; abs: string; message: string }
    | {
        kind: 'move';
        rel: string;
        fromAbs: string;
        toAbs: string;
        dest: string;
        message: string;
      };

  const planned: PlannedOp[] = [];

  // Phase 1: validate + stage in memory (no disk writes yet).
  for (const patch of patches) {
    const rel = (patch.path ?? '').trim().replace(/\\/g, '/');
    if (!rel) {
      errors.push('patch entry missing path');
      continue;
    }
    const action =
      patch.action
      ?? (patch.edits?.length ? 'update' : patch.content != null ? 'add' : 'update');

    try {
      if (action === 'delete') {
        const abs = resolveDevWorkspaceRelPath(workspaceRoot, rel, guard);
        if (!existsSync(abs)) {
          errors.push(`delete failed: not found ${rel}`);
          continue;
        }
        planned.push({
          kind: 'delete',
          rel,
          abs,
          message: `Deleted ${rel}`,
        });
        continue;
      }

      if (action === 'move') {
        const dest = (patch.new_path ?? '').trim().replace(/\\/g, '/');
        if (!dest) {
          errors.push(`move failed: new_path required for ${rel}`);
          continue;
        }
        const fromAbs = resolveDevWorkspaceRelPath(workspaceRoot, rel, guard);
        const toAbs = resolveDevWorkspaceRelPath(workspaceRoot, dest, guard);
        if (!existsSync(fromAbs)) {
          errors.push(`move failed: not found ${rel}`);
          continue;
        }
        if (existsSync(toAbs)) {
          errors.push(`move failed: destination exists ${dest}`);
          continue;
        }
        planned.push({
          kind: 'move',
          rel,
          fromAbs,
          toAbs,
          dest,
          message: `Moved ${rel} → ${dest}`,
        });
        continue;
      }

      if (action === 'add') {
        const abs = resolveDevWorkspaceRelPath(workspaceRoot, rel, guard);
        if (existsSync(abs)) {
          errors.push(`add failed: already exists ${rel}`);
          continue;
        }
        planned.push({
          kind: 'write',
          rel,
          abs,
          content: patch.content ?? '',
          action: 'add',
          message: `Created ${rel}`,
        });
        continue;
      }

      // update
      const abs = resolveDevWorkspaceRelPath(workspaceRoot, rel, guard);
      if (!existsSync(abs)) {
        errors.push(`update failed: not found ${rel}`);
        continue;
      }
      const edits = patch.edits ?? [];
      if (!edits.length) {
        if (patch.content != null) {
          planned.push({
            kind: 'write',
            rel,
            abs,
            content: patch.content,
            action: 'update',
            message: `Wrote ${rel}`,
          });
        } else {
          errors.push(`update failed: no edits for ${rel}`);
        }
        continue;
      }
      const before = readFileSync(abs, 'utf8');
      const result = applyEditsToContent(before, edits);
      if (!result.ok) {
        errors.push(`${rel}: ${result.message}`);
        continue;
      }
      planned.push({
        kind: 'write',
        rel,
        abs,
        content: result.content,
        action: 'update',
        message: `${rel}: ${result.message}`,
      });
    } catch (e: unknown) {
      errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Atomicity: if any entry failed validation, write nothing.
  if (errors.length || !planned.length) {
    return {
      ok: false,
      applied: [],
      errors: errors.length
        ? [
            ...errors,
            'ATOMIC_ABORT: no files were written because one or more patch entries failed. Fix hunks (unique old_text + context) and resubmit the full apply_patch.',
          ]
        : ['apply_patch: no valid patch entries'],
    };
  }

  // Phase 2: commit all planned ops.
  for (const op of planned) {
    try {
      if (op.kind === 'delete') {
        unlinkSync(op.abs);
        applied.push({ path: op.rel, action: 'delete', message: op.message });
        continue;
      }
      if (op.kind === 'move') {
        mkdirSync(path.dirname(op.toAbs), { recursive: true });
        renameSync(op.fromAbs, op.toAbs);
        applied.push({ path: op.rel, action: 'move', message: op.message });
        continue;
      }
      mkdirSync(path.dirname(op.abs), { recursive: true });
      writeFileSync(op.abs, op.content, 'utf8');
      applied.push({ path: op.rel, action: op.action, message: op.message });
    } catch (e: unknown) {
      errors.push(
        `commit failed ${op.rel}: ${e instanceof Error ? e.message : String(e)}`,
      );
      // Best-effort: already-written files may remain; surface partial state.
      invalidateWorkspaceSearchCache(workspaceRoot);
      invalidateRepoMapCache(workspaceRoot);
      invalidateEmbeddingIndex(workspaceRoot);
      return {
        ok: false,
        applied,
        errors: [
          ...errors,
          'PARTIAL_COMMIT: some files may already be written. Re-read and repair.',
        ],
      };
    }
  }

  invalidateWorkspaceSearchCache(workspaceRoot);
  invalidateRepoMapCache(workspaceRoot);
  invalidateEmbeddingIndex(workspaceRoot);
  return { ok: true, applied, errors: [] };
}

export function deleteWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  guard: WorkspaceGuardOptions = {},
): { ok: boolean; message: string } {
  const abs = resolveDevWorkspaceRelPath(workspaceRoot, relPath, guard);
  if (!existsSync(abs)) return { ok: false, message: `File not found: ${relPath}` };
  unlinkSync(abs);
  invalidateWorkspaceSearchCache(workspaceRoot);
  invalidateRepoMapCache(workspaceRoot);
  invalidateEmbeddingIndex(workspaceRoot);
  return { ok: true, message: `Deleted ${toPosix(relPath)}` };
}

export function renameWorkspaceFile(
  workspaceRoot: string,
  fromPath: string,
  toPath: string,
  guard: WorkspaceGuardOptions = {},
): { ok: boolean; message: string } {
  const fromAbs = resolveDevWorkspaceRelPath(workspaceRoot, fromPath, guard);
  const toAbs = resolveDevWorkspaceRelPath(workspaceRoot, toPath, guard);
  if (!existsSync(fromAbs)) return { ok: false, message: `File not found: ${fromPath}` };
  if (existsSync(toAbs)) return { ok: false, message: `Destination exists: ${toPath}` };
  mkdirSync(path.dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  invalidateWorkspaceSearchCache(workspaceRoot);
  invalidateRepoMapCache(workspaceRoot);
  invalidateEmbeddingIndex(workspaceRoot);
  return { ok: true, message: `Renamed ${toPosix(fromPath)} → ${toPosix(toPath)}` };
}

/** Resolve apply_patch tool args into FilePatch[]. */
export function resolveApplyPatchArgs(args: Record<string, unknown>): FilePatch[] {
  if (typeof args.patch === 'string' && args.patch.trim()) {
    return parsePatchText(args.patch);
  }

  if (Array.isArray(args.files)) {
    return (args.files as unknown[]).map((raw) => {
      const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return {
        path: String(f.path ?? ''),
        action: f.action as FilePatch['action'],
        content: typeof f.content === 'string' ? f.content : undefined,
        new_path: typeof f.new_path === 'string' ? f.new_path : undefined,
        edits: Array.isArray(f.edits)
          ? (f.edits as PatchEdit[]).map((e) => ({
              old_text: String(e.old_text ?? ''),
              new_text: String(e.new_text ?? ''),
              replace_all: e.replace_all === true,
            }))
          : undefined,
      };
    });
  }

  // Single-file structured form
  if (typeof args.path === 'string' && args.path.trim()) {
    const edits = Array.isArray(args.edits)
      ? (args.edits as PatchEdit[]).map((e) => ({
          old_text: String(e.old_text ?? ''),
          new_text: String(e.new_text ?? ''),
          replace_all: e.replace_all === true || args.replace_all === true,
        }))
      : typeof args.old_text === 'string'
        ? [
            {
              old_text: String(args.old_text),
              new_text: String(args.new_text ?? ''),
              replace_all: args.replace_all === true,
            },
          ]
        : undefined;
    return [
      {
        path: args.path,
        action: (args.action as FilePatch['action']) ?? 'update',
        content: typeof args.content === 'string' ? args.content : undefined,
        new_path: typeof args.new_path === 'string' ? args.new_path : undefined,
        edits,
      },
    ];
  }

  return [];
}

export function formatApplyPatchOutput(result: ApplyPatchResult): string {
  const body: Record<string, unknown> = {
    ok: result.ok,
    applied: result.applied,
    errors: result.errors,
  };
  if (!result.ok) {
    body.repair_hint = [
      'Re-read failing paths, make old_text unique with surrounding context,',
      'then resubmit the FULL multi-file patch (atomic — prior attempt wrote nothing if ATOMIC_ABORT).',
    ].join(' ');
  }
  return JSON.stringify(body, null, 2);
}

/** Used only for existence checks without write consent side effects on read. */
export function workspaceFileExists(workspaceRoot: string, relPath: string): boolean {
  try {
    resolveDevWorkspaceReadPath(workspaceRoot, relPath);
    return existsSync(resolveDevWorkspaceReadPath(workspaceRoot, relPath));
  } catch {
    return false;
  }
}
