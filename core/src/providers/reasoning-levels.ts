/**
 * Product reasoning ladder (UI Korean labels elsewhere).
 * Wire values match provider enums; `none` is not a product level.
 *
 * Supported levels are inferred from model *families*, not per-model counts,
 * so new GPT aliases inherit the full ladder without a hand-maintained list.
 */

export const REASONING_EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

export type ReasoningLevelWire = 'auto' | ReasoningEffortLevel;

export const REASONING_LEVEL_SET = new Set<string>(['auto', ...REASONING_EFFORT_LEVELS]);

export function isReasoningLevel(value: unknown): value is ReasoningLevelWire {
  return typeof value === 'string' && REASONING_LEVEL_SET.has(value);
}

/** Image models: no effort field. */
export function modelOmitsReasoningEffort(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  return /gemini-3-pro-image|gemini.*-image|[-_/]image(?:-|$)|image-gen|imagen/i.test(m);
}

/**
 * Gateways that reject omitted reasoning ("Reasoning is mandatory").
 * UI must not offer `auto`; wire layer substitutes the least intrusive budget.
 */
export function modelRequiresExplicitReasoningEffort(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  return /\bgpt[-_. ]?astra\b/.test(m);
}

/** Default explicit budget when auto is unavailable for the model. */
export function defaultExplicitReasoningEffort(modelId?: string | null): ReasoningEffortLevel {
  const supported = modelSupportedReasoningLevels(modelId);
  if (supported.includes('low')) return 'low';
  return supported[0] ?? 'low';
}

/**
 * OpenAI-style reasoning models → full product ladder.
 * Catches gpt-5*, o-series, codex, and gpt-<alias> names (astra/sol/luna/…)
 * without excluding classic gpt-3 / gpt-4 / gpt-4o chat models.
 */
export function isFullReasoningLadderModel(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  if (/deepseek|perplexity|sonar|grok|claude|anthropic|fable|mythos/.test(m)) return false;
  if (/gpt-5|\bo[1-4](?:[-_.]|$)|codex/.test(m)) return true;
  // gpt-<alias> (letter-led), not gpt-3 / gpt-4 / gpt-4o
  if (/\bgpt[-_. ](?![34]\b|[34][-_.]|4o\b)/.test(m)) return true;
  return false;
}

/**
 * Supported effort values for the selected model (excluding auto).
 * Empty array = omit effort (same as reject/image / unsupported Claude).
 */
export function modelSupportedReasoningLevels(modelId?: string | null): ReasoningEffortLevel[] {
  const m = String(modelId || '').toLowerCase();
  if (!m || modelOmitsReasoningEffort(m)) return [];

  if (/deepseek/.test(m)) return ['low', 'high', 'max'];
  if (/sonar-deep-research|perplexity/.test(m)) return ['low', 'medium', 'high'];
  if (/grok/.test(m)) return ['low', 'medium', 'high', 'xhigh'];
  if (/claude|anthropic|fable|mythos|opus|sonnet/.test(m)) {
    if (/(?:opus-(?:4[-_.](?:5|6|7|8)|5)|sonnet-(?:4[-_.]6|5)|fable|mythos)/.test(m)) {
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    }
    return [];
  }
  if (isFullReasoningLadderModel(m)) {
    return [...REASONING_EFFORT_LEVELS];
  }
  return ['low', 'medium', 'high'];
}

export function clampReasoningEffortToSupported(
  requested: string,
  supported: readonly ReasoningEffortLevel[],
): ReasoningEffortLevel | null {
  if (!supported.length) return null;
  if ((supported as readonly string[]).includes(requested)) {
    return requested as ReasoningEffortLevel;
  }
  if (requested === 'medium' && supported.includes('high')) return 'high';
  if (requested === 'xhigh' && !supported.includes('xhigh') && supported.includes('max')) {
    return 'max';
  }
  if (requested === 'max' && !supported.includes('max') && supported.includes('xhigh')) {
    return 'xhigh';
  }
  if (requested === 'minimal' && !supported.includes('minimal') && supported.includes('low')) {
    return 'low';
  }

  const order = REASONING_EFFORT_LEVELS as readonly string[];
  const idx = order.indexOf(requested);
  if (idx < 0) {
    return supported.includes('high') ? 'high' : supported[supported.length - 1]!;
  }
  for (let d = 1; d < order.length; d += 1) {
    const lo = order[idx - d];
    const hi = order[idx + d];
    if (lo && (supported as readonly string[]).includes(lo)) return lo as ReasoningEffortLevel;
    if (hi && (supported as readonly string[]).includes(hi)) return hi as ReasoningEffortLevel;
  }
  return supported[supported.length - 1]!;
}
