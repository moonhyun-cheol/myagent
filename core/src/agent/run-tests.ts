import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeWorkspacePath } from '../security/dev-workspace-guard.js';
import {
  formatRunTerminalOutput,
  runTerminalCommand,
  type RunTerminalResult,
} from './run-terminal.js';

export type DetectedTestRunner =
  | { kind: 'npm'; command: string; reason: string }
  | { kind: 'pytest'; command: string; reason: string }
  | { kind: 'cargo'; command: string; reason: string }
  | { kind: 'go'; command: string; reason: string }
  | { kind: 'none'; command: null; reason: string };

const MAX_OUTPUT = 100_000;

function truncate(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_OUTPUT) return { text, truncated: false };
  return {
    text: `${buf.subarray(0, MAX_OUTPUT).toString('utf8')}\n… (output truncated)`,
    truncated: true,
  };
}

function resolveRunner(bin: string): string {
  if (process.platform === 'win32') {
    if (bin === 'npm' || bin === 'npx' || bin === 'yarn' || bin === 'pnpm') {
      return `${bin}.cmd`;
    }
  }
  return bin;
}

function runArgv(
  workspaceRoot: string,
  file: string,
  args: string[],
  timeoutMs = 180_000,
): RunTerminalResult {
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const exe = resolveRunner(file);
  const proc = spawnSync(exe, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT * 2,
    shell: false,
    env: process.env,
  });
  const stdoutRaw = proc.stdout ?? '';
  const stderrRaw = proc.stderr ?? '';
  const timedOut = proc.error?.message?.includes('ETIMEDOUT') ?? false;
  const exitCode = proc.status ?? (proc.error ? 1 : 0);
  return {
    ok: exitCode === 0 && !timedOut && !proc.error,
    exit_code: timedOut ? null : exitCode,
    stdout: stdoutRaw,
    stderr: timedOut
      ? `ERROR: timed out after ${timeoutMs}ms`
      : proc.error
        ? `ERROR: ${proc.error.message}`
        : stderrRaw,
    truncated: false,
    command: `${exe} ${args.join(' ')}`,
    cwd,
  };
}

type PytestCandidate = { file: string; prefixArgs: string[]; source: string };

/**
 * Resolve Python deterministically without assuming that a `pytest` console script is on PATH.
 * Project-local environments win, then the workspace-level environment, then platform launchers.
 */
export function resolvePytestCandidates(workspaceRoot: string): PytestCandidate[] {
  const root = normalizeWorkspacePath(workspaceRoot);
  const parent = path.dirname(root);
  const envPython = process.env.MY_AGENT_TEST_PYTHON?.trim();
  const localPaths = process.platform === 'win32'
    ? [
        path.join(root, '.venv', 'Scripts', 'python.exe'),
        path.join(root, 'venv', 'Scripts', 'python.exe'),
        path.join(parent, '.venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(root, '.venv', 'bin', 'python'),
        path.join(root, 'venv', 'bin', 'python'),
        path.join(parent, '.venv', 'bin', 'python'),
      ];

  const candidates: PytestCandidate[] = [];
  if (envPython) candidates.push({ file: envPython, prefixArgs: [], source: 'MY_AGENT_TEST_PYTHON' });
  for (const file of localPaths) {
    if (existsSync(file)) candidates.push({ file, prefixArgs: [], source: 'workspace venv' });
  }
  candidates.push({ file: 'python', prefixArgs: [], source: 'PATH python' });
  candidates.push({ file: 'python3', prefixArgs: [], source: 'PATH python3' });
  if (process.platform === 'win32') {
    candidates.push({ file: 'py', prefixArgs: ['-3'], source: 'Windows Python launcher' });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.file}\0${candidate.prefixArgs.join('\0')}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pytestUnavailable(result: RunTerminalResult): boolean {
  const detail = `${result.stdout}\n${result.stderr}`;
  return /(?:ENOENT|not recognized|command not found|No module named (?:pytest|'pytest'))/i.test(detail);
}

function runPytestWithFallback(workspaceRoot: string, timeoutMs?: number): RunTerminalResult {
  const attempts: string[] = [];
  let last: RunTerminalResult | null = null;
  for (const candidate of resolvePytestCandidates(workspaceRoot)) {
    const result = runArgv(
      workspaceRoot,
      candidate.file,
      [...candidate.prefixArgs, '-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'],
      timeoutMs,
    );
    last = result;
    if (!pytestUnavailable(result)) return result;
    attempts.push(`${candidate.source}: ${result.command}`);
  }
  if (!last) return runArgv(workspaceRoot, 'python', ['-B', '-m', 'pytest', '-q'], timeoutMs);
  return {
    ...last,
    stderr: `${last.stderr}\nERROR: pytest runtime unavailable after deterministic candidates:\n${attempts.join('\n')}`.trim(),
  };
}

export function detectTestRunner(workspaceRoot: string): DetectedTestRunner {
  const root = normalizeWorkspacePath(workspaceRoot);
  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.test) {
        return {
          kind: 'npm',
          command: 'npm test',
          reason: 'package.json scripts.test',
        };
      }
      if (pkg.scripts?.['test:unit']) {
        return {
          kind: 'npm',
          command: 'npm run test:unit',
          reason: 'package.json scripts.test:unit',
        };
      }
      // Quality gate only (node --check / lint) — not Playwright e2e.
      if (pkg.scripts?.['test:quality']) {
        const body = String(pkg.scripts['test:quality']);
        if (!/playwright|cypress|compat/i.test(body)) {
          return {
            kind: 'npm',
            command: 'npm run test:quality',
            reason: 'package.json scripts.test:quality',
          };
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (
    existsSync(path.join(root, 'pytest.ini')) ||
    existsSync(path.join(root, 'conftest.py')) ||
    existsSync(path.join(root, 'pyproject.toml'))
  ) {
    const hasTests =
      existsSync(path.join(root, 'tests')) ||
      existsSync(path.join(root, 'test')) ||
      existsSync(path.join(root, 'pytest.ini'));
    if (hasTests || existsSync(path.join(root, 'pyproject.toml'))) {
      return { kind: 'pytest', command: 'python -m pytest -q', reason: 'python test layout' };
    }
  }

  if (existsSync(path.join(root, 'Cargo.toml'))) {
    return { kind: 'cargo', command: 'cargo test', reason: 'Cargo.toml' };
  }

  if (existsSync(path.join(root, 'go.mod'))) {
    return { kind: 'go', command: 'go test ./...', reason: 'go.mod' };
  }

  return {
    kind: 'none',
    command: null,
    reason: 'no known test runner (package.json test / pytest / cargo / go)',
  };
}

export function runWorkspaceTests(
  workspaceRoot: string,
  opts?: { command?: string; timeoutMs?: number },
): string {
  const detected = detectTestRunner(workspaceRoot);
  const override = opts?.command?.trim();
  const command = override || detected.command;
  if (!command) {
    return JSON.stringify(
      {
        ok: false,
        skipped: true,
        weak: true,
        noop: true,
        status: 'skip',
        detected,
        error: null,
        message:
          'No test command detected — skipped ≠ pass. Pass command explicitly or add package.json scripts.test. Do not claim project tests green.',
      },
      null,
      2,
    );
  }

  // Prefer argv spawns for common runners; npm on Windows needs shell (.cmd).
  let result: RunTerminalResult;
  if (!override && detected.kind === 'npm' && command === 'npm test') {
    if (process.platform === 'win32') {
      result = runTerminalCommand(workspaceRoot, 'npm test', { timeoutMs: opts?.timeoutMs ?? 180_000 });
    } else {
      result = runArgv(workspaceRoot, 'npm', ['test'], opts?.timeoutMs);
    }
  } else if (!override && detected.kind === 'npm' && command.startsWith('npm run ')) {
    const script = command.slice('npm run '.length).trim();
    if (process.platform === 'win32') {
      result = runTerminalCommand(workspaceRoot, `npm run ${script}`, {
        timeoutMs: opts?.timeoutMs ?? 180_000,
      });
    } else {
      result = runArgv(workspaceRoot, 'npm', ['run', script], opts?.timeoutMs);
    }
  } else if (!override && detected.kind === 'pytest') {
    result = runPytestWithFallback(workspaceRoot, opts?.timeoutMs);
  } else if (!override && detected.kind === 'cargo') {
    result = runArgv(workspaceRoot, 'cargo', ['test'], opts?.timeoutMs);
  } else if (!override && detected.kind === 'go') {
    result = runArgv(workspaceRoot, 'go', ['test', './...'], opts?.timeoutMs);
  } else {
    result = runTerminalCommand(workspaceRoot, command, { timeoutMs: opts?.timeoutMs ?? 180_000 });
  }

  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const { text: output, truncated } = truncate(combined || '(no output)');
  return JSON.stringify(
    {
      ok: result.ok,
      exit_code: result.exit_code,
      detected,
      command: result.command,
      output,
      truncated: result.truncated || truncated,
      cwd: result.cwd,
    },
    null,
    2,
  );
}

export { formatRunTerminalOutput };
