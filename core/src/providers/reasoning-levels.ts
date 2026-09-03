/**
 * Product reasoning ladder (UI Korean labels elsewhere).
 * Wire values match provider enums; `none` is not a product level.
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
  if (/gpt-5|o1|o3|o4|codex/.test(m)) {
    return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
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
