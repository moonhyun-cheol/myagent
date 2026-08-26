/**
 * Shared harness knobs for chat + code-agent (OWUI IQ redesign).
 * Env-only; no secrets. Defaults: reasoning high, history 40, MAR light, code OWUI native tools.
 */

export type OwuiProtocolMode = 'text' | 'probe' | 'api';

export interface HarnessPolicy {
  /** OpenAI-style reasoning_effort; null = omit from wire. */
  reasoningEffort: string | null;
  historyTurns: number;
  historyAssistantMaxChars: number;
  /** Keep this many newest user/assistant turns verbatim when compressing. */
  historyKeepRecent: number;
  /** Trigger deterministic history compress when total history chars exceed this. */
  historyCompressChars: number;
  /** Skip mandatory Critic on simple single-coder mutates. */
  marLight: boolean;
  /** Global continuous runs (MY_AGENT_AUTOPILOT). Default off; CODE/UI task heuristics are separate. */
  autopilot: boolean;
  /** OWUI / custom tool protocol strategy. */
  owuiProtocol: OwuiProtocolMode;
  owuiProbeTimeoutMs: number;
  toolResultMaxChars: number;
}

function envFlagOn(raw: string | undefined, defaultOn: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultOn;
  const v = raw.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  return defaultOn;
}

export { envFlagOn };

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Resolve reasoning_effort for general chat wire. `0`/`off`/`none` → omit. */
export function resolveReasoningEffort(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.MY_AGENT_REASONING_EFFORT ?? 'high').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off' || raw === 'none' || raw === 'false') return null;
  return raw;
}

/**
 * Code-agent reasoning tier. Short, bounded tasks use `low`; complex work uses
 * `medium`. Explicit MY_AGENT_REASONING_EFFORT always wins.
 */
export function resolveCodeReasoningEffort(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { simpleEdit?: boolean; simpleTask?: boolean },
): string | null {
  const explicit = (env.MY_AGENT_REASONING_EFFORT ?? '').trim();
  if (explicit) return resolveReasoningEffort(env);
  return opts?.simpleTask === true || opts?.simpleEdit === true ? 'low' : 'medium';
}

/**
 * Provider/model-aware code effort. Pro-labelled endpoints own their reasoning
 * budget unless an operator explicitly overrides it; forcing `low`/`medium`
 * can be unsupported and hides the true cost policy of that endpoint.
 */
export function resolveCodeReasoningEffortForModel(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { modelId?: string | null; simpleEdit?: boolean; simpleTask?: boolean },
): string | null {
  const explicit = (env.MY_AGENT_REASONING_EFFORT ?? '').trim();
  if (!explicit && /(?:^|[-_.:/])pro(?:$|[-_.:/])/i.test(String(opts?.modelId ?? ''))) {
    return null;
  }
  return resolveCodeReasoningEffort(env, opts);
}

/**
 * Models that error when reasoning_effort/thinking is sent (e.g. Ollama qwen2.5:7b).
 * Thinking-capable names are allowlisted.
 */
export function modelRejectsReasoningEffort(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  if (/thinking|reasoner|\br1\b|o1|o3|o4|gpt-5|opus-4|sonnet-4|gemini-2\.5|gemini-3/i.test(m)) {
    return false;
  }
  return /qwen2\.5(?!.*thinking)|qwen2:|llama3|llama-3|mistral|phi-?3|gemma|codellama|deepseek-coder|yi-|tinyllama/i.test(
    m,
  );
}

/** Default `text` for OWUI (non-code / hang-avoidance baseline). Use `probe`/`api` to opt in. */
export function resolveOwuiProtocolMode(env: NodeJS.ProcessEnv = process.env): OwuiProtocolMode {
  if (envFlagOn(env.MY_AGENT_OWUI_TEXT_TOOLS, false)) return 'text';
  const raw = (env.MY_AGENT_OWUI_PROTOCOL ?? 'text').trim().toLowerCase();
  if (raw === 'probe' || raw === 'api' || raw === 'text') return raw;
  return 'text';
}

/**
 * Code-agent OWUI protocol (ADR-006 + native reliability).
 * Default **`api`**: Responses/native tools. TEXT flags apply only before the
 * provider transport contract is known; Responses/Messages override them.
 */
export function resolveCodeOwuiProtocolMode(env: NodeJS.ProcessEnv = process.env): OwuiProtocolMode {
  if (envFlagOn(env.MY_AGENT_OWUI_TEXT_TOOLS, false)) return 'text';
  // Explicit disable native for code (Safe).
  if (!envFlagOn(env.MY_AGENT_CODE_ALLOW_OWUI_NATIVE_TOOLS, true)) return 'text';
  const codeRaw = (env.MY_AGENT_CODE_OWUI_PROTOCOL ?? 'api').trim().toLowerCase();
  if (codeRaw === 'probe' || codeRaw === 'api' || codeRaw === 'text') return codeRaw;
  return 'text';
}

export function loadHarnessPolicy(env: NodeJS.ProcessEnv = process.env): HarnessPolicy {
  return {
    reasoningEffort: resolveReasoningEffort(env),
    historyTurns: parsePositiveInt(env.MY_AGENT_HISTORY_TURNS, 40, 8, 80),
    historyAssistantMaxChars: parsePositiveInt(env.MY_AGENT_HISTORY_ASSISTANT_MAX_CHARS, 4000, 500, 20_000),
    historyKeepRecent: parsePositiveInt(env.MY_AGENT_HISTORY_KEEP_RECENT, 6, 2, 40),
    historyCompressChars: parsePositiveInt(env.MY_AGENT_HISTORY_COMPRESS_CHARS, 24_000, 500, 200_000),
    marLight: envFlagOn(env.MY_AGENT_MAR_LIGHT, true),
    autopilot: envFlagOn(env.MY_AGENT_AUTOPILOT, false),
    owuiProtocol: resolveOwuiProtocolMode(env),
    owuiProbeTimeoutMs: parsePositiveInt(env.MY_AGENT_OWUI_PROBE_TIMEOUT_MS, 25_000, 8_000, 180_000),
    toolResultMaxChars: parsePositiveInt(env.MY_AGENT_TOOL_RESULT_MAX_CHARS, 48_000, 8_000, 120_000),
  };
}

export function resolveSessionReasoningEffort(
  requested: 'auto' | 'low' | 'medium' | 'high',
  env: NodeJS.ProcessEnv = process.env,
  opts?: { providerId?: string | null; modelId?: string | null; forCodeAgent?: boolean; simpleEdit?: boolean; simpleTask?: boolean },
): string | null {
  if (modelRejectsReasoningEffort(opts?.modelId)) return null;
  const model = String(opts?.modelId ?? '').toLowerCase();
  if (
    (opts?.providerId === 'anthropic' || /claude/.test(model))
    && !/(?:opus-(?:4[-_.](?:5|6|7|8)|5)|sonnet-(?:4[-_.]6|5)|fable-5|mythos)/.test(model)
  ) {
    return null;
  }
  if ((env.MY_AGENT_REASONING_EFFORT ?? '').trim()) {
    return opts?.forCodeAgent
      ? resolveCodeReasoningEffortForModel(env, opts)
      : resolveReasoningEffort(env);
  }
  if (requested !== 'auto') return requested;
  return opts?.forCodeAgent
    ? resolveCodeReasoningEffortForModel(env, opts)
    : resolveReasoningEffort(env);
}

/** Fields to merge into ChatCompletionOptions for every LLM call. */
export function harnessCompletionExtras(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { providerId?: string; modelId?: string | null; simpleEdit?: boolean; simpleTask?: boolean; forCodeAgent?: boolean },
): { reasoningEffort?: string; extraBody?: Record<string, unknown> } {
  const effort =
    opts?.forCodeAgent === true
      ? resolveCodeReasoningEffortForModel(env, {
          modelId: opts.modelId,
          simpleEdit: opts.simpleEdit === true,
          simpleTask: opts.simpleTask === true,
        })
      : resolveReasoningEffort(env);
  if (!effort) return {};
  if (opts?.providerId === 'ollama') return {};
  if (modelRejectsReasoningEffort(opts?.modelId)) return {};
  return { reasoningEffort: effort };
}

/**
 * Code agent may use Ollama only when `local_only` or `MY_AGENT_ALLOW_OLLAMA_CODE=1`.
 * Default off — NAS Ollama is too weak for multi-file mutate (TEXT TOOL_CALL loops).
 */
export function ollamaAllowedForCodeAgent(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { localOnly?: boolean },
): boolean {
  if (opts?.localOnly === true) return true;
  return envFlagOn(env.MY_AGENT_ALLOW_OLLAMA_CODE, false);
}

/**
 * PLAN approval handshake for coding turns (code chip / folder session).
 * Default off: enterprise-sounding wording (「전체」/「전면」) alone must not force a
 * 「진행」 reply every question. Explicit 「계획 먼저」 and mutate-forbid still lock.
 * Restore the old lock: `MY_AGENT_CODE_PLAN_LOCK=1`.
 */
export function codingPlanLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env.MY_AGENT_CODE_PLAN_LOCK, false);
}

/**
 * Silent OWUI/gateway → Ollama fallback for chat + code-agent. Default off.
 * Opt in: `MY_AGENT_OLLAMA_FALLBACK=1`.
 */
export function ollamaEmergencyFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env.MY_AGENT_OLLAMA_FALLBACK, false);
}

/**
 * Soft requests-per-minute budget (warn only — never hard-kills a run).
 * Unset / 0 = disabled.
 */
export function softRpmLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = parsePositiveInt(env.MY_AGENT_SOFT_RPM, 0, 0, 10_000);
  return n > 0 ? n : null;
}

/** Soft wall-ms warn threshold for a single agent/chat step (default 120s). */
export function softStepLatencyWarnMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.MY_AGENT_SOFT_STEP_LATENCY_MS, 120_000, 5_000, 600_000);
}

/**
 * Whether OWUI/custom should start on TEXT TOOL_CALL (client protocol).
 * Ollama/local always TEXT. Sticky failures are handled separately.
 * @param forCodeAgent when true, use code OWUI protocol (default api → native tools).
 */
export function owuiPrefersClientToolProtocol(
  providerId: string,
  def: { custom?: boolean; local_only_ok?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  forCodeAgent = false,
): boolean {
  if (providerId === 'ollama' || def.local_only_ok === true) return true;
  const isOwui = providerId === 'custom' || def.custom === true;
  if (!isOwui) return false;
  const mode = forCodeAgent ? resolveCodeOwuiProtocolMode(env) : resolveOwuiProtocolMode(env);
  return mode === 'text';
}
