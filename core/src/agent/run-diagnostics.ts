/**
 * Detect and run workspace diagnostics (tsc / eslint / oxlint / ruff / pyright).
 * Used by run_diagnostics tool and the autonomous verify loop.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeWorkspacePath } from '../security/dev-workspace-guard.js';
import {
  formatRunTerminalOutput,
  runTerminalCommand,
  type RunTerminalResult,
} from './run-terminal.js';

export type DetectedDiagnostic =
  | { kind: 'tsc'; command: string; reason: string }
  | { kind: 'eslint'; command: string; reason: string }
  | { kind: 'oxlint'; command: string; reason: string }
  | { kind: 'ruff'; command: string; reason: string }
  | { kind: 'pyright'; command: string; reason: string }
  | { kind: 'npm_script'; command: string; reason: string }
  | { kind: 'node_syntax'; command: string; reason: string }
  | { kind: 'none'; command: null; reason: string };

const MAX_OUTPUT = 80_000;
const JS_EXT_RE = /\.(?:js|mjs|cjs)$/i;

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
  timeoutMs = 120_000,
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

function hasLocalBin(root: string, name: string): boolean {
  const base = path.join(root, 'node_modules', '.bin', name);
  if (existsSync(base)) return true;
  if (process.platform === 'win32' && existsSync(`${base}.cmd`)) return true;
  return false;
}

/**
 * Cheap package.json quality scripts (not Playwright/e2e).
 * Treated as strong diagnostics when exit 0 — unlike bare node --check fallback.
 */
function detectNpmQualityScript(root: string): DetectedDiagnostic | null {
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const prefer = ['test:quality', 'lint', 'typecheck', 'check', 'test:lint'];
    for (const name of prefer) {
      const body = scripts[name];
      if (!body || typeof body !== 'string') continue;
      // Skip scripts that clearly launch browsers / long e2e.
      if (/playwright|cypress|puppeteer|selenium|test:e2e|test:compat/i.test(name + body)) {
        continue;
      }
      return {
        kind: 'npm_script',
        command: `npm run ${name}`,
        reason: `package.json scripts.${name}`,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Prefer the strongest cheap checker available in the workspace. */
export function pathsFocusWorkspaceUiSrc(paths: string[] | undefined): boolean {
  if (!paths?.length) return false;
  return paths.some((p) => /(?:^|\/)ui\/workspace\/src\//i.test(String(p).replace(/\\/g, '/')));
}

export function detectDiagnostics(
  workspaceRoot: string,
  opts?: { focusPaths?: string[] },
): DetectedDiagnostic {
  const root = normalizeWorkspacePath(workspaceRoot);

  // Root MY Agent tsconfig only includes core/src — UI duplicates never fail that tsc.
  // When the agent mutated ui/workspace/src, point diagnostics at workspace tsc -b.
  if (
    pathsFocusWorkspaceUiSrc(opts?.focusPaths)
    && existsSync(path.join(root, 'ui', 'workspace', 'tsconfig.json'))
  ) {
    return {
      kind: 'tsc',
      command: 'npm --prefix ui/workspace exec -- tsc -b --pretty false',
      reason: 'ui/workspace/src mutated — workspace tsc -b (root tsconfig is core-only)',
    };
  }

  if (existsSync(path.join(root, 'tsconfig.json')) && hasLocalBin(root, 'tsc')) {
    return {
      kind: 'tsc',
      command: 'npx tsc --noEmit -p tsconfig.json',
      reason: 'tsconfig.json + local tsc',
    };
  }

  if (hasLocalBin(root, 'oxlint') || existsSync(path.join(root, '.oxlintrc.json'))) {
    return {
      kind: 'oxlint',
      command: 'npx oxlint .',
      reason: 'oxlint available',
    };
  }

  if (
    hasLocalBin(root, 'eslint')
    || existsSync(path.join(root, 'eslint.config.js'))
    || existsSync(path.join(root, 'eslint.config.mjs'))
    || existsSync(path.join(root, '.eslintrc.js'))
    || existsSync(path.join(root, '.eslintrc.cjs'))
    || existsSync(path.join(root, '.eslintrc.json'))
  ) {
    return {
      kind: 'eslint',
      command: 'npx eslint . --max-warnings=0',
      reason: 'eslint config or local binary',
    };
  }

  if (
    hasLocalBin(root, 'ruff')
    || existsSync(path.join(root, 'ruff.toml'))
    || existsSync(path.join(root, 'pyproject.toml'))
  ) {
    try {
      if (existsSync(path.join(root, 'pyproject.toml'))) {
        const py = readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
        if (/\[tool\.ruff/.test(py) || hasLocalBin(root, 'ruff')) {
          return { kind: 'ruff', command: 'ruff check .', reason: 'ruff config' };
        }
      } else if (hasLocalBin(root, 'ruff') || existsSync(path.join(root, 'ruff.toml'))) {
        return { kind: 'ruff', command: 'ruff check .', reason: 'ruff available' };
      }
    } catch {
      /* fall through */
    }
  }

  if (hasLocalBin(root, 'pyright') || existsSync(path.join(root, 'pyrightconfig.json'))) {
    return {
      kind: 'pyright',
      command: 'npx pyright',
      reason: 'pyright available',
    };
  }

  // Fallback: root package may only have typescript via parent (MY Agent monorepo style)
  if (existsSync(path.join(root, 'tsconfig.json'))) {
    return {
      kind: 'tsc',
      command: 'npx tsc --noEmit -p tsconfig.json',
      reason: 'tsconfig.json (npx tsc)',
    };
  }

  const npmQuality = detectNpmQualityScript(root);
  if (npmQuality) return npmQuality;

  return {
    kind: 'none',
    command: null,
    reason: 'no known diagnostics (tsc / eslint / oxlint / ruff / pyright / npm quality script)',
  };
}

function jsPathsForSyntaxCheck(workspaceRoot: string, changedPaths?: string[]): string[] {
  const root = normalizeWorkspacePath(workspaceRoot);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of changedPaths ?? []) {
    const rel = raw.trim().replace(/\\/g, '/');
    if (!JS_EXT_RE.test(rel)) continue;
    const abs = path.isAbsolute(raw) || raw.startsWith('\\\\')
      ? normalizeWorkspacePath(raw)
      : path.resolve(root, raw);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 10) break;
  }
  return out;
}

function runNodeSyntaxChecks(
  workspaceRoot: string,
  files: string[],
  timeoutMs: number,
): RunTerminalResult {
  const cwd = normalizeWorkspacePath(workspaceRoot);
  const outputs: string[] = [];
  let ok = true;
  for (const file of files) {
    const proc = spawnSync(process.execPath, ['--check', file], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      shell: false,
      env: process.env,
    });
    const timedOut = proc.error?.message?.includes('ETIMEDOUT') ?? false;
    const exitCode = proc.status ?? (proc.error ? 1 : 0);
    const chunk = [proc.stdout ?? '', proc.stderr ?? '', proc.error?.message ?? '']
      .filter(Boolean)
      .join('\n')
      .trim();
    if (exitCode !== 0 || timedOut || proc.error) {
      ok = false;
      outputs.push(`FAIL ${file}\n${chunk || `exit ${exitCode}`}`);
    } else {
      outputs.push(`OK ${file}`);
    }
  }
  return {
    ok,
    exit_code: ok ? 0 : 1,
    stdout: outputs.join('\n\n'),
    stderr: '',
    truncated: false,
    command: `node --check (${files.length} file(s))`,
    cwd,
  };
}

export function runWorkspaceDiagnostics(
  workspaceRoot: string,
  opts?: { command?: string; timeoutMs?: number; changedPaths?: string[] },
): string {
  const detected = detectDiagnostics(workspaceRoot, { focusPaths: opts?.changedPaths });
  const override = opts?.command?.trim();
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const jsFiles = jsPathsForSyntaxCheck(workspaceRoot, opts?.changedPaths);

  if (!override && detected.kind === 'none' && jsFiles.length) {
    const result = runNodeSyntaxChecks(workspaceRoot, jsFiles, Math.min(timeoutMs, 60_000));
    const { text: output, truncated } = truncate(result.stdout || '(no output)');
    return JSON.stringify(
      {
        ok: result.ok,
        weak: true,
        skipped: false,
        status: result.ok ? 'weak_pass' : 'fail',
        exit_code: result.exit_code,
        detected: {
          kind: 'node_syntax',
          command: result.command,
          reason: 'no project linter; node --check on changed JS',
        },
        command: result.command,
        output,
        truncated,
        cwd: result.cwd,
        message: result.ok
          ? 'weak_pass: node --check only — not full project diagnostics.'
          : undefined,
      },
      null,
      2,
    );
  }

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
          'No diagnostics runner detected — skipped ≠ pass / noop ≠ healthy. Treat as weak evidence only; never claim typecheck green.',
      },
      null,
      2,
    );
  }

  let result: RunTerminalResult;

  if (!override && detected.kind === 'tsc') {
    // Always honor detected.command (may be ui/workspace tsc -b, not root core-only).
    result = runTerminalCommand(workspaceRoot, command, { timeoutMs });
  } else if (!override && detected.kind === 'oxlint') {
    if (process.platform === 'win32') {
      result = runTerminalCommand(workspaceRoot, command, { timeoutMs });
    } else {
      result = runArgv(workspaceRoot, 'npx', ['oxlint', '.'], timeoutMs);
    }
  } else if (!override && detected.kind === 'eslint') {
    if (process.platform === 'win32') {
      result = runTerminalCommand(workspaceRoot, command, { timeoutMs });
    } else {
      result = runArgv(workspaceRoot, 'npx', ['eslint', '.', '--max-warnings=0'], timeoutMs);
    }
  } else if (!override && detected.kind === 'ruff') {
    result = runArgv(workspaceRoot, 'ruff', ['check', '.'], timeoutMs);
  } else if (!override && detected.kind === 'pyright') {
    if (process.platform === 'win32') {
      result = runTerminalCommand(workspaceRoot, command, { timeoutMs });
    } else {
      result = runArgv(workspaceRoot, 'npx', ['pyright'], timeoutMs);
    }
  } else if (!override && detected.kind === 'npm_script' && command.startsWith('npm run ')) {
    const script = command.slice('npm run '.length).trim();
    if (process.platform === 'win32') {
      result = runTerminalCommand(workspaceRoot, `npm run ${script}`, { timeoutMs });
    } else {
      result = runArgv(workspaceRoot, 'npm', ['run', script], timeoutMs);
    }
  } else {
    result = runTerminalCommand(workspaceRoot, command, { timeoutMs });
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
