/**
 * Autopilot mode — continue investigate→mutate→verify in one run
 * without stopping on 「다음 조치」.
 * Global `MY_AGENT_AUTOPILOT` stays default off (safe). Code-session IDE mutates and
 * UI-feature tasks opt into continuous run via CODE/UI autopilot (default on).
 */
import { envFlagOn } from '../providers/harness-policy.js';
export {
  AUTOPILOT_CONTINUE_LOOSE_RE,
  AUTOPILOT_CONTINUE_RE,
  looksLikeAutopilotContinue,
} from './agent-autopilot-intent.js';

export type ResolveAutopilotOpts = {
  /** Folder/project coding turn (ADR-006 codeSession). */
  codeSession?: boolean;
};

/**
 * Effective autopilot:
 * - user override wins when boolean (Manager `agent_autopilot`)
 * - else MY_AGENT_AUTOPILOT (default off — all tasks)
 * - otherwise off; the selected execution policy owns Autopilot
 *
 * Message wording does not enable or disable Autopilot. Mutation permission remains owned by
 * The selected execution policy owns mutation approval; message wording is not a policy input.
 */
export function resolveAutopilotEnabled(
  env: NodeJS.ProcessEnv = process.env,
  userOverride?: boolean | null,
  _userMessage?: string | null,
  _opts?: ResolveAutopilotOpts | null,
): boolean {
  if (userOverride === true) return true;
  if (userOverride === false) return false;
  if (envFlagOn(env.MY_AGENT_AUTOPILOT, false)) return true;
  return false;
}

/**
 * OR-in continuous run only when the user explicitly asks to continue.
 * Respects Manager hard-off (`optsAutopilot === false`) and `MY_AGENT_CODE_AUTOPILOT=0`.
 */
export function shouldOrInContinuityAutopilot(opts: {
  currentlyEnabled: boolean;
  sessionContinuity: boolean;
  /** Explicit Manager / caller lock; `undefined` = heuristic miss (may OR-in). */
  optsAutopilot?: boolean | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (opts.currentlyEnabled) return true;
  if (opts.optsAutopilot === false) return false;
  if (!opts.sessionContinuity) return false;
  return envFlagOn((opts.env ?? process.env).MY_AGENT_CODE_AUTOPILOT, true);
}

export function formatAutopilotSystemNote(): string {
  return [
    '## Autopilot ON',
    'Finish in THIS run — no 「다음 조치」 pause. discover→mutate→verify→repair, then answer in the model-chosen form.',
    'Honor do-not-touch constraints and the latest user request. No invented URLs.',
  ].join('\n');
}

export function autopilotMaxSteps(base: number, enabled: boolean): number {
  if (!enabled) return base;
  return Math.min(60, Math.max(base, base + 15));
}
