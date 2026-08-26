import { randomUUID } from 'node:crypto';
import { envFlagOn } from '../providers/harness-policy.js';
import { pluginInstallNeedsHitl } from './agent-plugin-capability.js';
import path from 'node:path';
import { isOfficeBinaryPath } from '../security/workspace-capabilities.js';
import { isAbsoluteUserPath, normalizeWorkspacePath } from '../security/dev-workspace-guard.js';

export type ToolApprovalAccess =
  | 'operation'
  | 'external_read'
  | 'external_write'
  | 'network';

export interface ToolApprovalRequest {
  id: string;
  tool: string;
  summary: string;
  argsPreview: string;
  danger: boolean;
  delegable?: boolean;
  /** Structured capability boundary; UI must not infer this from Korean prose. */
  access?: ToolApprovalAccess;
  /** Absolute/UNC targets, redacted only by the UI if needed. */
  targets?: string[];
  /** Approval lifetime. External reads are reused only inside the current agent run. */
  expires?: 'once' | 'run';
}

function pathInsideWorkspace(candidate: unknown, workspaceRoot: string): boolean {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const root = normalizeWorkspacePath(workspaceRoot);
  const resolved = isAbsoluteUserPath(candidate)
    ? normalizeWorkspacePath(candidate)
    : path.resolve(root, candidate);
  const rel = path.relative(root, resolved);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function normalizeToolPath(candidate: unknown, workspaceRoot: string): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  return isAbsoluteUserPath(candidate)
    ? normalizeWorkspacePath(candidate)
    : path.resolve(normalizeWorkspacePath(workspaceRoot), candidate);
}

function extractPatchTextPaths(patch: unknown): string[] {
  if (typeof patch !== 'string') return [];
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
    paths.push(match[1].trim());
  }
  for (const match of patch.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
    paths.push(match[1].trim());
  }
  return paths;
}

/** Paths a tool will read or mutate. This is structural tool metadata, not NLP intent. */
export function toolPathTargets(
  toolName: string,
  args: Record<string, unknown>,
): { mode: 'read' | 'write' | null; paths: string[] } {
  const one = (value: unknown) => typeof value === 'string' && value.trim() ? [value.trim()] : [];
  if (toolName === 'read_file' || toolName === 'list_directory' || toolName === 'search_files') {
    return { mode: 'read', paths: one(args.path ?? '.') };
  }
  if (toolName === 'workspace_checkpoint') {
    return {
      mode: 'read',
      paths: Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string' && Boolean(p.trim())) : [],
    };
  }
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file') {
    return { mode: 'write', paths: one(args.path) };
  }
  if (toolName === 'rename_file') {
    return { mode: 'write', paths: [...one(args.path), ...one(args.new_path)] };
  }
  if (toolName === 'apply_patch') {
    const paths = [
      ...one(args.path),
      ...extractPatchTextPaths(args.patch),
      ...(Array.isArray(args.files)
        ? args.files.flatMap((row) => {
            if (!row || typeof row !== 'object') return [];
            const file = row as Record<string, unknown>;
            return [...one(file.path), ...one(file.new_path)];
          })
        : []),
    ];
    return { mode: 'write', paths: [...new Set(paths)] };
  }
  return { mode: null, paths: [] };
}

function pathWithinGrant(target: string, grantRoot: string): boolean {
  const rel = path.relative(grantRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function externalReadGrantRoot(_toolName: string, target: string): string {
  // Directory tool targets naturally grant descendants. A direct file read
  // grants only that exact path because a file path has no valid descendants.
  return target;
}

/**
 * Structural delegation boundary. The reviewer owns semantic risk judgment; this
 * function keeps only non-negotiable path/operation security boundaries local.
 */
export function canDelegateToolApproval(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): boolean {
  if (toolName === 'run_terminal') return true;
  if (toolName === 'read_file' || toolName === 'list_directory' || toolName === 'search_files') {
    const target = toolPathTargets(toolName, args).paths[0];
    return typeof target === 'string' && target.trim().length > 0;
  }
  if (toolName === 'write_file') {
    return pathInsideWorkspace(args.path, workspaceRoot) && !isOfficeBinaryPath(String(args.path ?? ''));
  }
  if (toolName === 'apply_patch') {
    if (typeof args.action === 'string' && !['add', 'update'].includes(args.action)) return false;
    if (typeof args.new_path === 'string' && args.new_path.trim()) return false;
    if (Array.isArray(args.files) && args.files.some((row) => {
      if (!row || typeof row !== 'object') return true;
      const file = row as Record<string, unknown>;
      return (typeof file.action === 'string' && !['add', 'update'].includes(file.action))
        || (typeof file.new_path === 'string' && file.new_path.trim().length > 0);
    })) return false;
    let paths = Array.isArray(args.files)
      ? args.files.map((row) => row && typeof row === 'object' ? (row as Record<string, unknown>).path : undefined)
      : typeof args.path === 'string' ? [args.path] : [];
    if (!paths.length && typeof args.patch === 'string') {
      paths = [...args.patch.matchAll(/^\*\*\* (?:Add|Update) File:\s*(.+)$/gm)].map((match) => match[1].trim());
      if (/^\*\*\* (?:Delete|Move) File:/m.test(args.patch)) return false;
    }
    return paths.length > 0 && paths.every((p) => pathInsideWorkspace(p, workspaceRoot) && !isOfficeBinaryPath(String(p ?? '')));
  }
  // Delete/rollback/plugin changes, Office binaries, and every external write
  // deliberately stay outside delegated authority.
  return false;
}

type Pending = {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function createToolApprovalId(): string {
  return randomUUID();
}

/** Wait until UI POSTs /chat/tool-approval or timeout (deny). */
export function waitForToolApproval(
  id: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const finish = (approved: boolean) => {
      const row = pending.get(id);
      if (!row) return;
      clearTimeout(row.timer);
      pending.delete(id);
      resolve(approved);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    pending.set(id, { resolve: finish, timer });

    if (opts?.signal) {
      if (opts.signal.aborted) {
        finish(false);
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => finish(false),
        { once: true },
      );
    }
  });
}

export function resolveToolApproval(id: string, approved: boolean): boolean {
  const row = pending.get(id);
  if (!row) return false;
  // IMPORTANT: do not delete pending here — finish() owns cleanup.
  // Pre-deleting made finish() no-op and left waitForToolApproval hanging forever
  // while the UI already showed "승인됨 · 계속…".
  row.resolve(approved);
  return true;
}

export const DEFAULT_LARGE_WRITE_CHARS = 40_000;
/** apply_patch HITL threshold (higher — patches are hunk-scoped vs full rewrite). */
export const DEFAULT_LARGE_PATCH_CHARS = 80_000;

/** Env-overridable large write threshold (Cursor-like: don't pause mid-edit for normal files). */
export function largeWriteChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.MY_AGENT_HITL_LARGE_WRITE_CHARS ?? '').trim(), 10);
  if (Number.isFinite(n) && n >= 4_000) return Math.min(n, 500_000);
  return DEFAULT_LARGE_WRITE_CHARS;
}

export function largePatchChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.MY_AGENT_HITL_LARGE_PATCH_CHARS ?? '').trim(), 10);
  if (Number.isFinite(n) && n >= 8_000) return Math.min(n, 1_000_000);
  return DEFAULT_LARGE_PATCH_CHARS;
}

/** @deprecated use largeWriteChars() — kept for import compat. */
export const LARGE_WRITE_CHARS = DEFAULT_LARGE_WRITE_CHARS;

/**
 * Read-only / syntax-verify terminals — safe to skip HITL (default on via
 * MY_AGENT_HITL_SAFE_TERMINAL). Rejects shell metacharacters.
 */
export function isSafeVerifyTerminalCommand(cmd: string): boolean {
  const c = String(cmd || '').trim();
  if (!c || c.length > 400) return false;
  if (/[;&|`$><]|\n|\r|&&|\|\|/.test(c)) return false;
  if (/^node\s+(?:--check|-c)\b/i.test(c)) return true;
  if (/^node\s+[^\s]+\.(?:js|mjs|cjs)\b/i.test(c) && /\b--check\b/i.test(c)) return true;
  if (/\bnpx\s+(?:--yes\s+)?tsc\b/i.test(c)) return true;
  if (/\bnpm\s+(?:exec\s+--\s+)?(?:tsc|--prefix\b)/i.test(c) && /\btsc\b/i.test(c)) return true;
  if (/^python(?:3)?\s+-m\s+py_compile\b/i.test(c)) return true;
  if (/^python(?:3)?\s+-c\s+["']import\s+json/i.test(c)) return true;
  return false;
}

export function hitlSafeTerminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env.MY_AGENT_HITL_SAFE_TERMINAL, true);
}

export function needsHumanApproval(
  toolName: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  context?: { workspaceRoot?: string; approvedExternalReadRoots?: ReadonlySet<string> },
): {
  needed: boolean;
  danger: boolean;
  summary: string;
  access?: ToolApprovalAccess;
  targets?: string[];
  grantRoots?: string[];
  expires?: 'once' | 'run';
} {
  if (context?.workspaceRoot) {
    const pathUse = toolPathTargets(toolName, args);
    const externalTargets = pathUse.paths
      .map((candidate) => normalizeToolPath(candidate, context.workspaceRoot!))
      .filter((target): target is string => Boolean(target))
      .filter((target) => !pathInsideWorkspace(target, context.workspaceRoot!));
    if (externalTargets.length > 0 && pathUse.mode === 'write') {
      return {
        needed: true,
        danger: true,
        access: 'external_write',
        targets: externalTargets,
        expires: 'once',
        summary: `워크스페이스 외부 쓰기: ${externalTargets.slice(0, 3).join(', ')}`,
      };
    }
    if (externalTargets.length > 0 && pathUse.mode === 'read') {
      const grants = context.approvedExternalReadRoots ?? new Set<string>();
      const unapproved = externalTargets.filter(
        (target) => ![...grants].some((grant) => pathWithinGrant(target, grant)),
      );
      if (unapproved.length > 0) {
        return {
          needed: true,
          danger: false,
          access: 'external_read',
          targets: unapproved,
          grantRoots: [...new Set(unapproved.map((target) => externalReadGrantRoot(toolName, target)))],
          expires: 'run',
          summary: `워크스페이스 외부 읽기: ${unapproved.slice(0, 3).join(', ')}`,
        };
      }
    }
  }
  if (toolName === 'workspace_rollback') {
    const id = typeof args.checkpoint_id === 'string' ? args.checkpoint_id : '?';
    return {
      needed: true,
      danger: true,
      summary: `체크포인트 롤백: ${id}`,
    };
  }
  if (toolName === 'delete_file') {
    const p = typeof args.path === 'string' ? args.path : '?';
    return { needed: true, danger: true, summary: `파일 삭제: ${p}` };
  }
  if (toolName === 'run_terminal') {
    const cmd = typeof args.command === 'string' ? args.command : '?';
    if (hitlSafeTerminalEnabled(env) && isSafeVerifyTerminalCommand(cmd)) {
      return { needed: false, danger: false, summary: '' };
    }
    return {
      needed: true,
      danger: true,
      summary: `터미널 실행: ${cmd.slice(0, 200)}${cmd.length > 200 ? '…' : ''}`,
    };
  }
  if (toolName === 'write_file') {
    const content = typeof args.content === 'string' ? args.content : '';
    const limit = largeWriteChars(env);
    if (content.length >= limit) {
      const p = typeof args.path === 'string' ? args.path : '?';
      return {
        needed: true,
        danger: false,
        summary: `대용량 파일 쓰기 (${content.length}자≥${limit}): ${p}`,
      };
    }
  }
  if (toolName === 'apply_patch') {
    const raw = JSON.stringify(args);
    const limit = largePatchChars(env);
    if (raw.length >= limit) {
      return { needed: true, danger: false, summary: `대용량 apply_patch (${raw.length}자≥${limit})` };
    }
  }
  // Freeform local plugin install = PC-side code addition → UI Accept when available.
  // Shipped template_id installs remain confirm=true only (no HITL card).
  if (toolName === 'plugin_install') {
    const hitl = pluginInstallNeedsHitl(args);
    if (hitl.needed) return hitl;
  }
  if (toolName === 'plugin_set_enabled') {
    const id = typeof args.id === 'string' ? args.id : '?';
    return {
      needed: true,
      danger: false,
      summary: `플러그인 활성/비활성: ${id}`,
    };
  }
  return { needed: false, danger: false, summary: '', access: 'operation' };
}

export function formatApprovalDenied(toolName: string, reason: 'user_rejected' | 'timeout' | 'confirm_required'): string {
  if (reason === 'confirm_required') {
    return [
      'ERROR: human_approval_required',
      `tool: ${toolName}`,
      'This tool needs user approval. In the chat UI Accept/Reject dialog will appear on stream runs.',
      'If confirm is available, call again with confirm=true only after the user explicitly approved.',
    ].join('\n');
  }
  return [
    'ERROR: user_rejected_tool',
    `tool: ${toolName}`,
    reason === 'timeout'
      ? 'User did not approve in time. Do not retry the same destructive call unless the user asks.'
      : 'User rejected this tool call. Do not retry unless the user explicitly asks.',
  ].join('\n');
}
