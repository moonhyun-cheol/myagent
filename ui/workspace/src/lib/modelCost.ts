import type { PickerModel } from '../api/myAgentClient';

/**
 * High-cost marker lookup. The core decides the tier from provider pricing
 * (input OR output price); the UI never keeps its own model-name list.
 *
 * `ref` may be a picker value (`auto`, `provider:<id>@<model>`) or the model
 * display stored on an answer (`OpenRouter/anthropic/claude-...`).
 */
export function modelCostTierForRef(
  ref: string | undefined | null,
  premiumIds: ReadonlySet<string>,
  options: readonly PickerModel[],
  ultraPremiumIds: ReadonlySet<string> = new Set(),
): NonNullable<PickerModel['cost_tier']> {
  if (!ref) return 'unknown';
  const option = options.find((item) => item.id === ref);
  if (option?.cost_tier) return option.cost_tier;
  let candidate = ref;
  const at = ref.lastIndexOf('@');
  if (ref.startsWith('provider:') && at >= 0) {
    try {
      candidate = decodeURIComponent(ref.slice(at + 1));
    } catch {
      candidate = ref.slice(at + 1);
    }
  }
  if (ultraPremiumIds.has(candidate)) return 'ultra_premium';
  for (const id of ultraPremiumIds) {
    if (candidate.endsWith(`/${id}`)) return 'ultra_premium';
  }
  if (premiumIds.has(candidate)) return 'premium';
  for (const id of premiumIds) {
    if (candidate.endsWith(`/${id}`)) return 'premium';
  }
  return 'unknown';
}
