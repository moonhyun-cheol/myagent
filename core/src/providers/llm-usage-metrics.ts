/**
 * Per-request cost/token metrics shared by the usage summary and the JSONL→SQLite migration check,
 * so both sides of the migration comparison are computed by exactly the same code.
 */
import { calculateLlmUsageCost } from '../agent/llm-usage-cost.js';

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : undefined);
export const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface RowMetrics {
  failed: boolean;
  input: number;
  output: number;
  cached: number;
  write: number;
  reasoning: number;
  billed?: number;
  estimated?: number;
  unpriced: boolean;
  savings: number;
  savingsEstimated: boolean;
}

const BACKFILL_FIELDS = [
  'provider_cost_usd', 'cache_discount_usd', 'input_tokens', 'total_input_tokens', 'output_tokens',
  'cached_tokens', 'reasoning_tokens', 'upstream_provider',
] as const;
/** Backfill only fills what the reply itself did not report; reported values always win. */
export function mergeCostBackfill(row: Record<string, unknown>, fill: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...row, cost_backfilled: true };
  for (const key of BACKFILL_FIELDS) {
    if ((merged[key] === null || merged[key] === undefined) && fill[key] !== null && fill[key] !== undefined) merged[key] = fill[key];
  }
  return merged;
}

/**
 * Decision version checks: an unknown id answers a free 400 — not usage, not a failure.
 * A probe that hit an existing id is a real billed decision and stays counted.
 */
export function isCountedUsageRow(row: Record<string, unknown>): boolean {
  return row.event === 'finish' && !(row.probe === true && row.http_status === 400);
}

export function rowMetrics(row: Record<string, unknown>, env: NodeJS.ProcessEnv): RowMetrics {
  const failed = row.outcome !== 'completed';
  const cached = num(row.cached_tokens);
  const write = num(row.cache_write_tokens);
  // total_input_tokens already includes cache reads/writes for every wire.
  let input = num(row.total_input_tokens);
  if (!input && row.input_tokens != null) {
    input = num(row.input_tokens) + (row.input_semantics === 'excludes_cache' ? cached + write : 0);
  }
  const output = num(row.output_tokens);
  const metrics: RowMetrics = { failed, input, output, cached, write, reasoning: num(row.reasoning_tokens), unpriced: false, savings: 0, savingsEstimated: false };
  const modelId = str(row.response_model) ?? str(row.model) ?? 'default';
  const billed = finite(row.provider_cost_usd);
  if (billed !== undefined) {
    metrics.billed = Math.max(0, billed);
    const discount = finite(row.cache_discount_usd);
    const actualInput = finite(row.upstream_input_cost_usd);
    if (discount !== undefined) metrics.savings = discount;
    else if (actualInput !== undefined && cached + write > 0) {
      // Savings = what the input would cost at the list rate − what it actually cost (reads discounted,
      // writes at a premium, so it can be negative). Only the list rate comes from the price table.
      const list = calculateLlmUsageCost({ prompt_tokens: input, completion_tokens: 0 }, modelId, env, str(row.provider_id));
      if (list.pricing_status === 'priced' && list.input_cost_microusd !== undefined) {
        metrics.savings = list.input_cost_microusd / 1_000_000 - actualInput;
        metrics.savingsEstimated = true;
      }
    }
    return metrics;
  }
  if (input + output === 0) {
    // Completed but nothing to price (video jobs without a reported cost, usage-less replies).
    metrics.unpriced = !failed;
    return metrics;
  }
  const cost = calculateLlmUsageCost(
    { prompt_tokens: input, completion_tokens: output, cached_tokens: cached, cache_write_tokens: write },
    modelId,
    env,
    str(row.provider_id),
  );
  if (cost.pricing_status === 'priced' && cost.total_cost_microusd !== undefined) {
    metrics.estimated = cost.total_cost_microusd / 1_000_000;
    metrics.savings = (cost.cache_net_savings_microusd ?? 0) / 1_000_000;
    metrics.savingsEstimated = cached + write > 0;
  } else {
    metrics.unpriced = true;
  }
  return metrics;
}

/** The four numbers the migration must reproduce per log date. */
export interface UsageReconcileTotals {
  requests: number;
  tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
}

export function addReconcile(t: UsageReconcileTotals, m: RowMetrics): void {
  t.requests += 1;
  t.tokens += m.input + m.output;
  t.cost_usd += (m.billed ?? 0) + (m.estimated ?? 0);
  t.cache_savings_usd += m.savings;
}
