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

export interface ModelReasoningCapability {
  supported_efforts: ReasoningEffortLevel[];
  /** `app_resolved`: UI auto is converted to a concrete wire effort by Core. */
  auto_behavior: 'app_resolved' | 'omit';
  source: 'family' | 'fallback';
}

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
 * Direct agent calls without a session policy use this compatibility fallback.
 * Session/UI `auto` is resolved by the general capability policy below.
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
  // Unknown/new remote models must not be silently reduced to three choices.
  // Core exposes this fallback as low-confidence capability metadata and keeps
  // `auto` safe by resolving it to one concrete value before the provider call.
  return [...REASONING_EFFORT_LEVELS];
}

/** Single Core-owned capability contract consumed by both execution and the picker UI. */
export function modelReasoningCapability(modelId?: string | null): ModelReasoningCapability {
  const supported = modelSupportedReasoningLevels(modelId);
  return {
    supported_efforts: supported,
    auto_behavior: supported.length ? 'app_resolved' : 'omit',
    source: isKnownReasoningFamily(modelId) ? 'family' : 'fallback',
  };
}

function isKnownReasoningFamily(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  return /deepseek|perplexity|sonar|grok|claude|anthropic|fable|mythos|opus|sonnet|gpt-5|\bo[1-4](?:[-_.]|$)|codex|\bgpt[-_. ](?![34]\b|[34][-_.]|4o\b)/.test(m);
}

/** Resolve UI `auto` to one concrete, model-supported wire effort. */
export function resolveAutomaticReasoningEffort(
  userMessage: string | null | undefined,
  supported: readonly ReasoningEffortLevel[],
): ReasoningEffortLevel | null {
  if (!supported.length) return null;
  const text = String(userMessage ?? '').trim();
  const complex = /(?:아키텍처|설계|리팩터|마이그레이션|원인\s*분석|디버깅|회귀|성능|보안|여러\s*파일|전체|복잡|architecture|refactor|migration|debug|regression|performance|security|multi[- ]file)/i.test(text);
  const simple = text.length < 120
    && /(?:번역|요약|설명|뜻|인사|간단|한\s*줄|translate|summari[sz]e|explain|hello|brief)/i.test(text);
  const requested: ReasoningEffortLevel = complex || text.length >= 700
    ? 'high'
    : simple
      ? 'low'
      : 'medium';
  return clampReasoningEffortToSupported(requested, supported);
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
