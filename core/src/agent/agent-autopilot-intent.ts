/**
 * Dependency-light recognition for short Autopilot continuation turns.
 *
 * Keep this separate from agent-autopilot.ts: work-mode and review follow-up
 * classification need these predicates, while Autopilot runtime depends on
 * run helpers that themselves depend on work-mode.
 */
export const AUTOPILOT_CONTINUE_RE =
  /^(?:다음\s*(?:조치|단계|액션).{0,12}실행|니가\s*알아서(?:\s*해)?|알아서\s*(?:다음|계속|진행)|계속\s*(?:진행|실행|해)|이어서(?:\s*(?:해|진행|실행))?|쭉\s*진행|오토\s*파일럿|autopilot)\s*[.!]?\s*$/i;

export const AUTOPILOT_CONTINUE_LOOSE_RE =
  /(?:다음\s*(?:조치|단계).{0,16}실행|니가\s*알아서\s*다음|알아서\s*이어서|continue\s*(?:the\s*)?(?:next|work)|keep\s*going)/i;

/** Short “do the next step yourself” after a plan/partial report. */
export function looksLikeAutopilotContinue(message: string): boolean {
  const t = String(message || '').trim();
  if (!t) return false;
  if (t.length <= 80) {
    return AUTOPILOT_CONTINUE_RE.test(t) || AUTOPILOT_CONTINUE_LOOSE_RE.test(t);
  }
  return AUTOPILOT_CONTINUE_LOOSE_RE.test(t) && t.length < 200;
}
