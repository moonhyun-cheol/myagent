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
  return [
    { value: 'auto', label: REASONING_LEVEL_LABELS.auto },
    ...levels.map((value) => ({ value, label: REASONING_LEVEL_LABELS[value] })),
  ];
}
