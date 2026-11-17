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
  /**
   * Requested paths that did not exist when they were snapshotted. Only these are
   * safe to delete on rollback (they were created by the mutation). Missing on
   * checkpoints written before this field existed.
   */
  absentPaths?: string[];
  /**
   * Requested paths that existed but could not be stored (over MAX_FILE_BYTES, a
   * directory, blocked). Rollback can neither restore nor delete them.
   */
  skippedPaths?: string[];
  /**
   * Renames/moves this run performed. The two paths of a pair are one change:
   * rolling back only the new path would delete the file without restoring the old
   * path. Rollback expands a requested path to its pair partners.
   */
  movePairs?: Array<{ from: string; to: string }>;
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

type SnapshotOutcome = 'saved' | 'absent' | 'skipped';

/** Store one path, or record why it holds no copy (did not exist vs. could not be stored). */
function snapshotRel(
  workspaceRoot: string,
  destRoot: string,
  rel: string,
  guard?: { allowNas?: boolean },
): SnapshotOutcome {
  if (copyRel(workspaceRoot, destRoot, rel)) return 'saved';
  try {
    const abs = resolveDevWorkspaceRelPath(workspaceRoot, rel, guard);
    return existsSync(abs) ? 'skipped' : 'absent';
  } catch {
    return 'skipped';
  }
}

function normalizeCheckpointRel(p: unknown): string {
  return toPosix(String(p || '').replace(/\\/g, '/')).replace(/^\.\//, '');
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
  const absent: string[] = [];
  const skipped: string[] = [];
  for (const rel of [...new Set(paths)]) {
    if (!rel || isRuntimeCheckpointPath(rel)) continue;
    const outcome = snapshotRel(root, filesDir, rel, opts?.guard);
    if (outcome === 'saved') saved.push(rel);
    else if (outcome === 'absent') absent.push(rel);
    else skipped.push(rel);
  }

  const meta: CheckpointMeta = {
    id,
    createdAt: new Date().toISOString(),
    workspaceRoot: root,
    label: opts?.label,
    fileCount: saved.length,
    paths: saved,
    absentPaths: absent,
    skippedPaths: skipped,
  };
  writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * Add not-yet-covered paths to an existing checkpoint, before they are mutated.
 * A path keeps its first recorded state: already saved, absent or skipped paths are
 * left alone (re-snapshotting would store content the run already changed).
 * Returns the updated meta, or null when the checkpoint no longer exists.
 */
export function extendWorkspaceCheckpoint(
  workspaceRoot: string,
  cqrRoot: string,
  checkpointId: string,
  opts: {
    sessionKey?: string;
    paths: string[];
    guard?: { allowNas?: boolean };
  },
): CheckpointMeta | null {
  const root = normalizeWorkspacePath(workspaceRoot);
  const sessionKey = opts.sessionKey?.trim() || 'default';
  const base = path.join(checkpointRoot(cqrRoot, sessionKey), checkpointId);
  const metaPath = path.join(base, 'meta.json');
  const filesDir = path.join(base, 'files');
  if (!checkpointId || !existsSync(metaPath)) return null;
  let meta: CheckpointMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CheckpointMeta;
  } catch {
    return null;
  }

  const saved = new Set((meta.paths ?? []).map((p) => toPosix(p)));
  const absent = new Set((meta.absentPaths ?? []).map((p) => toPosix(p)));
  const skipped = new Set((meta.skippedPaths ?? []).map((p) => toPosix(p)));
  let changed = false;
  for (const raw of opts.paths) {
    const rel = normalizeCheckpointRel(raw);
    if (!rel || isRuntimeCheckpointPath(rel)) continue;
    if (saved.has(rel) || absent.has(rel) || skipped.has(rel)) continue;
    const outcome = snapshotRel(root, filesDir, rel, opts.guard);
    if (outcome === 'saved') saved.add(rel);
    else if (outcome === 'absent') absent.add(rel);
    else skipped.add(rel);
    changed = true;
  }
  if (!changed) return meta;

  const next: CheckpointMeta = {
    ...meta,
    fileCount: saved.size,
    paths: [...saved],
    absentPaths: [...absent],
    skippedPaths: [...skipped],
  };
  writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Record renames/moves that succeeded, so a partial rollback of either path also
 * rolls back the other one. Returns false when the checkpoint no longer exists.
 */
export function recordCheckpointMovePairs(
  cqrRoot: string,
  checkpointId: string,
  opts: { sessionKey?: string; moves: Array<{ from: string; to: string }> },
): boolean {
  const sessionKey = opts.sessionKey?.trim() || 'default';
  const metaPath = path.join(checkpointRoot(cqrRoot, sessionKey), checkpointId, 'meta.json');
  if (!checkpointId || !existsSync(metaPath)) return false;
  let meta: CheckpointMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CheckpointMeta;
  } catch {
    return false;
  }
  const pairs = [...(meta.movePairs ?? [])];
  let changed = false;
  for (const move of opts.moves) {
    const from = normalizeCheckpointRel(move.from);
    const to = normalizeCheckpointRel(move.to);
    if (!from || !to || from === to) continue;
    if (pairs.some((p) => p.from === from && p.to === to)) continue;
    pairs.push({ from, to });
    changed = true;
  }
  if (changed) {
    writeFileSync(metaPath, JSON.stringify({ ...meta, movePairs: pairs }, null, 2), 'utf8');
  }
  return true;
}

/** Requested paths plus every path linked to them through recorded renames/moves. */
function expandWithMovePartners(
  wanted: string[],
  pairs: Array<{ from: string; to: string }>,
): string[] {
  const out = new Set(wanted);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pair of pairs) {
      const from = toPosix(pair.from);
      const to = toPosix(pair.to);
      if (out.has(from) !== out.has(to)) {
        out.add(from);
        out.add(to);
        grew = true;
      }
    }
  }
  return [...out];
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
     * When set: restore overlapping checkpoint paths, and **delete** only requested
     * paths the checkpoint recorded as absent (new files from this mutate). A path
     * the checkpoint knows nothing about is left untouched and reported as skipped:
     * it may be a pre-existing file that was never snapshotted.
     * A path that was renamed/moved brings its pair partner along (see movePairs).
     * When omitted: restore every path in the checkpoint only (legacy full restore).
     */
    paths?: string[];
    /**
     * Full rollback only (no `paths`): also delete the paths the checkpoint recorded
     * as absent, i.e. files the run created (rename/move destinations included).
     * Checkpoints written before `absentPaths` existed delete nothing.
     */
    removeCreated?: boolean;
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
  const absentSet = new Set((meta.absentPaths ?? []).map((p) => toPosix(p)));
  const requested = Array.isArray(opts?.paths)
    ? [...new Set(opts.paths.map((p) => normalizeCheckpointRel(p)).filter(Boolean))]
    : null;
  // A rename is one change with two paths: never roll back just one side of it.
  const wanted = requested ? expandWithMovePartners(requested, meta.movePairs ?? []) : null;
  const pairedPaths = requested && wanted ? wanted.filter((p) => !requested.includes(p)) : [];

  const restoreList = wanted
    ? wanted.filter((p) => ckSet.has(p))
    : meta.paths.map((p) => toPosix(p));
  const removeCreated = !wanted && opts?.removeCreated === true;
  const deleteList = wanted
    ? wanted.filter((p) => !ckSet.has(p) && absentSet.has(p) && !isRuntimeCheckpointPath(p))
    : removeCreated
      ? [...absentSet].filter((p) => !ckSet.has(p) && !isRuntimeCheckpointPath(p))
      : [];
  // Neither stored nor known-absent: never delete (would destroy a pre-existing file).
  const skippedPaths = wanted
    ? wanted.filter((p) => !ckSet.has(p) && !absentSet.has(p))
    : removeCreated
      ? (meta.skippedPaths ?? []).map((p) => toPosix(p))
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
      skipped: skippedPaths.length,
      skipped_paths: skippedPaths,
      paired_paths: pairedPaths,
      total: restoreList.length + deleteList.length,
      requested: requested ?? undefined,
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
  let absentAtSnapshot = false;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CheckpointMeta;
    absentAtSnapshot = (meta.absentPaths ?? []).some((p) => toPosix(p) === rel);
  } catch {
    absentAtSnapshot = false;
  }
  // No stored copy and not recorded as absent → the before-state is unknown, not "new".
  const unprotected = !existsSync(snapPath) && !absentAtSnapshot;
  const isNew = absentAtSnapshot && afterFull != null;
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
      unprotected,
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
