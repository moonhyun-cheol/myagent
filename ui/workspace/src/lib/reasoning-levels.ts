/** Product reasoning ladder — Korean UI labels; wire enums match providers. */

export const REASONING_EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

export const REASONING_LEVEL_LABELS: Record<'auto' | ReasoningEffortLevel, string> = {
  auto: '자동',
  minimal: '최소',
  low: '낮음',
  medium: '중간',
  high: '높음',
  xhigh: '매우 높음',
  max: '최고',
};

export function reasoningLevelLabel(value: string | null | undefined): string {
  if (!value) return '모델 관리';
  if (value in REASONING_LEVEL_LABELS) {
    return REASONING_LEVEL_LABELS[value as keyof typeof REASONING_LEVEL_LABELS];
  }
  return value;
}

export function modelOmitsReasoningEffort(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  return /gemini-3-pro-image|gemini.*-image|[-_/]image(?:-|$)|image-gen|imagen/i.test(m);
}

/**
 * Gateways that reject omitted reasoning ("Reasoning is mandatory").
 * Hide `자동` in the picker and persist an explicit default instead.
 */
export function modelRequiresExplicitReasoningEffort(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  return /\bgpt[-_. ]?astra\b/.test(m);
}

function defaultExplicitReasoningEffort(modelId?: string | null): ReasoningEffortLevel {
  const supported = modelSupportedReasoningLevels(modelId);
  if (supported.includes('low')) return 'low';
  return supported[0] ?? 'low';
}

/**
 * OpenAI-style reasoning models → full product ladder.
 * New gpt-<alias> names inherit detail without a per-model level count.
 */
function isFullReasoningLadderModel(modelId?: string | null): boolean {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  if (/deepseek|perplexity|sonar|grok|claude|anthropic|fable|mythos/.test(m)) return false;
  if (/gpt-5|\bo[1-4](?:[-_.]|$)|codex/.test(m)) return true;
  if (/\bgpt[-_. ](?![34]\b|[34][-_.]|4o\b)/.test(m)) return true;
  return false;
}

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

/** Keep persisted chat policy valid when the selected model family changes. */
export function normalizeReasoningLevelForModel(
  value: 'auto' | ReasoningEffortLevel,
  modelId?: string | null,
): 'auto' | ReasoningEffortLevel {
  if (value === 'auto') {
    return modelRequiresExplicitReasoningEffort(modelId)
      ? defaultExplicitReasoningEffort(modelId)
      : 'auto';
  }
  const supported = modelSupportedReasoningLevels(modelId);
  if (!supported.length) {
    return modelRequiresExplicitReasoningEffort(modelId)
      ? defaultExplicitReasoningEffort(modelId)
      : 'auto';
  }
  if (supported.includes(value)) return value;
  const requestedIndex = REASONING_EFFORT_LEVELS.indexOf(value);
  return supported.reduce<ReasoningEffortLevel>((best, candidate) => {
    const candidateIndex = REASONING_EFFORT_LEVELS.indexOf(candidate);
    const bestIndex = REASONING_EFFORT_LEVELS.indexOf(best);
    const candidateDistance = Math.abs(candidateIndex - requestedIndex);
    const bestDistance = Math.abs(bestIndex - requestedIndex);
    return candidateDistance < bestDistance || (candidateDistance === bestDistance && candidateIndex > bestIndex)
      ? candidate
      : best;
  }, supported[0]!);
}

/** Full product ladder for Settings (no model context). */
export const ALL_REASONING_SELECT_OPTIONS: Array<{ value: 'auto' | ReasoningEffortLevel; label: string }> = [
  { value: 'auto', label: REASONING_LEVEL_LABELS.auto },
  ...REASONING_EFFORT_LEVELS.map((value) => ({ value, label: REASONING_LEVEL_LABELS[value] })),
];

export function reasoningSelectOptionsForModel(
  modelId?: string | null,
  opts?: { imageMode?: boolean },
): Array<{ value: 'auto' | ReasoningEffortLevel; label: string }> {
  if (opts?.imageMode || modelOmitsReasoningEffort(modelId)) {
    return [{ value: 'auto', label: REASONING_LEVEL_LABELS.auto }];
  }
  const supported = modelSupportedReasoningLevels(modelId);
  if (!supported.length && modelId) {
    return [{ value: 'auto', label: REASONING_LEVEL_LABELS.auto }];
  }
  const levels = supported.length ? supported : [...REASONING_EFFORT_LEVELS];
  const options = levels.map((value) => ({ value, label: REASONING_LEVEL_LABELS[value] }));
  if (modelRequiresExplicitReasoningEffort(modelId)) {
    return options;
  }
  return [{ value: 'auto', label: REASONING_LEVEL_LABELS.auto }, ...options];
}
