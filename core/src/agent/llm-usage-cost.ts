export interface LlmUsageCounters {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
}

export interface LlmModelPricing {
  /** USD per one million non-cached input tokens. */
  input_usd_per_million: number;
  /** USD per one million cached input tokens. Falls back to input rate. */
  cached_input_usd_per_million?: number;
  /** USD per one million output tokens. */
  output_usd_per_million: number;
}

export interface LlmUsageCost {
  currency: 'USD';
  pricing_status: 'priced' | 'unpriced' | 'invalid_config';
  pricing_source: 'MY_AGENT_LLM_PRICING_JSON';
  model_id: string;
  input_tokens: number;
  uncached_input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cache_hit_rate: number;
  input_cost_microusd?: number;
  cached_input_cost_microusd?: number;
  output_cost_microusd?: number;
  total_cost_microusd?: number;
  cache_savings_microusd?: number;
}

type PricingTable = Record<string, LlmModelPricing>;

function finiteNonNegative(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parsePricingTable(raw: string | undefined): PricingTable | 'invalid' | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    const table: PricingTable = {};
    for (const [model, candidate] of Object.entries(parsed)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return 'invalid';
      const row = candidate as Record<string, unknown>;
      const input = finiteNonNegative(row.input_usd_per_million);
      const output = finiteNonNegative(row.output_usd_per_million);
      const cached = finiteNonNegative(row.cached_input_usd_per_million);
      if (input == null || output == null) return 'invalid';
      table[model] = {
        input_usd_per_million: input,
        output_usd_per_million: output,
        ...(cached == null ? {} : { cached_input_usd_per_million: cached }),
      };
    }
    return table;
  } catch {
    return 'invalid';
  }
}

/**
 * Computes host-side usage/cost metadata after an LLM response.
 * This never changes messages, tool schemas, or any provider request field.
 */
export function calculateLlmUsageCost(
  usage: LlmUsageCounters,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): LlmUsageCost {
  const inputTokens = Math.max(0, Math.trunc(usage.prompt_tokens || 0));
  const cachedTokens = Math.min(inputTokens, Math.max(0, Math.trunc(usage.cached_tokens || 0)));
  const uncachedTokens = inputTokens - cachedTokens;
  const outputTokens = Math.max(0, Math.trunc(usage.completion_tokens || 0));
  const base: LlmUsageCost = {
    currency: 'USD',
    pricing_status: 'unpriced',
    pricing_source: 'MY_AGENT_LLM_PRICING_JSON',
    model_id: modelId,
    input_tokens: inputTokens,
    uncached_input_tokens: uncachedTokens,
    cached_input_tokens: cachedTokens,
    output_tokens: outputTokens,
    cache_hit_rate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };

  const table = parsePricingTable(env.MY_AGENT_LLM_PRICING_JSON);
  if (table === 'invalid') return { ...base, pricing_status: 'invalid_config' };
  const pricing = table?.[modelId] ?? table?.default;
  if (!pricing) return base;

  const cachedRate = pricing.cached_input_usd_per_million ?? pricing.input_usd_per_million;
  const toMicrousd = (tokens: number, usdPerMillion: number) => Math.round(tokens * usdPerMillion);
  const inputCost = toMicrousd(uncachedTokens, pricing.input_usd_per_million);
  const cachedCost = toMicrousd(cachedTokens, cachedRate);
  const outputCost = toMicrousd(outputTokens, pricing.output_usd_per_million);
  const savings = Math.max(
    0,
    Math.round(cachedTokens * (pricing.input_usd_per_million - cachedRate)),
  );

  return {
    ...base,
    pricing_status: 'priced',
    input_cost_microusd: inputCost,
    cached_input_cost_microusd: cachedCost,
    output_cost_microusd: outputCost,
    total_cost_microusd: inputCost + cachedCost + outputCost,
    cache_savings_microusd: savings,
  };
}
