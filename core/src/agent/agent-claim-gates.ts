/**
 * Verify witness type shared by the step loop and continuation snapshot.
 * Prose-classifying claim gates (overclaim / deferral / framing regexes) were removed:
 * the runtime does not judge the meaning of model or user text.
 */

export type VerifyWitness = {
  kind: 'diagnostics' | 'tests' | 'terminal';
  ok: boolean;
  atStep: number;
  command?: string;
  /** Present when known (0 = success). */
  exitCode?: number;
};
