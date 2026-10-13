/** `$` marker for models whose provider output price meets the high-cost threshold. */
export function PremiumCostBadge({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`premium-cost-badge${small ? ' premium-cost-badge--small' : ''}`}
      role="img"
      aria-label="고비용 모델"
      data-testid="premium-cost-badge"
    >
      $
    </span>
  );
}
