import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { assertDevWorkspaceRootReadable, normalizeWorkspacePath, resolveDevWorkspaceReadPath } from '../security/dev-workspace-guard.js';

export interface RunTerminalResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  command: string;
  cwd: string;
  /** Set when aborted via AbortSignal / job cancel. */
  cancelled?: boolean;
}

/** Active long-running terminal children (agent + UI) for cancel. */
const activeJobs = new Map<
  string,
  {
    child: ChildProcessWithoutNullStreams;
    markCancelled: () => void;
    command: string;
    startedAt: number;
  }
>();

export function cancelTerminalJob(jobId: string): boolean {
  const row = activeJobs.get(jobId);
  if (!row) return false;
  row.markCancelled();
  try {
    row.child.kill();
  } catch {
    /* ignore */
  }
  // Keep until close so finish can read cancelled; re-list hides after delete in finish.
  return true;
}

export function listActiveTerminalJobIds(): string[] {
  return [...activeJobs.keys()];
}

export type ActiveTerminalJobInfo = {
  id: string;
  command: string;
  started_at: number;
  age_ms: number;
  kind: 'agent' | 'ui' | 'other';
};

export function listActiveTerminalJobs(): ActiveTerminalJobInfo[] {
  const now = Date.now();
  return [...activeJobs.entries()].map(([id, row]) => {
    let kind: ActiveTerminalJobInfo['kind'] = 'other';
    if (id.startsWith('agent_')) kind = 'agent';
    else if (id.startsWith('ui_') || id.startsWith('ui_term_')) kind = 'ui';
    return {
      id,
      command: row.command.length > 200 ? `${row.command.slice(0, 200)}…` : row.command,
      started_at: row.startedAt,
      age_ms: Math.max(0, now - row.startedAt),
      kind,
    };
  });
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100_000;

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bRemove-Item\b.*-Recurse/i,
  /\brmdir\b.*\/s/i,
  /\bdel\b.*\/[fs]/i,
  /\brd\b.*\/s/i,
  // Windows disk format only — do NOT match git `--pretty=format:` / `--format=`.
  /(?:^|[;&|]\s*)format(?:\.com)?(?:\s+[A-Za-z]:|\s+\/|$)/i,
  /\bgit\s+push\b/i,
  /\bgit\s+pull\b/i,
  /\bgit\s+fetch\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+commit\b/i,
  /\bgit\s+checkout\b/i,
  /\bgit\s+switch\b/i,
  /\bgit\s+stash\b/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+branch\b/i,
  /\bgit\s+show\b/i,
  /\bgit\s+blame\b/i,
  /\bgit\s+add\b/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+stash\s+(?:drop|clear|pop)\b/i,
];

/**
 * Public inspect clones under `.my_agent_remote/` may deepen history / read git metadata via shell.
 * Bound-workspace write/sync still uses dedicated git_* tools (bare `git fetch` stays blocked).
 */
export function isAllowedCqrRemoteInspectGitShell(command: string): boolean {
  const t = String(command || '').trim();
  if (!t || !/\.my_agent_remote[/\\]/i.test(t)) return false;
  // Prefer `git -C .my_agent_remote/<owner>__<repo> …`
  const viaDashC =
    /^git\s+-C\s+(?:["'][^"']*\.my_agent_remote[^"']*["']|\.my_agent_remote[/\\][^\s"';|&]+)\s+/i.test(t);
  if (!viaDashC) return false;
  // Read / deepen only — no push/reset/commit/clean.
  return (
    /\bfetch\s+--unshallow\b/i.test(t)
    || /\bfetch\s+(?:--all\b|(?:--tags\b)|(?:--prune\b))/i.test(t)
    || /\b(?:rev-parse|rev-list|log|shortlog|status|remote|tag|diff|show|blame|branch)\b/i.test(t)
  );
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  const slice = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
  return { text: `${slice}\n… (output truncated)`, truncated: true };
}

/**
 * Models often wrap public `git clone` with `Remove-Item -Recurse` which trip safety policy.
 * For inspect clones (github/gitlab or `.my_agent_remote/`), strip destructive prelude and keep clone.
 */
export function sanitizeShellCommandForPolicy(command: string): {
  command: string;
  stripped: string[];
} {
  const raw = String(command || '').trim();
  if (!raw) return { command: raw, stripped: [] };
  if (!/git\s+clone/i.test(raw)) return { command: raw, stripped: [] };
  if (!/\.my_agent_remote\b/i.test(raw) && !/(?:github|gitlab)\.com/i.test(raw)) {
    return { command: raw, stripped: [] };
  }
  const segs = raw.split(/\s*(?:;|&&|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  const stripped: string[] = [];
  const kept: string[] = [];
  for (const seg of segs) {
    if (
      /\bRemove-Item\b/i.test(seg)
      || /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/i.test(seg)
      || /\brm\s+-rf\b/i.test(seg)
      || /\brmdir\b.*\/s/i.test(seg)
      || /\brd\b.*\/s/i.test(seg)
    ) {
      stripped.push(seg.slice(0, 160));
      continue;
    }
    kept.push(seg);
  }
  if (!stripped.length || !kept.some((s) => /git\s+clone/i.test(s))) {
    return { command: raw, stripped: [] };
  }
  return { command: kept.join(' && '), stripped };
}

/** Parse `.my_agent_remote/...` dest from a public inspect clone command. */
export function extractRemoteCloneDest(command: string): string | null {
  const raw = String(command || '');
  const m =
    raw.match(/git\s+clone(?:[\s\S]*?)\s+["']?(\.my_agent_remote\/[^\s"'`;|&]+)["']?/i)
    || raw.match(/git\s+clone(?:[\s\S]*?)\s+["']?(\.my_agent_remote\\[^\s"'`;|&]+)["']?/i);
  if (!m?.[1]) return null;
  return m[1].replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

/**
 * Live gh_explain/P03: clone into existing `.my_agent_remote/...` fails, model stops with
 * 「다음 조치: README 읽어야」. Treat existing dest as success + force read next.
 */
export function tryShortcutExistingRemoteClone(
  workspaceRoot: string,
  command: string,
): RunTerminalResult | null {
  const destRel = extractRemoteCloneDest(command);
  if (!destRel) return null;
  try {
    const abs = resolveDevWorkspaceReadPath(workspaceRoot, destRel);
    if (!existsSync(abs)) return null;
    // Empty dest should still run real `git clone` (not soft DEST_EXISTS).
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      return null;
    }
    if (entries.length === 0) return null;
    const readme = `${destRel}/README.md`;
    const cwd = normalizeWorkspacePath(workspaceRoot);
    return {
      ok: true,
      exit_code: 0,
      stdout: [
        `DEST_EXISTS: ${destRel} already has a local clone — skip re-clone (not a tool failure).`,
        'NEXT: ground the answer on the local tree NOW. Do not end with 「다음 조치」.',
        `TOOL_CALL: {"name":"read_file","arguments":{"path":"${readme}"}}`,
      ].join('\n'),
      stderr: '',
      truncated: false,
      command,
      cwd,
    };
  } catch {
    return null;
  }
}

function validateShellCommand(command: string, workspaceRoot: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return 'command must be non-empty';
  if (/\.\.[\\/]|[\\/]\.\./.test(trimmed)) {
    return 'command must not reference parent directories (..)';
  }
  const allowRemoteInspect = isAllowedCqrRemoteInspectGitShell(trimmed);
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (allowRemoteInspect) continue;
      const cloneHint =
        /git\s+clone/i.test(trimmed) && /Remove-Item|rm\s+-rf|rmdir/i.test(trimmed)
          ? ' Hint: use only `git clone [--depth 1] <url> .my_agent_remote/<owner>__<repo>` (no Remove-Item/rm -rf). Full history: omit --depth 1 or `git -C <dest> fetch --unshallow`.'
          : /\bgit\s+fetch\b/i.test(trimmed)
            ? ' Hint: bound-repo sync → tool git_fetch; public `.my_agent_remote` deepen → `git -C .my_agent_remote/<owner>__<repo> fetch --unshallow --tags --prune`.'
            : /format/i.test(pattern.source)
              ? ' Hint: disk `format` is blocked; git `--pretty=format:` is allowed.'
              : '';
      return `command blocked by safety policy: ${pattern.source}.${cloneHint}`;
    }
  }
  const root = normalizeWorkspacePath(workspaceRoot).toLowerCase();
  const driveLetterMatch = trimmed.match(/\b([A-Za-z]):[\\/]/g);
  if (driveLetterMatch) {
    for (const token of driveLetterMatch) {
      const abs = path.resolve(token.slice(0, -1));
      const rel = path.relative(root, abs.toLowerCase());
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return `absolute path outside workspace is not allowed: ${token}`;
      }
    }
  }
  return null;
}

/**
 * Async terminal with cancel (AbortSignal or jobId via cancelTerminalJob).
 * Prefer this for agent / long builds. Sync `runTerminalCommand` remains for short CLI.
 */
export function runTerminalCommandAsync(
  workspaceRoot: string,
  command: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal; jobId?: string },
): Promise<RunTerminalResult> {
  assertDevWorkspaceRootReadable(workspaceRoot);
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const sanitized = sanitizeShellCommandForPolicy(command);
  const effectiveCommand = sanitized.command;
  const validationError = validateShellCommand(effectiveCommand, cwd);
  if (validationError) {
    return Promise.resolve({
      ok: false,
      exit_code: null,
      stdout: '',
      stderr: `ERROR: ${validationError}`,
      truncated: false,
      command: effectiveCommand,
      cwd,
    });
  }

  const existingClone = tryShortcutExistingRemoteClone(cwd, effectiveCommand);
  if (existingClone) return Promise.resolve(existingClone);

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jobId = opts?.jobId?.trim() || `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stripNote =
    sanitized.stripped.length > 0
      ? `NOTE: stripped unsafe prelude (${sanitized.stripped.length}): kept public clone only.\n`
      : '';

  return new Promise((resolve) => {
    if (opts?.signal?.aborted) {
      resolve({
        ok: false,
        exit_code: null,
        stdout: '',
        stderr: 'ERROR: cancelled before start',
        truncated: false,
        command: effectiveCommand,
        cwd,
        cancelled: true,
      });
      return;
    }

    let stdoutRaw = stripNote;
    let stderrRaw = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', effectiveCommand],
      {
        cwd,
        windowsHide: true,
        env: process.env,
      },
    ) as ChildProcessWithoutNullStreams;
    activeJobs.set(jobId, {
      child,
      command: effectiveCommand.slice(0, 500),
      startedAt: Date.now(),
      markCancelled: () => {
        cancelled = true;
      },
    });

    const finish = (exitCode: number | null, errMsg?: string) => {
      if (settled) return;
      settled = true;
      activeJobs.delete(jobId);
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      const combined = [stdoutRaw, stderrRaw, errMsg].filter(Boolean).join('\n');
      const { text: combinedOut, truncated } = truncateOutput(combined);
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled && !errMsg,
        exit_code: timedOut || cancelled ? null : exitCode,
        stdout: combinedOut,
        stderr: errMsg || (cancelled ? 'ERROR: terminal job cancelled' : timedOut ? `ERROR: timed out after ${timeoutMs}ms` : ''),
        truncated,
        command: effectiveCommand,
        cwd,
        cancelled: cancelled || undefined,
      });
    };

    const onAbort = () => {
      cancelled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutRaw += chunk;
      if (Buffer.byteLength(stdoutRaw, 'utf8') > MAX_OUTPUT_BYTES * 2) {
        stdoutRaw = stdoutRaw.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderrRaw += chunk;
      if (Buffer.byteLength(stderrRaw, 'utf8') > MAX_OUTPUT_BYTES * 2) {
        stderrRaw = stderrRaw.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    child.on('error', (err) => finish(1, err.message));
    child.on('close', (code) => finish(code));
  });
}

export function runTerminalCommand(
  workspaceRoot: string,
  command: string,
  opts?: { timeoutMs?: number },
): RunTerminalResult {
  assertDevWorkspaceRootReadable(workspaceRoot);
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const sanitized = sanitizeShellCommandForPolicy(command);
  const effectiveCommand = sanitized.command;
  const validationError = validateShellCommand(effectiveCommand, cwd);
  if (validationError) {
    return {
      ok: false,
      exit_code: null,
      stdout: '',
      stderr: `ERROR: ${validationError}`,
      truncated: false,
      command: effectiveCommand,
      cwd,
    };
  }

  const existingClone = tryShortcutExistingRemoteClone(cwd, effectiveCommand);
  if (existingClone) return existingClone;

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', effectiveCommand],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      env: process.env,
    },
  );

  const stdoutRaw =
    (sanitized.stripped.length
      ? `NOTE: stripped unsafe prelude (${sanitized.stripped.length}): kept public clone only.\n`
      : '') + (proc.stdout ?? '');
  const stderrRaw = proc.stderr ?? '';
  const combined = [stdoutRaw, stderrRaw].filter(Boolean).join('\n');
  const { text: combinedOut, truncated } = truncateOutput(combined);

  const exitCode = proc.status ?? (proc.error ? 1 : 0);
  const timedOut = proc.error?.message?.includes('ETIMEDOUT') ?? false;

  return {
    ok: exitCode === 0 && !timedOut && !proc.error,
    exit_code: timedOut ? null : exitCode,
    stdout: stdoutRaw,
    stderr: timedOut
      ? `ERROR: command timed out after ${timeoutMs}ms`
      : proc.error
        ? `ERROR: ${proc.error.message}`
        : stderrRaw,
    truncated,
    command: effectiveCommand,
    cwd,
  };
}

export function formatRunTerminalOutput(result: RunTerminalResult): string {
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const { text: output, truncated } = truncateOutput(combined || '(no output)');
  return JSON.stringify(
    {
      ok: result.ok,
      exit_code: result.exit_code,
      output,
      truncated: result.truncated || truncated,
      cwd: result.cwd,
    },
    null,
    2,
  );
}

function assertGitRepo(workspaceRoot: string): void {
  const gitDir = path.join(normalizeWorkspacePath(workspaceRoot), '.git');
  if (!existsSync(gitDir)) {
    throw new Error('ERROR: not a git repository (no .git directory in workspace root)');
  }
}

/** Reject shell injection / flag smuggling into git ref / range args. */
function assertSafeGitToken(token: string, label: string): string {
  const t = token.trim();
  if (!t || t.length > 200) {
    throw new Error(`ERROR: invalid ${label}`);
  }
  if (t.startsWith('-')) {
    throw new Error(`ERROR: ${label} must not start with -`);
  }
  if (/[\s;&|`$<>\\"'\n\r\0]/.test(t)) {
    throw new Error(`ERROR: invalid characters in ${label}`);
  }
  // HEAD, @{u}, origin/main, v1.2.3, commit-ish ranges via separate assertSafeGitRange
  if (!/^[a-zA-Z0-9_./@^{}~+-]+$/.test(t)) {
    throw new Error(`ERROR: invalid ${label} syntax`);
  }
  return t;
}

/** Single ref or A..B / A...B comparison range. */
function assertSafeGitRange(range: string): string {
  const t = range.trim();
  if (!t || t.length > 240) {
    throw new Error('ERROR: invalid git range');
  }
  if (t.startsWith('-') || /[\s;&|`$<>\\"'\n\r\0]/.test(t)) {
    throw new Error('ERROR: invalid characters in git range');
  }
  if (!/^[a-zA-Z0-9_./@^{}~+-]+(\.{2,3}[a-zA-Z0-9_./@^{}~+-]+)?$/.test(t)) {
    throw new Error('ERROR: invalid git range syntax (use ref or A..B / A...B)');
  }
  return t;
}

function runGitCommand(
  workspaceRoot: string,
  args: string[],
  opts?: { timeoutMs?: number },
): RunTerminalResult {
  assertGitRepo(workspaceRoot);
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts?.timeoutMs ?? 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const stdoutRaw = proc.stdout ?? '';
  const stderrRaw = proc.stderr ?? '';
  const { text, truncated } = truncateOutput([stdoutRaw, stderrRaw].filter(Boolean).join('\n'));
  const exitCode = proc.status ?? 1;
  return {
    ok: exitCode === 0,
    exit_code: exitCode,
    stdout: text,
    stderr: stderrRaw,
    truncated,
    command: `git ${args.join(' ')}`,
    cwd,
  };
}

/** Initialize the selected workspace as a Git repository. Never touches a parent repo. */
export function gitInit(workspaceRoot: string, confirm = false): string {
  if (!confirm) {
    return JSON.stringify({ ok: false, error: 'git_init requires confirm=true' }, null, 2);
  }
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const proc = spawnSync('git', ['init'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const exitCode = proc.status ?? 1;
  return JSON.stringify(
    {
      ok: exitCode === 0,
      exit_code: exitCode,
      command: 'git init',
      output: String(proc.stdout || proc.stderr || proc.error?.message || '').trim(),
    },
    null,
    2,
  );
}

export function gitStatus(workspaceRoot: string): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const branch = runGitCommand(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = runGitCommand(workspaceRoot, ['status', '--porcelain=v1']);
  const head = runGitCommand(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
  const upstream = runGitCommand(workspaceRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  let aheadBehind: string | null = null;
  if (upstream.ok && upstream.stdout.trim()) {
    const ab = runGitCommand(workspaceRoot, [
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{upstream}',
    ]);
    if (ab.ok) {
      const [left, right] = ab.stdout.trim().split(/\s+/);
      aheadBehind = `ahead ${left ?? '?'} / behind ${right ?? '?'} (vs ${upstream.stdout.trim()})`;
    }
  }
  return JSON.stringify(
    {
      branch: branch.stdout.trim(),
      head: head.stdout.trim() || null,
      upstream: upstream.ok ? upstream.stdout.trim() : null,
      ahead_behind: aheadBehind,
      status: status.stdout.trim() || '(clean)',
      tip:
        'To compare with remote without changing files: git_fetch then git_diff range=HEAD...@{upstream} (or git_log). git_pull applies remote (confirm=true).',
      exit_code: status.exit_code,
    },
    null,
    2,
  );
}

export function gitDiff(
  workspaceRoot: string,
  relPath?: string,
  staged = false,
  range?: string,
): string {
  try {
    assertGitRepo(workspaceRoot);
    if (relPath?.trim()) {
      resolveDevWorkspaceReadPath(workspaceRoot, relPath.trim());
    }
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const args = ['diff'];
  if (range?.trim()) {
    if (staged) {
      return 'ERROR: git_diff cannot combine range with staged=true';
    }
    try {
      args.push(assertSafeGitRange(range));
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  } else if (staged) {
    args.push('--staged');
  }
  if (relPath?.trim()) args.push('--', relPath.trim());
  const result = runGitCommand(workspaceRoot, args);
  if (!result.ok && result.stderr.trim()) {
    return `ERROR: ${result.stderr.trim()}`;
  }
  return result.stdout.trim() || '(no diff)';
}

/**
 * Update remote-tracking refs only (no merge/reset). Preferred before "compare with remote".
 * Optional `repo` = workspace-relative `.my_agent_remote/<owner>__<repo>` for public inspect deepen.
 */
export function gitFetch(
  workspaceRoot: string,
  opts: { remote?: string; prune?: boolean; unshallow?: boolean; repo?: string } = {},
): string {
  let gitRoot = workspaceRoot;
  try {
    if (opts.repo?.trim()) {
      const rel = opts.repo.trim().replace(/\\/g, '/');
      if (!/^\.my_agent_remote\//i.test(rel)) {
        return JSON.stringify(
          {
            ok: false,
            error: 'git_fetch repo= must be under .my_agent_remote/<owner>__<repo> (public inspect only)',
          },
          null,
          2,
        );
      }
      const resolved = resolveDevWorkspaceReadPath(workspaceRoot, rel);
      gitRoot = resolved;
    }
    assertGitRepo(gitRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  let remote = 'origin';
  try {
    if (opts.remote?.trim()) remote = assertSafeGitToken(opts.remote, 'remote');
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const args = ['fetch'];
  if (opts.unshallow === true) args.push('--unshallow');
  args.push(remote);
  if (opts.prune === true) args.push('--prune');
  if (opts.unshallow === true) args.push('--tags');
  const result = runGitCommand(gitRoot, args, { timeoutMs: 180_000 });
  if (!result.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: result.stderr || result.stdout || 'git fetch failed',
        exit_code: result.exit_code,
        command: result.command,
        repo: opts.repo?.trim() || null,
      },
      null,
      2,
    );
  }
  const status = gitStatus(gitRoot);
  return JSON.stringify(
    {
      ok: true,
      command: result.command,
      repo: opts.repo?.trim() || null,
      unshallow: opts.unshallow === true,
      output: (result.stdout || result.stderr || '').trim() || '(fetch complete)',
      note: opts.repo
        ? 'Inspect clone updated. Next: run_terminal `git -C .my_agent_remote/... log --all --oneline` (or git_log if cwd is that repo).'
        : 'Working tree unchanged. Next: git_diff range=HEAD...@{upstream} and/or git_log range=HEAD..@{upstream}.',
      status_after: (() => {
        try {
          return JSON.parse(status);
        } catch {
          return status;
        }
      })(),
    },
    null,
    2,
  );
}

/** Short log between refs (read-only). */
export function gitLog(
  workspaceRoot: string,
  opts: { range?: string; max?: number } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const max = Math.min(Math.max(Number(opts.max) || 20, 1), 100);
  const args = ['log', `--max-count=${max}`, '--oneline', '--decorate'];
  if (opts.range?.trim()) {
    try {
      args.push(assertSafeGitRange(opts.range));
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const result = runGitCommand(workspaceRoot, args);
  if (!result.ok && result.stderr.trim()) {
    return `ERROR: ${result.stderr.trim()}`;
  }
  return result.stdout.trim() || '(no commits)';
}

/** Parse %d decoration list (e.g. " (HEAD -> master, origin/master, tag: v1)") into tips. */
function parseDecorations(deco: string): string[] {
  const raw = deco.trim().replace(/^\(|\)$/g, '');
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^HEAD\s*->\s*/, 'HEAD→').replace(/^tag:\s*/, 'tag:'))
    .slice(0, 20);
}

/**
 * Git history tree for human + agent display.
 * Structured commits (parents for DAG) + ASCII --graph for branch topology.
 */
export function gitHistoryTree(
  workspaceRoot: string,
  opts: {
    max?: number;
    all?: boolean;
    first_parent?: boolean;
    path?: string;
    range?: string;
  } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
    if (opts.path?.trim()) {
      resolveDevWorkspaceReadPath(workspaceRoot, opts.path.trim());
    }
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  const max = Math.min(Math.max(Number(opts.max) || 30, 1), 80);
  const branch = runGitCommand(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = runGitCommand(workspaceRoot, ['rev-parse', '--short', 'HEAD']);

  // Machine line: record separator RS (0x1e) between fields — unlikely in subject when we control format
  const SEP = '\x1e';
  const pretty = [
    '%H',
    '%h',
    '%P',
    '%D',
    '%s',
    '%an',
    '%aI',
  ].join(SEP);

  const logArgs = [
    'log',
    `--max-count=${max}`,
    `--pretty=format:${pretty}`,
  ];
  if (opts.all === true) logArgs.push('--all');
  if (opts.first_parent === true) logArgs.push('--first-parent');
  if (opts.range?.trim()) {
    try {
      logArgs.push(assertSafeGitRange(opts.range));
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  if (opts.path?.trim()) {
    logArgs.push('--', opts.path.trim().replace(/\\/g, '/'));
  }

  const parsed = runGitCommand(workspaceRoot, logArgs);
  if (!parsed.ok && parsed.stderr.trim()) {
    return JSON.stringify(
      { ok: false, error: parsed.stderr.trim() || 'git log failed' },
      null,
      2,
    );
  }

  const commits: Array<{
    hash: string;
    short: string;
    parents: string[];
    refs: string[];
    subject: string;
    author: string;
    date: string;
    is_merge: boolean;
  }> = [];

  for (const line of (parsed.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < 7) continue;
    const [hash, short, parentsRaw, deco, subject, author, date] = parts;
    const parents = (parentsRaw || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p.slice(0, 40));
    commits.push({
      hash: hash || '',
      short: short || (hash || '').slice(0, 7),
      parents,
      refs: parseDecorations(deco || ''),
      subject: (subject || '').slice(0, 200),
      author: (author || '').slice(0, 80),
      date: date || '',
      is_merge: parents.length > 1,
    });
  }

  // ASCII graph (same scope as structured log)
  const graphArgs = [
    'log',
    `--max-count=${max}`,
    '--graph',
    '--oneline',
    '--decorate',
    '--date-order',
  ];
  if (opts.all === true) graphArgs.push('--all');
  if (opts.first_parent === true) graphArgs.push('--first-parent');
  if (opts.range?.trim()) {
    try {
      graphArgs.push(assertSafeGitRange(opts.range));
    } catch {
      /* already validated above */
    }
  }
  if (opts.path?.trim()) {
    graphArgs.push('--', opts.path.trim().replace(/\\/g, '/'));
  }
  const graph = runGitCommand(workspaceRoot, graphArgs);
  let graphAscii = (graph.stdout || '').trim();
  // Cap graph text for LLM context
  const graphLines = graphAscii.split(/\r?\n/);
  if (graphLines.length > max + 5) {
    graphAscii = `${graphLines.slice(0, max + 5).join('\n')}\n…`;
  }
  if (graphAscii.length > 12_000) {
    graphAscii = `${graphAscii.slice(0, 12_000)}\n… (graph truncated)`;
  }

  // Simple children map for “who branched from this”
  const children: Record<string, string[]> = {};
  for (const c of commits) {
    for (const p of c.parents) {
      const key = p.slice(0, 7);
      if (!children[key]) children[key] = [];
      children[key]!.push(c.short);
    }
  }

  const tips = commits.filter((c) => c.refs.length > 0).slice(0, 40);

  return JSON.stringify(
    {
      ok: true,
      branch: branch.stdout.trim() || null,
      head: head.stdout.trim() || null,
      scope: {
        max,
        all: opts.all === true,
        first_parent: opts.first_parent === true,
        path: opts.path?.trim() || null,
        range: opts.range?.trim() || null,
      },
      commit_count: commits.length,
      merge_count: commits.filter((c) => c.is_merge).length,
      graph_ascii: graphAscii || '(empty graph)',
      commits,
      tips,
      tip_note:
        'graph_ascii = branch topology; commits[] = DAG (parents). all=true shows other branches. first_parent=true linearizes merges. User asked for history tree → prefer this over plain git_log.',
    },
    null,
    2,
  );
}

/**
 * Fast-forward pull only. Requires confirm=true. Prefer fetch+diff when user asks to compare first.
 */
export function gitPull(
  workspaceRoot: string,
  opts: { confirm?: boolean; remote?: string; branch?: string } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  if (opts.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'git_pull requires confirm=true. Prefer: git_status → git_fetch → git_diff range=HEAD...@{upstream} (incoming) + working-tree git_diff (local dirty). Then git_pull with confirm=true only if user wants remote applied.',
      },
      null,
      2,
    );
  }

  const headBefore = runGitCommand(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
  const dirty = runGitCommand(workspaceRoot, ['status', '--porcelain=v1']);
  const args = ['pull', '--ff-only'];
  try {
    if (opts.remote?.trim()) {
      args.push(assertSafeGitToken(opts.remote, 'remote'));
      if (opts.branch?.trim()) args.push(assertSafeGitToken(opts.branch, 'branch'));
    } else if (opts.branch?.trim()) {
      return JSON.stringify(
        {
          ok: false,
          error: 'branch requires remote (e.g. remote=origin branch=main)',
        },
        null,
        2,
      );
    }
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  const result = runGitCommand(workspaceRoot, args, { timeoutMs: 180_000 });
  const headAfter = runGitCommand(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
  if (!result.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: result.stderr || result.stdout || 'git pull --ff-only failed',
        exit_code: result.exit_code,
        command: result.command,
        hint:
          'ff-only refused if history diverged or working tree blocks pull. Use git_fetch + git_diff/git_log to compare; resolve conflicts outside force-tools.',
        head_before: headBefore.stdout.trim() || null,
        dirty_before: dirty.stdout.trim() || '(clean)',
      },
      null,
      2,
    );
  }

  const changed = runGitCommand(workspaceRoot, [
    'log',
    '--oneline',
    `${headBefore.stdout.trim()}..${headAfter.stdout.trim()}`,
  ]);
  const rangeDiff = runGitCommand(workspaceRoot, [
    'diff',
    '--stat',
    `${headBefore.stdout.trim()}..${headAfter.stdout.trim()}`,
  ]);

  return JSON.stringify(
    {
      ok: true,
      command: result.command,
      head_before: headBefore.stdout.trim() || null,
      head_after: headAfter.stdout.trim() || null,
      commits_pulled: (changed.stdout || '').trim() || '(none / already up to date)',
      diff_stat: (rangeDiff.stdout || '').trim() || '(no file changes)',
      output: (result.stdout || result.stderr || '').trim(),
      note: 'push still unavailable. Local uncommitted changes (if any) were not part of remote compare — re-run git_status / git_diff.',
    },
    null,
    2,
  );
}

/**
 * Stage + commit. Requires confirm=true. Never pushes.
 * - paths empty → `git add -u` (tracked changes only; safer than -A)
 * - paths set → add those relative paths only
 */
export function gitCommit(
  workspaceRoot: string,
  message: string,
  opts: { confirm?: boolean; paths?: string[] } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  const msg = message.trim();
  if (!msg) {
    return JSON.stringify({ ok: false, error: 'message is required' }, null, 2);
  }
  if (opts.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'git_commit requires confirm=true. Show git_status/git_diff to the user first, then call again with confirm=true.',
      },
      null,
      2,
    );
  }
  if (/^-/.test(msg) || msg.includes('\0')) {
    return JSON.stringify({ ok: false, error: 'invalid commit message' }, null, 2);
  }

  const paths = (opts.paths ?? [])
    .map((p) => String(p).trim().replace(/\\/g, '/'))
    .filter(Boolean);

  for (const rel of paths) {
    try {
      resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch (e: unknown) {
      return JSON.stringify(
        {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
        null,
        2,
      );
    }
  }

  const addArgs = paths.length ? ['add', '--', ...paths] : ['add', '-u'];
  const add = runGitCommand(workspaceRoot, addArgs);
  if (!add.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: `git add failed: ${add.stderr || add.stdout}`,
        command: add.command,
      },
      null,
      2,
    );
  }

  const staged = runGitCommand(workspaceRoot, ['diff', '--staged', '--name-only']);
  if (!staged.stdout.trim()) {
    return JSON.stringify(
      {
        ok: false,
        error: 'nothing to commit (no staged changes). Pass paths or ensure tracked files changed.',
      },
      null,
      2,
    );
  }

  const commit = runGitCommand(workspaceRoot, ['commit', '-m', msg]);
  if (!commit.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: commit.stderr || commit.stdout || 'git commit failed',
        exit_code: commit.exit_code,
      },
      null,
      2,
    );
  }

  const hash = runGitCommand(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
  return JSON.stringify(
    {
      ok: true,
      commit: hash.stdout.trim(),
      message: msg,
      staged_files: staged.stdout.trim().split(/\r?\n/).filter(Boolean),
      note: 'Use git_push confirm=true only when the user explicitly asks to push. Never force-push.',
    },
    null,
    2,
  );
}

function resolveGitPaths(
  workspaceRoot: string,
  paths: string[] | undefined,
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const list = (paths ?? [])
    .map((p) => String(p).trim().replace(/\\/g, '/'))
    .filter(Boolean);
  for (const rel of list) {
    try {
      resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, paths: list };
}

/**
 * Cursor-style one-shot: status + optional fetch + incoming/outgoing/local dirty summary.
 * Prefer this when user asks to pull/compare/sync without requiring multi-step inventing.
 */
export function gitSyncPreview(
  workspaceRoot: string,
  opts: { fetch?: boolean; remote?: string } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  const doFetch = opts.fetch !== false;
  let fetchResult: unknown = null;
  if (doFetch) {
    const raw = gitFetch(workspaceRoot, { remote: opts.remote });
    try {
      fetchResult = JSON.parse(raw);
    } catch {
      fetchResult = raw;
    }
  }

  const branch = runGitCommand(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = runGitCommand(workspaceRoot, ['rev-parse', '--short', 'HEAD']);
  const porcelain = runGitCommand(workspaceRoot, ['status', '--porcelain=v1']);
  const dirtyStat = runGitCommand(workspaceRoot, ['diff', '--stat']);
  const stagedStat = runGitCommand(workspaceRoot, ['diff', '--staged', '--stat']);
  const upstream = runGitCommand(workspaceRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  const hasUp = upstream.ok && Boolean(upstream.stdout.trim());

  let aheadBehind: string | null = null;
  let incomingLog = '(no upstream)';
  let outgoingLog = '(no upstream)';
  let incomingStat = '(no upstream)';
  let outgoingStat = '(no upstream)';

  if (hasUp) {
    const ab = runGitCommand(workspaceRoot, [
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{upstream}',
    ]);
    if (ab.ok) {
      const [left, right] = ab.stdout.trim().split(/\s+/);
      aheadBehind = `ahead ${left ?? '0'} / behind ${right ?? '0'}`;
    }
    incomingLog =
      runGitCommand(workspaceRoot, ['log', '--oneline', '--decorate', '--max-count=30', 'HEAD..@{upstream}'])
        .stdout.trim() || '(no incoming commits)';
    outgoingLog =
      runGitCommand(workspaceRoot, ['log', '--oneline', '--decorate', '--max-count=30', '@{upstream}..HEAD'])
        .stdout.trim() || '(no outgoing commits)';
    incomingStat =
      runGitCommand(workspaceRoot, ['diff', '--stat', 'HEAD...@{upstream}']).stdout.trim()
      || '(no incoming file changes)';
    outgoingStat =
      runGitCommand(workspaceRoot, ['diff', '--stat', '@{upstream}...HEAD']).stdout.trim()
      || '(no outgoing file changes)';
  }

  const conflictPaths = (porcelain.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(DD|AU|UD|UA|DU|AA|UU)\s/.test(l) || l.startsWith('U'));

  return JSON.stringify(
    {
      ok: true,
      branch: branch.stdout.trim(),
      head: head.stdout.trim() || null,
      upstream: hasUp ? upstream.stdout.trim() : null,
      ahead_behind: aheadBehind,
      fetch: fetchResult,
      local_dirty: porcelain.stdout.trim() || '(clean)',
      local_diff_stat: dirtyStat.stdout.trim() || '(no unstaged)',
      staged_diff_stat: stagedStat.stdout.trim() || '(no staged)',
      conflicts: conflictPaths.length ? conflictPaths : [],
      incoming_commits: incomingLog,
      incoming_diff_stat: incomingStat,
      outgoing_commits: outgoingLog,
      outgoing_diff_stat: outgoingStat,
      next_steps: [
        hasUp && String(aheadBehind || '').includes('behind') && !String(aheadBehind || '').startsWith('ahead')
          ? 'Remote has commits you lack → show incoming_*; apply with git_pull confirm=true if user wants.'
          : null,
        porcelain.stdout.trim()
          ? 'Local uncommitted changes present — do not silent pull/switch; summarize local_dirty first.'
          : null,
        'To apply remote: git_pull confirm=true (ff-only). To publish: git_push confirm=true after commit when user asks.',
        'Detail: git_diff range=HEAD...@{upstream} or path-scoped git_diff / git_show.',
      ].filter(Boolean),
    },
    null,
    2,
  );
}

export function gitShow(
  workspaceRoot: string,
  opts: { ref?: string; path?: string; stat_only?: boolean } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const args = ['show', '--no-color'];
  if (opts.stat_only === true) args.push('--stat');
  try {
    const ref = opts.ref?.trim() ? assertSafeGitToken(opts.ref, 'ref') : 'HEAD';
    args.push(ref);
    if (opts.path?.trim()) {
      const rp = resolveGitPaths(workspaceRoot, [opts.path]);
      if (!rp.ok) return `ERROR: ${rp.error}`;
      args.push('--', rp.paths[0]!);
    }
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const result = runGitCommand(workspaceRoot, args);
  if (!result.ok && result.stderr.trim()) return `ERROR: ${result.stderr.trim()}`;
  return result.stdout.trim() || '(empty show)';
}

export function gitBlame(
  workspaceRoot: string,
  relPath: string,
  opts: { max?: number } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
    const rp = resolveGitPaths(workspaceRoot, [relPath]);
    if (!rp.ok) return `ERROR: ${rp.error}`;
    const max = Math.min(Math.max(Number(opts.max) || 200, 1), 500);
    const result = runGitCommand(workspaceRoot, [
      'blame',
      '-L',
      `1,${max}`,
      '--',
      rp.paths[0]!,
    ]);
    if (!result.ok && result.stderr.trim()) return `ERROR: ${result.stderr.trim()}`;
    return result.stdout.trim() || '(no blame)';
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function gitBranch(
  workspaceRoot: string,
  opts: {
    action?: 'list' | 'create';
    name?: string;
    all?: boolean;
    confirm?: boolean;
  } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const action = opts.action === 'create' ? 'create' : 'list';
  if (action === 'list') {
    const args = opts.all === true ? ['branch', '-a', '-vv'] : ['branch', '-vv'];
    const result = runGitCommand(workspaceRoot, args);
    if (!result.ok) {
      return JSON.stringify(
        { ok: false, error: result.stderr || result.stdout },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        ok: true,
        branches: result.stdout.trim() || '(none)',
      },
      null,
      2,
    );
  }
  if (opts.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error: 'git_branch create requires confirm=true',
      },
      null,
      2,
    );
  }
  let name: string;
  try {
    name = assertSafeGitToken(String(opts.name || ''), 'branch name');
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  if (name.includes('..') || name.includes('@{')) {
    return JSON.stringify({ ok: false, error: 'invalid branch name' }, null, 2);
  }
  const result = runGitCommand(workspaceRoot, ['branch', name]);
  if (!result.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: result.stderr || result.stdout || 'git branch failed',
        exit_code: result.exit_code,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      ok: true,
      created: name,
      note: 'Branch created; not switched. Use git_switch confirm=true to check out.',
    },
    null,
    2,
  );
}

/** Switch branch (no force). Requires confirm=true. Refuses when tree dirty unless force_dirty=true+confirm. */
export function gitSwitch(
  workspaceRoot: string,
  opts: {
    branch: string;
    confirm?: boolean;
    create?: boolean;
    force_dirty?: boolean;
  },
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  if (opts.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'git_switch requires confirm=true. Prefer git_sync_preview first when comparing remotes.',
      },
      null,
      2,
    );
  }
  let branch: string;
  try {
    branch = assertSafeGitToken(opts.branch, 'branch');
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const dirty = runGitCommand(workspaceRoot, ['status', '--porcelain=v1']);
  if (dirty.stdout.trim() && opts.force_dirty !== true) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'working tree not clean; commit/stash first or re-call with force_dirty=true and confirm=true (may fail if conflicts)',
        dirty: dirty.stdout.trim(),
      },
      null,
      2,
    );
  }
  const args = opts.create === true ? ['switch', '-c', branch] : ['switch', branch];
  const result = runGitCommand(workspaceRoot, args);
  if (!result.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: result.stderr || result.stdout || 'git switch failed',
        exit_code: result.exit_code,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      ok: true,
      branch,
      created: opts.create === true,
      output: (result.stdout || result.stderr || '').trim(),
    },
    null,
    2,
  );
}

export function gitStage(
  workspaceRoot: string,
  opts: {
    paths?: string[];
    all_tracked?: boolean;
    unstage?: boolean;
  } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const rp = resolveGitPaths(workspaceRoot, opts.paths);
  if (!rp.ok) return JSON.stringify({ ok: false, error: rp.error }, null, 2);

  if (opts.unstage === true) {
    if (!rp.paths.length) {
      return JSON.stringify(
        { ok: false, error: 'unstage requires paths' },
        null,
        2,
      );
    }
    const result = runGitCommand(workspaceRoot, [
      'restore',
      '--staged',
      '--',
      ...rp.paths,
    ]);
    if (!result.ok) {
      return JSON.stringify(
        {
          ok: false,
          error: result.stderr || result.stdout,
          command: result.command,
        },
        null,
        2,
      );
    }
    return JSON.stringify({ ok: true, unstaged: rp.paths }, null, 2);
  }

  if (!rp.paths.length && opts.all_tracked !== true) {
    return JSON.stringify(
      {
        ok: false,
        error: 'provide paths or all_tracked=true (git add -u)',
      },
      null,
      2,
    );
  }
  const addArgs = rp.paths.length ? ['add', '--', ...rp.paths] : ['add', '-u'];
  const add = runGitCommand(workspaceRoot, addArgs);
  if (!add.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: add.stderr || add.stdout,
        command: add.command,
      },
      null,
      2,
    );
  }
  const staged = runGitCommand(workspaceRoot, ['diff', '--staged', '--name-only']);
  return JSON.stringify(
    {
      ok: true,
      staged_files: staged.stdout.trim().split(/\r?\n/).filter(Boolean),
    },
    null,
    2,
  );
}

/**
 * Restore paths (discard worktree and/or unstage). worktree discard requires confirm=true.
 */
export function gitRestore(
  workspaceRoot: string,
  opts: {
    paths: string[];
    mode?: 'worktree' | 'staged' | 'both';
    confirm?: boolean;
  },
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const mode = opts.mode === 'staged' || opts.mode === 'both' ? opts.mode : 'worktree';
  const rp = resolveGitPaths(workspaceRoot, opts.paths);
  if (!rp.ok) return JSON.stringify({ ok: false, error: rp.error }, null, 2);
  if (!rp.paths.length) {
    return JSON.stringify({ ok: false, error: 'paths required' }, null, 2);
  }
  if ((mode === 'worktree' || mode === 'both') && opts.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'git_restore worktree/both requires confirm=true (discards uncommitted edits). mode=staged only does not.',
      },
      null,
      2,
    );
  }
  const results: string[] = [];
  if (mode === 'staged' || mode === 'both') {
    const r = runGitCommand(workspaceRoot, ['restore', '--staged', '--', ...rp.paths]);
    results.push(r.ok ? 'staged restored' : `staged fail: ${r.stderr || r.stdout}`);
    if (!r.ok && mode === 'staged') {
      return JSON.stringify({ ok: false, error: r.stderr || r.stdout }, null, 2);
    }
  }
  if (mode === 'worktree' || mode === 'both') {
    const r = runGitCommand(workspaceRoot, ['restore', '--worktree', '--', ...rp.paths]);
    results.push(r.ok ? 'worktree restored' : `worktree fail: ${r.stderr || r.stdout}`);
    if (!r.ok) {
      return JSON.stringify({ ok: false, error: r.stderr || r.stdout, steps: results }, null, 2);
    }
  }
  return JSON.stringify({ ok: true, paths: rp.paths, mode, steps: results }, null, 2);
}

export function gitStash(
  workspaceRoot: string,
  opts: {
    action?: 'list' | 'push' | 'pop' | 'drop';
    message?: string;
    confirm?: boolean;
    index?: number;
  } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  const action = opts.action ?? 'list';
  if (action === 'list') {
    const result = runGitCommand(workspaceRoot, ['stash', 'list']);
    return JSON.stringify(
      {
        ok: true,
        stashes: result.stdout.trim() || '(empty)',
      },
      null,
      2,
    );
  }
  if (action === 'push') {
    const args = ['stash', 'push', '-u'];
    if (opts.message?.trim()) {
      const msg = opts.message.trim();
      if (/[\0\r\n]/.test(msg) || msg.startsWith('-')) {
        return JSON.stringify({ ok: false, error: 'invalid stash message' }, null, 2);
      }
      args.push('-m', msg);
    }
    const result = runGitCommand(workspaceRoot, args);
    if (!result.ok) {
      return JSON.stringify(
        { ok: false, error: result.stderr || result.stdout },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        ok: true,
        action: 'push',
        output: (result.stdout || result.stderr || '').trim(),
      },
      null,
      2,
    );
  }
  if (action === 'pop' || action === 'drop') {
    if (opts.confirm !== true) {
      return JSON.stringify(
        {
          ok: false,
          error: `git_stash ${action} requires confirm=true`,
        },
        null,
        2,
      );
    }
    const idx = Number.isFinite(opts.index) ? Math.max(0, Math.floor(Number(opts.index))) : 0;
    const ref = `stash@{${idx}}`;
    const result = runGitCommand(workspaceRoot, ['stash', action, ref]);
    if (!result.ok) {
      return JSON.stringify(
        {
          ok: false,
          error: result.stderr || result.stdout,
          exit_code: result.exit_code,
        },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        ok: true,
        action,
        ref,
        output: (result.stdout || result.stderr || '').trim(),
      },
      null,
      2,
    );
  }
  return JSON.stringify({ ok: false, error: `unknown action ${action}` }, null, 2);
}

/**
 * Push to remote. confirm=true required. Never --force / --force-with-lease.
 */
export function gitPush(
  workspaceRoot: string,
  opts: {
    confirm?: boolean;
    remote?: string;
    branch?: string;
    set_upstream?: boolean;
  } = {},
): string {
  try {
    assertGitRepo(workspaceRoot);
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  if (opts.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'git_push requires confirm=true after user request + git_status/git_log. Never force-push.',
      },
      null,
      2,
    );
  }
  const args = ['push'];
  try {
    if (opts.set_upstream === true) args.push('-u');
    if (opts.remote?.trim()) {
      args.push(assertSafeGitToken(opts.remote, 'remote'));
      if (opts.branch?.trim()) args.push(assertSafeGitToken(opts.branch, 'branch'));
    } else if (opts.branch?.trim()) {
      return JSON.stringify(
        { ok: false, error: 'branch requires remote when set' },
        null,
        2,
      );
    }
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
  // Refuse any accidental force flags if ever passed via future args
  if (args.some((a) => /force/i.test(a))) {
    return JSON.stringify({ ok: false, error: 'force push is blocked' }, null, 2);
  }
  const result = runGitCommand(workspaceRoot, args, { timeoutMs: 180_000 });
  if (!result.ok) {
    return JSON.stringify(
      {
        ok: false,
        error: result.stderr || result.stdout || 'git push failed',
        exit_code: result.exit_code,
        command: result.command,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      ok: true,
      command: result.command,
      output: (result.stdout || result.stderr || '').trim() || '(push complete)',
    },
    null,
    2,
  );
}

/** Exported for run-tests / apply flows that need raw git argv. */
export { runGitCommand, assertGitRepo };
