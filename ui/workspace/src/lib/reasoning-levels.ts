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

export interface ReasoningCapability {
  supported_efforts: ReasoningEffortLevel[];
  auto_behavior: 'app_resolved' | 'omit';
  source: 'family' | 'fallback';
}

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

export function modelOmitsReasoningEffort(
  modelId?: string | null,
  capability?: ReasoningCapability,
): boolean {
  if (capability) return capability.auto_behavior === 'omit' && capability.supported_efforts.length === 0;
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  return /gemini-3-pro-image|gemini.*-image|[-_/]image(?:-|$)|image-gen|imagen/i.test(m);
}

export function modelSupportedReasoningLevels(
  modelId?: string | null,
  capability?: ReasoningCapability,
): ReasoningEffortLevel[] {
  if (capability) return [...capability.supported_efforts];
  if (modelOmitsReasoningEffort(modelId)) return [];
  // The Core picker is authoritative. Before it loads, do not truncate a new
  // model to an invented three-level family.
  return [...REASONING_EFFORT_LEVELS];
}

/** Keep persisted chat policy valid when the selected model family changes. */
export function normalizeReasoningLevelForModel(
  value: 'auto' | ReasoningEffortLevel,
  modelId?: string | null,
  capability?: ReasoningCapability,
): 'auto' | ReasoningEffortLevel {
  if (value === 'auto') return 'auto';
  const supported = modelSupportedReasoningLevels(modelId, capability);
  if (!supported.length) {
    return 'auto';
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
  opts?: { imageMode?: boolean; capability?: ReasoningCapability },
): Array<{ value: 'auto' | ReasoningEffortLevel; label: string }> {
  if (opts?.imageMode || modelOmitsReasoningEffort(modelId, opts?.capability)) {
    return [{ value: 'auto', label: REASONING_LEVEL_LABELS.auto }];
  }
  const supported = modelSupportedReasoningLevels(modelId, opts?.capability);
  if (!supported.length && modelId) {
    return [{ value: 'auto', label: REASONING_LEVEL_LABELS.auto }];
  }
  const levels = supported.length ? supported : [...REASONING_EFFORT_LEVELS];
  const options = levels.map((value) => ({ value, label: REASONING_LEVEL_LABELS[value] }));
  return [{ value: 'auto', label: REASONING_LEVEL_LABELS.auto }, ...options];
}
