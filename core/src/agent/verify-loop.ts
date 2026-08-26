/**
 * Autonomous verify loop helpers: after mutating edits, run diagnostics/tests
 * and format a model-only repair prompt (not shown as final user answer).
 *
 * Verification witness notes live in `agent-claim-gates.ts` (formatVerificationWitnessNote).
 */

import type { VerifyWitness } from './agent-claim-gates.js';
import { formatVerificationWitnessNote } from './agent-claim-gates.js';

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
export { formatVerificationWitnessNote };

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

/** Exhausted silent retries — fail witness so done claims cannot slip through. */
export function exhaustVerifyWitness(atStep: number): VerifyWitness {
  return {
    kind: 'diagnostics',
    ok: false,
    atStep,
    exitCode: 1,
    command: 'silent-verify-exhausted',
  };
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

/**
 * Instructions injected into the tool/message stream so the model fixes
 * diagnostics without presenting the raw failure as the final user reply yet.
 */
export function formatSilentVerifyRepairPrompt(
  kind: 'diagnostics' | 'tests' | 'syntax',
  payload: {
    command?: string;
    output?: string;
    attempt: number;
    maxAttempts: number;
    mutatedPaths?: string[];
  },
): string {
  const out = (payload.output ?? '').trim().slice(0, 12_000);
  const paths = (payload.mutatedPaths ?? []).filter(Boolean).slice(0, 12);
  const primaryPath = paths[0];
  const nextCall = primaryPath
    ? `TOOL_CALL: ${JSON.stringify({ name: 'read_file', arguments: { path: primaryPath } })}`
    : 'TOOL_CALL: {"name":"run_diagnostics","arguments":{}}';
  const gate =
    kind === 'syntax'
      ? 'fix SYNTAX_BROKEN so node --check / JSON.parse pass'
      : `fix ${kind} to exit 0 (edit → re-verify)`;
  return [
    `INTERNAL_VERIFY_FAILED kind=${kind} attempt=${payload.attempt}/${payload.maxAttempts}`,
    payload.command ? `command: ${payload.command}` : null,
    paths.length ? `mutated: ${paths.join(', ')}` : null,
    `EXIT_GATE (close this one only): ${gate}`,
    'Do NOT apologize. Do NOT claim success. First line = TOOL_CALL.',
    nextCall,
    kind === 'syntax'
      ? 'Then edit_file/apply_patch (syntax gate re-runs automatically on mutate).'
      : 'Then edit_file/apply_patch if needed, then run_diagnostics (and run_tests if present).',
    '',
    '--- verifier output ---',
    out || '(no output)',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
