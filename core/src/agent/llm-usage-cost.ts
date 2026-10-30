import { lookupModelPricingAny } from '../models/model-pricing.js';

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
  /** USD per one million cache-write input tokens. Falls back to input rate (unknown premium). */
  cache_write_input_usd_per_million?: number;
  /** USD per one million output tokens. */
  output_usd_per_million: number;
}

export interface LlmUsageCost {
  currency: 'USD';
  pricing_status: 'priced' | 'unpriced' | 'invalid_config';
  pricing_source: 'MY_AGENT_LLM_PRICING_JSON' | 'model-pricing.json';
  model_id: string;
  input_tokens: number;
  uncached_input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  cache_hit_rate: number;
  input_cost_microusd?: number;
  cached_input_cost_microusd?: number;
  cache_write_cost_microusd?: number;
  /** False when the provider published no cache-write price and the input rate was used. */
  cache_write_priced?: boolean;
  output_cost_microusd?: number;
  total_cost_microusd?: number;
  /** Read discount only (cached tokens × (input − cached rate)). */
  cache_savings_microusd?: number;
  /** Read discount minus cache-write premium; negative when caching cost more than it saved. */
  cache_net_savings_microusd?: number;
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
      const write = finiteNonNegative(row.cache_write_input_usd_per_million);
      if (input == null || output == null) return 'invalid';
      table[model] = {
        input_usd_per_million: input,
        output_usd_per_million: output,
        ...(cached == null ? {} : { cached_input_usd_per_million: cached }),
        ...(write == null ? {} : { cache_write_input_usd_per_million: write }),
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
 * Pricing: explicit MY_AGENT_LLM_PRICING_JSON wins; otherwise the provider
 * price table persisted from the last `/models` listing (data/model-pricing.json).
 */
export function calculateLlmUsageCost(
  usage: LlmUsageCounters,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
  providerId?: string,
): LlmUsageCost {
  const inputTokens = Math.max(0, Math.trunc(usage.prompt_tokens || 0));
  const cachedTokens = Math.min(inputTokens, Math.max(0, Math.trunc(usage.cached_tokens || 0)));
  const writeTokens = Math.min(inputTokens - cachedTokens, Math.max(0, Math.trunc(usage.cache_write_tokens || 0)));
  const uncachedTokens = inputTokens - cachedTokens - writeTokens;
  const outputTokens = Math.max(0, Math.trunc(usage.completion_tokens || 0));
  const base: LlmUsageCost = {
    currency: 'USD',
    pricing_status: 'unpriced',
    pricing_source: 'MY_AGENT_LLM_PRICING_JSON',
    model_id: modelId,
    input_tokens: inputTokens,
    uncached_input_tokens: uncachedTokens,
    cached_input_tokens: cachedTokens,
    cache_write_input_tokens: writeTokens,
    output_tokens: outputTokens,
    cache_hit_rate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };

  const table = parsePricingTable(env.MY_AGENT_LLM_PRICING_JSON);
  if (table === 'invalid') return { ...base, pricing_status: 'invalid_config' };
  let pricing = table?.[modelId] ?? table?.default;
  let source: LlmUsageCost['pricing_source'] = 'MY_AGENT_LLM_PRICING_JSON';
  if (!pricing) {
    const listed = lookupModelPricingAny(modelId, providerId);
    if (listed?.input !== undefined && listed.output !== undefined) {
      pricing = {
        input_usd_per_million: listed.input,
        output_usd_per_million: listed.output,
        ...(listed.cache_read === undefined ? {} : { cached_input_usd_per_million: listed.cache_read }),
        ...(listed.cache_write === undefined ? {} : { cache_write_input_usd_per_million: listed.cache_write }),
      };
      source = 'model-pricing.json';
    }
  }
  if (!pricing) return base;

  const cachedRate = pricing.cached_input_usd_per_million ?? pricing.input_usd_per_million;
  const writeRate = pricing.cache_write_input_usd_per_million ?? pricing.input_usd_per_million;
  const toMicrousd = (tokens: number, usdPerMillion: number) => Math.round(tokens * usdPerMillion);
  const inputCost = toMicrousd(uncachedTokens, pricing.input_usd_per_million);
  const cachedCost = toMicrousd(cachedTokens, cachedRate);
  const writeCost = toMicrousd(writeTokens, writeRate);
  const outputCost = toMicrousd(outputTokens, pricing.output_usd_per_million);
  const savings = Math.max(
    0,
    Math.round(cachedTokens * (pricing.input_usd_per_million - cachedRate)),
  );
  const writePremium = Math.round(writeTokens * (writeRate - pricing.input_usd_per_million));

  return {
    ...base,
    pricing_status: 'priced',
    pricing_source: source,
    input_cost_microusd: inputCost,
    cached_input_cost_microusd: cachedCost,
    cache_write_cost_microusd: writeCost,
    cache_write_priced: pricing.cache_write_input_usd_per_million !== undefined,
    output_cost_microusd: outputCost,
    total_cost_microusd: inputCost + cachedCost + writeCost + outputCost,
    cache_savings_microusd: savings,
    cache_net_savings_microusd: savings - writePremium,
  };
}
