import { spawn } from 'node:child_process';
import { assertDevWorkspaceRootReadable, normalizeWorkspacePath } from '../security/dev-workspace-guard.js';
import { runTerminalCommandAsync, killProcessTree, type RunTerminalResult } from './run-terminal.js';
import { detectTestRunner, resolvePytestCandidates, runWorkspaceTests } from './run-tests.js';
import { detectDiagnostics, runWorkspaceDiagnostics } from './run-diagnostics.js';

type Options = {
  command?: string; timeoutMs?: number; signal?: AbortSignal; jobId?: string;
  changedPaths?: string[];
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
};

/** Preserve pytest's deterministic argv candidates without blocking the API event loop. */
async function runPython(workspaceRoot: string, file: string, args: string[], opts: Options): Promise<RunTerminalResult> {
  assertDevWorkspaceRootReadable(workspaceRoot);
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const command = [file, ...args].join(' ');
  if (opts.signal?.aborted) return { ok: false, cancelled: true, command, cwd, exit_code: null, stdout: '', stderr: 'cancelled', truncated: false };
  return new Promise((resolve) => {
    let stdout = '', stderr = '', truncated = false, settled = false, timedOut = false;
    const child = spawn(file, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { killProcessTree(child); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs ?? 180_000);
    opts.signal?.addEventListener('abort', stop, { once: true });
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', stop);
      const cancelled = opts.signal?.aborted === true;
      resolve({ ok: code === 0 && !error && !timedOut && !cancelled,
        exit_code: timedOut || cancelled ? null : code, command, cwd, stdout,
        stderr: [stderr, error, timedOut ? 'ERROR: timed out' : '', cancelled ? 'ERROR: cancelled' : ''].filter(Boolean).join('\n'),
        truncated, cancelled });
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk: string) => {
        try { opts.onOutput?.(stream, chunk); } catch { /* observer only */ }
        if (stream === 'stdout') { if (stdout.length + chunk.length > 100_000) truncated = true; stdout = (stdout + chunk).slice(0, 100_000); }
        else { if (stderr.length + chunk.length > 100_000) truncated = true; stderr = (stderr + chunk).slice(0, 100_000); }
      });
    }
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code));
  });
}

function formatted(result: RunTerminalResult, detected: unknown): string {
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return JSON.stringify({ ok: result.ok, exit_code: result.exit_code, cancelled: result.cancelled,
    detected, command: result.command, output: combined.slice(0, 100_000) || '(no output)',
    truncated: result.truncated || combined.length > 100_000, cwd: result.cwd }, null, 2);
}

export async function runWorkspaceTestsAsync(root: string, opts: Options = {}): Promise<string> {
  const detected = detectTestRunner(root);
  const command = opts.command?.trim() || detected.command;
  if (!command) return runWorkspaceTests(root, opts); // metadata-only skip
  if (!opts.command?.trim() && detected.kind === 'pytest') {
    const attempts: string[] = [];
    let last: RunTerminalResult | undefined;
    for (const candidate of resolvePytestCandidates(root)) {
      last = await runPython(root, candidate.file, [...candidate.prefixArgs, '-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'], opts);
      if (last.cancelled || !/(?:ENOENT|not recognized|command not found|No module named (?:pytest|'pytest'))/i.test(`${last.stdout}\n${last.stderr}`)) return formatted(last, detected);
      attempts.push(`${candidate.source}: ${last.command}`);
    }
    if (last) return formatted({ ...last, stderr: `${last.stderr}\nERROR: pytest runtime unavailable after deterministic candidates:\n${attempts.join('\n')}` }, detected);
  }
  return formatted(await runTerminalCommandAsync(root, command, { ...opts, timeoutMs: opts.timeoutMs ?? 180_000 }), detected);
}

export async function runWorkspaceDiagnosticsAsync(root: string, opts: Options = {}): Promise<string> {
  const detected = detectDiagnostics(root, { focusPaths: opts.changedPaths });
  const command = opts.command?.trim() || detected.command;
  // Preserve existing weak node-syntax fallback semantics; it is not a project checker.
  if (!command) return runWorkspaceDiagnostics(root, opts);
  return formatted(await runTerminalCommandAsync(root, command, opts), detected);
}
