/**
 * Orchestration-budget phase bands. Research on constraint awareness (task
 * decomposition / context-rot) supports telling the model that it is near a
 * limit, but exposing the raw step number tends to cause early rush and
 * anchoring. So we surface the *phase* (converge / finalize) and never the
 * count. Thresholds are fractions of MAX_AGENT_STEPS (per-run budget, which is
 * what actually triggers continuation — a resume gets a fresh budget).
 */
export type AgentBudgetBand = 'converge' | 'finalize';

export interface AgentBudgetBandThresholds {
  converge: number;
  finalize: number;
}

/** Built-in defaults; env overrides tune without a code change. */
export const DEFAULT_AGENT_BUDGET_BAND_THRESHOLDS: AgentBudgetBandThresholds = {
  converge: 0.7,
  finalize: 0.9,
};

function clampFraction(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(String(raw ?? ''));
  // Bands are fractions of the per-run budget; reject anything outside (0,1].
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

/**
 * Resolve band thresholds from env, falling back to defaults.
 *   MY_AGENT_BUDGET_CONVERGE_FRACTION (default 0.7)
 *   MY_AGENT_BUDGET_FINALIZE_FRACTION (default 0.9)
 * finalize is clamped to be >= converge so the finalize band stays reachable.
 */
export function resolveAgentBudgetBandThresholds(
  env: NodeJS.ProcessEnv = process.env,
): AgentBudgetBandThresholds {
  const converge = clampFraction(
    env.MY_AGENT_BUDGET_CONVERGE_FRACTION,
    DEFAULT_AGENT_BUDGET_BAND_THRESHOLDS.converge,
  );
  const finalizeRaw = clampFraction(
    env.MY_AGENT_BUDGET_FINALIZE_FRACTION,
    DEFAULT_AGENT_BUDGET_BAND_THRESHOLDS.finalize,
  );
  return { converge, finalize: Math.max(converge, finalizeRaw) };
}

export function resolveAgentBudgetBand(
  step: number,
  maxSteps: number,
  thresholds: AgentBudgetBandThresholds = resolveAgentBudgetBandThresholds(),
): AgentBudgetBand | null {
  if (!Number.isFinite(step) || !Number.isFinite(maxSteps) || maxSteps <= 0) return null;
  const ratio = step / maxSteps;
  if (ratio >= thresholds.finalize) return 'finalize';
  if (ratio >= thresholds.converge) return 'converge';
  return null;
}

export function agentBudgetBandNote(band: AgentBudgetBand): string {
  if (band === 'finalize') {
    return [
      '[예산 국면: 마감 임박] 이 실행의 작업 예산 한도에 가까워졌다.',
      '한도에 닿으면 앱이 진행 상황을 검토해 예산을 연장하거나 재개 상태를 저장한다.',
      'TODO·Evidence를 최신으로 갱신해 두고 남은 일을 계속 진행하라. 이 안내만을 이유로 작업을 끝내지 마라.',
      '검증되지 않은 작업은 미해결로 명확히 남겨라.',
    ].join(' ');
  }
  return [
    '[예산 국면: 수렴] 이 실행의 작업 예산 후반부에 들어섰다.',
    '요청 결과에 꼭 필요한 일부터 진행하고, 요청과 무관한 탐색은 늘리지 마라. TODO를 최신으로 유지하라.',
    '남은 일을 줄이거나 서둘러 끝내라는 뜻이 아니다. 한도에 닿으면 앱이 진행 상황을 검토해 예산을 연장할 수 있다.',
  ].join(' ');
}
