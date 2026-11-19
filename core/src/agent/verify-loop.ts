/**
 * Verify helpers: mutating-tool set, verification witness recording and
 * parsing of run_diagnostics / run_tests JSON results.
 */

import type { VerifyWitness } from './agent-claim-gates.js';

const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  // Local product plane: installing/toggling plugins writes data/agent-plugins on cqrRoot
  'plugin_install',
  'plugin_set_enabled',
  // Git repository state is a disk mutation even when no working-tree file path changes.
  'git_init',
  'git_stage',
  'git_commit',
]);

export function isMutatingAgentTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

export type { VerifyWitness };

/** Build a pass/fail witness from parseVerifyJson + step. weak/skipped ⇒ ok:false (≠ strong). */
export function buildVerifyWitness(opts: {
  kind: VerifyWitness['kind'];
  diag: { ok: boolean; skipped?: boolean; weak?: boolean; command?: string } | null;
  atStep: number;
}): VerifyWitness | null {
  if (!opts.diag || typeof opts.diag.ok !== 'boolean') return null;
  if (opts.diag.skipped || opts.diag.weak) {
    return {
      kind: opts.kind,
      ok: false,
      atStep: opts.atStep,
      command: opts.diag.command,
      exitCode: opts.diag.skipped ? undefined : opts.diag.ok ? 0 : 1,
    };
  }
  return {
    kind: opts.kind,
    ok: opts.diag.ok === true,
    atStep: opts.atStep,
    command: opts.diag.command,
    exitCode: opts.diag.ok ? 0 : 1,
  };
}

type VerifyWitnessSink = {
  verifyWitness: VerifyWitness | null;
  ranVerifyCommand: boolean;
};

/** Record a verification result as durable step evidence. */
export function recordVerifyWitness(
  state: VerifyWitnessSink,
  opts: {
    kind: VerifyWitness['kind'];
    diag: { ok: boolean; skipped?: boolean; weak?: boolean; command?: string } | null;
    atStep: number;
  },
): VerifyWitness | null {
  const w = buildVerifyWitness(opts);
  if (w) state.verifyWitness = w;
  state.ranVerifyCommand = true;
  return w;
}

export function parseVerifyJson(output: string): {
  ok: boolean;
  skipped?: boolean;
  weak?: boolean;
  output?: string;
  command?: string;
} | null {
  try {
    const doc = JSON.parse(output) as {
      ok?: boolean;
      skipped?: boolean;
      weak?: boolean;
      output?: string;
      command?: string;
    };
    if (typeof doc.ok !== 'boolean') return null;
    return {
      ok: doc.ok,
      skipped: doc.skipped === true,
      weak: doc.weak === true,
      output: typeof doc.output === 'string' ? doc.output : undefined,
      command: typeof doc.command === 'string' ? doc.command : undefined,
    };
  } catch {
    return null;
  }
}

/** Max silent self-fix cycles per agent run (env override). */
export function maxSilentVerifyRetries(): number {
  const raw = process.env.MY_AGENT_VERIFY_MAX_RETRIES;
  if (!raw) return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(5, Math.floor(n)) : 2;
}
