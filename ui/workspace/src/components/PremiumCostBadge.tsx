import type { PickerModel } from '../api/myAgentClient';

/** Core-provided price tier; the UI does not infer prices from model names. */
export function PremiumCostBadge({ small = false, tier = 'premium' }: { small?: boolean; tier?: PickerModel['cost_tier'] }) {
  if (tier !== 'premium' && tier !== 'ultra_premium') return null;
  const ultra = tier === 'ultra_premium';
  return (
    <span
      className={`premium-cost-badge${small ? ' premium-cost-badge--small' : ''}${ultra ? ' premium-cost-badge--ultra' : ''}`}
      role="img"
      aria-label={ultra ? '초고비용 모델' : '고비용 모델'}
      data-testid="premium-cost-badge"
      data-cost-tier={tier}
    >
      {ultra ? '$$$' : '$'}
    </span>
  );
}
