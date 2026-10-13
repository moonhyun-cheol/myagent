import type { PickerModel } from '../api/myAgentClient';

/**
 * High-cost marker lookup. The core decides the tier from provider pricing
 * (output price >= threshold); the UI never keeps its own model-name list.
 *
 * `ref` may be a picker value (`auto`, `provider:<id>@<model>`) or the model
 * display stored on an answer (`OpenRouter/anthropic/claude-...`).
 */
export function isPremiumModelRef(
  ref: string | undefined | null,
  premiumIds: ReadonlySet<string>,
  options: readonly PickerModel[],
): boolean {
  if (!ref) return false;
  const option = options.find((item) => item.id === ref);
  if (option?.cost_tier) return option.cost_tier === 'premium';
  let candidate = ref;
  const at = ref.lastIndexOf('@');
  if (ref.startsWith('provider:') && at >= 0) {
    try {
      candidate = decodeURIComponent(ref.slice(at + 1));
    } catch {
      candidate = ref.slice(at + 1);
    }
  }
  if (premiumIds.has(candidate)) return true;
  for (const id of premiumIds) {
    if (candidate.endsWith(`/${id}`)) return true;
  }
  return false;
}
