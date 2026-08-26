/**
 * File-based workspace checkpoints (not git stash/reset).
 * Snapshots live under MY_AGENT_ROOT/data/agent-checkpoints/<sessionKey>/<id>/.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeWorkspacePath } from '../security/dev-workspace-guard.js';
import {
  resolveDevWorkspaceReadPath,
  resolveDevWorkspaceRelPath,
} from '../security/dev-workspace-guard.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.cqr-pa',
  // Runtime / portable data — never snapshot these (was the main 2000-file lag).
  'data',
  'bin',
  'logs',
  'runtime',
  'test-results',
  '.cursor',
]);

/** Hard cap even when allowFullTree is set — prefer explicit paths. */
const MAX_FILES = 400;
const MAX_FILE_BYTES = 2_000_000;

export interface CheckpointMeta {
  id: string;
  createdAt: string;
  workspaceRoot: string;
  label?: string;
  fileCount: number;
  paths: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Explicit checkpoint paths bypass the SKIP_DIRS walk, so a path pointing into a runtime
 * dir (notably `data/agent-checkpoints`) used to be copied verbatim — snapshotting prior
 * checkpoints into new ones and recursing until Windows 260-char paths broke publish.
 * Reject any rel path whose segments hit a SKIP_DIR.
 */
export function isRuntimeCheckpointPath(rel: string): boolean {
  const norm = toPosix(rel.replace(/\\/g, '/')).replace(/^\.\//, '');
  return norm.split('/').some((seg) => SKIP_DIRS.has(seg));
}

function checkpointRoot(cqrRoot: string, sessionKey: string): string {
  return path.join(cqrRoot, 'data', 'agent-checkpoints', sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function walkFiles(root: string, rel: string, out: string[]): void {
  if (out.length >= MAX_FILES) return;
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= MAX_FILES) return;
    if (ent.name.startsWith('.') && ent.name !== '.env.example') {
      if (ent.name === '.git' || SKIP_DIRS.has(ent.name)) continue;
    }
    if (SKIP_DIRS.has(ent.name)) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      walkFiles(root, childRel, out);
    } else if (ent.isFile()) {
      out.push(childRel);
    }
  }
}

function copyRel(
  workspaceRoot: string,
  destRoot: string,
  rel: string,
): boolean {
  try {
    const src = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    const st = statSync(src);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
    const dest = path.join(destRoot, ...rel.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

export function createWorkspaceCheckpoint(
  workspaceRoot: string,
  cqrRoot: string,
  opts?: {
    sessionKey?: string;
    label?: string;
    /** Relative paths to snapshot. Empty without allowFullTree → no files (avoids multi-minute walks). */
    paths?: string[];
    /**
     * Opt-in whole-tree walk (still capped + SKIP_DIRS). Default false —
     * auto/agent checkpoints must pass explicit paths.
     */
    allowFullTree?: boolean;
    guard?: { allowNas?: boolean };
  },
): CheckpointMeta {
  const root = normalizeWorkspacePath(workspaceRoot);
  const sessionKey = opts?.sessionKey?.trim() || 'default';
  const id = randomUUID().slice(0, 12);
  const base = path.join(checkpointRoot(cqrRoot, sessionKey), id);
  const filesDir = path.join(base, 'files');
  mkdirSync(filesDir, { recursive: true });

  let paths = (opts?.paths ?? []).map((p) => toPosix(p.replace(/\\/g, '/')).replace(/^\.\//, ''));
  if (!paths.length) {
    if (opts?.allowFullTree) {
      const walked: string[] = [];
      walkFiles(root, '', walked);
      paths = walked.map((p) => toPosix(p));
    } else {
      paths = [];
    }
  }

  const saved: string[] = [];
  for (const rel of paths) {
    if (isRuntimeCheckpointPath(rel)) continue;
    if (copyRel(root, filesDir, rel)) saved.push(rel);
  }

  const meta: CheckpointMeta = {
    id,
    createdAt: new Date().toISOString(),
    workspaceRoot: root,
    label: opts?.label,
    fileCount: saved.length,
    paths: saved,
  };
  writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function listWorkspaceCheckpoints(
  cqrRoot: string,
  sessionKey = 'default',
): CheckpointMeta[] {
  const dir = checkpointRoot(cqrRoot, sessionKey);
  if (!existsSync(dir)) return [];
  const out: CheckpointMeta[] = [];
  for (const name of readdirSync(dir)) {
    const metaPath = path.join(dir, name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      out.push(JSON.parse(readFileSync(metaPath, 'utf8')) as CheckpointMeta);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function rollbackWorkspaceCheckpoint(
  workspaceRoot: string,
  cqrRoot: string,
  checkpointId: string,
  opts?: {
    sessionKey?: string;
    confirm?: boolean;
    guard?: { allowNas?: boolean };
    /**
     * When set: restore overlapping checkpoint paths, and **delete** requested
     * paths that were not in the snapshot (new files from this mutate).
     * When omitted: restore every path in the checkpoint only (legacy full restore).
     */
    paths?: string[];
  },
): string {
  if (opts?.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error: 'workspace_rollback requires confirm=true after user approval.',
      },
      null,
      2,
    );
  }

  const root = normalizeWorkspacePath(workspaceRoot);
  const sessionKey = opts?.sessionKey?.trim() || 'default';
  const base = path.join(checkpointRoot(cqrRoot, sessionKey), checkpointId);
  const metaPath = path.join(base, 'meta.json');
  const filesDir = path.join(base, 'files');
  if (!existsSync(metaPath) || !existsSync(filesDir)) {
    return JSON.stringify(
      { ok: false, error: `checkpoint not found: ${checkpointId}` },
      null,
      2,
    );
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CheckpointMeta;
  const ckSet = new Set(meta.paths.map((p) => toPosix(p)));
  const wanted = Array.isArray(opts?.paths)
    ? [
        ...new Set(
          opts.paths
            .map((p) => toPosix(String(p || '').replace(/\\/g, '/')).replace(/^\.\//, ''))
            .filter(Boolean),
        ),
      ]
    : null;

  const restoreList = wanted
    ? wanted.filter((p) => ckSet.has(p))
    : meta.paths.map((p) => toPosix(p));
  const deleteList = wanted
    ? wanted.filter((p) => !ckSet.has(p) && !isRuntimeCheckpointPath(p))
    : [];

  let restored = 0;
  for (const rel of restoreList) {
    const src = path.join(filesDir, ...rel.split('/'));
    if (!existsSync(src)) continue;
    try {
      const dest = resolveDevWorkspaceRelPath(root, rel, opts?.guard);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      restored += 1;
    } catch {
      /* skip blocked paths */
    }
  }

  let deleted = 0;
  const deletedPaths: string[] = [];
  for (const rel of deleteList) {
    try {
      const dest = resolveDevWorkspaceRelPath(root, rel, opts?.guard);
      if (!existsSync(dest)) continue;
      const st = statSync(dest);
      if (!st.isFile()) continue;
      unlinkSync(dest);
      deleted += 1;
      deletedPaths.push(rel);
    } catch {
      /* skip blocked paths */
    }
  }

  return JSON.stringify(
    {
      ok: true,
      checkpoint_id: checkpointId,
      restored,
      deleted,
      deleted_paths: deletedPaths,
      total: restoreList.length + deleteList.length,
      requested: wanted ?? undefined,
      partial: Boolean(wanted),
      label: meta.label,
    },
    null,
    2,
  );
}

const PREVIEW_MAX_CHARS = 4_000;
const DIFF_MAX_LINES = 200;

/** Compact unified line view for mutate review (not full git patch). */
export function buildLineDiffHunks(
  before: string | null,
  after: string | null,
  maxLines = DIFF_MAX_LINES,
): { lines: string[]; truncated: boolean; added: number; removed: number } {
  const a = (before ?? '').split(/\r?\n/);
  const b = (after ?? '').split(/\r?\n/);
  // Strip single trailing empty from split
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();

  // Myers-lite LCS lengths table is O(n*m) — cap input
  const capA = a.length > 400 ? a.slice(0, 400) : a;
  const capB = b.length > 400 ? b.slice(0, 400) : b;
  const n = capA.length;
  const m = capB.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        capA[i] === capB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m && lines.length < maxLines) {
    if (capA[i] === capB[j]) {
      lines.push(` ${capA[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${capA[i]}`);
      removed += 1;
      i += 1;
    } else {
      lines.push(`+${capB[j]}`);
      added += 1;
      j += 1;
    }
  }
  while (i < n && lines.length < maxLines) {
    lines.push(`-${capA[i++]}`);
    removed += 1;
  }
  while (j < m && lines.length < maxLines) {
    lines.push(`+${capB[j++]}`);
    added += 1;
  }
  const truncated = i < n || j < m || a.length > 400 || b.length > 400 || lines.length >= maxLines;
  if (truncated && lines.length < maxLines + 1) {
    lines.push('… (diff truncated)');
  }
  return { lines, truncated, added, removed };
}

/**
 * Side-by-side text preview: checkpoint snapshot vs current workspace file.
 */
export function previewCheckpointDiff(
  workspaceRoot: string,
  cqrRoot: string,
  checkpointId: string,
  relPath: string,
  opts?: { sessionKey?: string; guard?: { allowNas?: boolean } },
): string {
  const root = normalizeWorkspacePath(workspaceRoot);
  const sessionKey = opts?.sessionKey?.trim() || 'default';
  const rel = toPosix(relPath.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!rel || isRuntimeCheckpointPath(rel)) {
    return JSON.stringify({ ok: false, error: 'invalid path' });
  }

  const base = path.join(checkpointRoot(cqrRoot, sessionKey), checkpointId);
  const metaPath = path.join(base, 'meta.json');
  const snapPath = path.join(base, 'files', ...rel.split('/'));
  if (!existsSync(metaPath)) {
    return JSON.stringify({ ok: false, error: `checkpoint not found: ${checkpointId}` });
  }

  let beforeFull: string | null = null;
  let beforeBytes = 0;
  if (existsSync(snapPath)) {
    try {
      const buf = readFileSync(snapPath);
      beforeBytes = buf.length;
      beforeFull = buf.toString('utf8');
    } catch {
      beforeFull = null;
    }
  }

  let afterFull: string | null = null;
  let afterBytes = 0;
  try {
    const dest = resolveDevWorkspaceRelPath(root, rel, opts?.guard);
    if (existsSync(dest)) {
      const buf = readFileSync(dest);
      afterBytes = buf.length;
      afterFull = buf.toString('utf8');
    }
  } catch {
    afterFull = null;
  }

  const clip = (s: string | null): string | null => {
    if (s == null) return null;
    return s.length > PREVIEW_MAX_CHARS ? `${s.slice(0, PREVIEW_MAX_CHARS)}\n… (truncated)` : s;
  };

  const before = clip(beforeFull);
  const after = clip(afterFull);
  const hunks = buildLineDiffHunks(beforeFull, afterFull);
  const isNew = !existsSync(snapPath) && afterFull != null;
  const isDeleted = existsSync(snapPath) && afterFull == null;

  return JSON.stringify(
    {
      ok: true,
      path: rel,
      checkpoint_id: checkpointId,
      before,
      after,
      before_bytes: beforeBytes,
      after_bytes: afterBytes,
      changed: beforeFull !== afterFull,
      in_checkpoint: existsSync(snapPath),
      is_new: isNew,
      is_deleted_on_disk: isDeleted,
      diff_lines: hunks.lines,
      diff_added: hunks.added,
      diff_removed: hunks.removed,
      diff_truncated: hunks.truncated,
    },
    null,
    2,
  );
}

export function clearOldCheckpoints(
  cqrRoot: string,
  sessionKey: string,
  keepLast = 5,
): void {
  const list = listWorkspaceCheckpoints(cqrRoot, sessionKey);
  if (list.length <= keepLast) return;
  const drop = list.slice(0, list.length - keepLast);
  for (const m of drop) {
    const dir = path.join(checkpointRoot(cqrRoot, sessionKey), m.id);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface CheckpointSweepPolicy {
  /** Drop whole session dirs whose newest checkpoint is older than this. */
  maxAgeMs: number;
  /** Keep at most this many checkpoints per surviving session. */
  keepPerSession: number;
  /** Hard cap on total bytes across all sessions; oldest sessions drop first. */
  maxTotalBytes: number;
}

export interface CheckpointSweepResult {
  removedSessions: number;
  removedCheckpoints: number;
  freedBytes: number;
  remainingBytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseEnvInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** clearOldCheckpoints is per-session and only fires when THAT session mutates again — dead
 *  sessions linger forever. Resolve a global policy (env-tunable) for the boot-time sweep. */
export function resolveCheckpointSweepPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CheckpointSweepPolicy {
  return {
    maxAgeMs: parseEnvInt(env.MY_AGENT_CHECKPOINT_MAX_AGE_DAYS, 7) * DAY_MS,
    keepPerSession: parseEnvInt(env.MY_AGENT_CHECKPOINT_KEEP, 5),
    maxTotalBytes: parseEnvInt(env.MY_AGENT_CHECKPOINT_MAX_MB, 200) * 1024 * 1024,
  };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      total += dirSizeBytes(abs);
    } else if (ent.isFile()) {
      try {
        total += statSync(abs).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

interface SessionStat {
  sessionKey: string;
  dir: string;
  newest: number;
  bytes: number;
}

/**
 * Global housekeeping across every checkpoint session (run at boot):
 * 1. drop sessions whose newest checkpoint is older than `maxAgeMs`;
 * 2. within survivors, keep only the last `keepPerSession`;
 * 3. if still over `maxTotalBytes`, drop whole sessions oldest-first until under budget.
 */
export function sweepCheckpoints(
  cqrRoot: string,
  policy: CheckpointSweepPolicy = resolveCheckpointSweepPolicy(),
  now: number = Date.now(),
): CheckpointSweepResult {
  const rootDir = path.join(cqrRoot, 'data', 'agent-checkpoints');
  const result: CheckpointSweepResult = {
    removedSessions: 0,
    removedCheckpoints: 0,
    freedBytes: 0,
    remainingBytes: 0,
  };
  if (!existsSync(rootDir)) return result;

  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }

  const dropSession = (sessionKey: string, dir: string): void => {
    const bytes = dirSizeBytes(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
      result.removedSessions += 1;
      result.freedBytes += bytes;
    } catch {
      /* ignore */
    }
  };

  const survivors: SessionStat[] = [];
  for (const sessionKey of sessionDirs) {
    const dir = path.join(rootDir, sessionKey);
    const list = listWorkspaceCheckpoints(cqrRoot, sessionKey);

    // No readable meta.json (legacy full-tree bloat, or corrupt) or stale → drop whole dir.
    const newest = list.length
      ? Date.parse(list[list.length - 1].createdAt) || 0
      : 0;
    if (!list.length || now - newest > policy.maxAgeMs) {
      dropSession(sessionKey, dir);
      continue;
    }

    if (list.length > policy.keepPerSession) {
      const before = list.length;
      clearOldCheckpoints(cqrRoot, sessionKey, policy.keepPerSession);
      result.removedCheckpoints += before - policy.keepPerSession;
    }
    survivors.push({ sessionKey, dir, newest, bytes: dirSizeBytes(dir) });
  }

  let totalBytes = survivors.reduce((sum, s) => sum + s.bytes, 0);
  if (totalBytes > policy.maxTotalBytes) {
    // Oldest sessions first until under budget (keep the most recent work).
    survivors.sort((a, b) => a.newest - b.newest);
    for (const s of survivors) {
      if (totalBytes <= policy.maxTotalBytes) break;
      dropSession(s.sessionKey, s.dir);
      totalBytes -= s.bytes;
    }
  }

  result.remainingBytes = totalBytes > 0 ? totalBytes : 0;
  return result;
}
