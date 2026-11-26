/**
 * Provider-reported model pricing → cost tier.
 *
 * Price-based, never a model-name list (USD per 1M tokens):
 * ultra_premium: input >= 8 OR output >= 40; premium: input >= 4 OR output >= 20.
 * Check the higher tier first. Both prices must be known to classify as standard.
 *
 * Prices from the last remote `/models` listing are persisted under
 * `data/model-pricing.json` so a cold app start can show tiers before the
 * next remote refresh.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDeployDefaults } from '../config/deploy-defaults.js';

/** USD per 1M tokens. */
export interface ModelPricing {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  /** `/models` `architecture.output_modalities` ("text", "image", …) — tells image generators apart. */
  outputs?: string[];
}

export type ModelCostTier = 'ultra_premium' | 'premium' | 'standard' | 'unknown';

export const DEFAULT_PREMIUM_INPUT_USD_PER_MILLION = 4;
export interface ModelCostThresholds {
  input: number;
  output: number;
  ultraInput: number;
  ultraOutput: number;
}
export const DEFAULT_COST_THRESHOLDS: Readonly<ModelCostThresholds> = {
  input: DEFAULT_PREMIUM_INPUT_USD_PER_MILLION, output: 20, ultraInput: 8, ultraOutput: 40,
};

/** OpenRouter reports USD per token as strings ("0.00005"); negative = variable/unknown. */
export function perTokenToPerMillion(value: unknown): number | undefined {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  // Round to micro-dollars to drop float noise (0.00005 * 1e6 → 50).
  return Math.round(n * 1e12) / 1e6;
}

/** Parse a `/models` row's `pricing` block. Returns undefined when nothing usable is present. */
export function parseModelPricing(row: Record<string, unknown>): ModelPricing | undefined {
  const raw = row.pricing;
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const input = perTokenToPerMillion(p.prompt ?? p.input);
  const output = perTokenToPerMillion(p.completion ?? p.output);
  const cacheRead = perTokenToPerMillion(p.input_cache_read ?? p.cache_read);
  const cacheWrite = perTokenToPerMillion(p.input_cache_write ?? p.cache_write);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  const arch = row.architecture && typeof row.architecture === 'object' ? row.architecture as Record<string, unknown> : {};
  const outputs = Array.isArray(arch.output_modalities)
    ? [...new Set(arch.output_modalities.filter((m): m is string => typeof m === 'string' && /^[a-z_-]{1,20}$/.test(m)))].slice(0, 8)
    : [];
  return {
    ...(outputs.length ? { outputs } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
  };
}

export function costTierFor(
  pricing: ModelPricing | undefined,
  thresholds: number | Readonly<ModelCostThresholds> = DEFAULT_COST_THRESHOLDS,
): ModelCostTier {
  const t = typeof thresholds === 'number' ? { ...DEFAULT_COST_THRESHOLDS, input: thresholds } : thresholds;
  const valid = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const input = valid(pricing?.input) ? pricing.input : undefined;
  const output = valid(pricing?.output) ? pricing.output : undefined;
  if ((input !== undefined && input >= t.ultraInput) || (output !== undefined && output >= t.ultraOutput)) return 'ultra_premium';
  if ((input !== undefined && input >= t.input) || (output !== undefined && output >= t.output)) return 'premium';
  return input !== undefined && output !== undefined ? 'standard' : 'unknown';
}

export function resolveCostThresholds(cqrRoot?: string): ModelCostThresholds {
  const root = cqrRoot ?? process.env.MY_AGENT_ROOT ?? '';
  let config: ReturnType<typeof loadDeployDefaults> = {};
  try { config = loadDeployDefaults(root); } catch { /* use defaults */ }
  const positive = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const input = positive(config.premium_input_usd_per_million, 4);
  const output = positive(config.premium_output_usd_per_million, 20);
  return {
    input, output,
    ultraInput: Math.max(input, positive(config.ultra_premium_input_usd_per_million, 8)),
    ultraOutput: Math.max(output, positive(config.ultra_premium_output_usd_per_million, 40)),
  };
}

export function resolvePremiumInputThreshold(cqrRoot?: string): number {
  const root = cqrRoot ?? process.env.MY_AGENT_ROOT ?? '';
  try {
    const value = Number(loadDeployDefaults(root).premium_input_usd_per_million);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PREMIUM_INPUT_USD_PER_MILLION;
}

// ---------------------------------------------------------------------------
// Persisted price table (per provider)
// ---------------------------------------------------------------------------

interface PricingFileDoc {
  version: 1;
  updated_at: string;
  providers: Record<string, Record<string, ModelPricing>>;
}

let fileOverride: string | null | undefined;
let table: Map<string, Map<string, ModelPricing>> | null = null;

/** Verify hook: point the store at a temp file (null = memory only). */
export function setModelPricingFileForTest(file: string | null): void {
  fileOverride = file;
  table = null;
}

function pricingFile(): string | null {
  if (fileOverride !== undefined) return fileOverride;
  const root = process.env.MY_AGENT_ROOT?.trim();
  return root ? path.join(root, 'data', 'model-pricing.json') : null;
}

function loadTable(): Map<string, Map<string, ModelPricing>> {
  if (table) return table;
  table = new Map();
  const file = pricingFile();
  if (file && existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Partial<PricingFileDoc>;
      for (const [providerId, models] of Object.entries(doc.providers ?? {})) {
        if (!models || typeof models !== 'object') continue;
        table.set(providerId, new Map(Object.entries(models)));
      }
    } catch {
      /* corrupt cache: start empty, next refresh rewrites it */
    }
  }
  return table;
}

function persistTable(): void {
  const file = pricingFile();
  if (!file || !table) return;
  const doc: PricingFileDoc = {
    version: 1,
    updated_at: new Date().toISOString(),
    providers: Object.fromEntries(
      [...table.entries()].map(([pid, models]) => [pid, Object.fromEntries(models)]),
    ),
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* pricing cache is best-effort */
  }
}

/** Replace a provider's price table with the latest remote listing. */
export function recordProviderPricing(
  providerId: string,
  models: Array<{ id: string; pricing?: ModelPricing }>,
): void {
  const priced = models.filter((m) => m.pricing);
  if (priced.length === 0) return; // provider publishes no pricing — keep previous data
  const t = loadTable();
  t.set(providerId, new Map(priced.map((m) => [m.id, m.pricing as ModelPricing])));
  persistTable();
}

/** True once any provider's price table is known (memory or `data/model-pricing.json`). */
export function hasModelPricing(): boolean {
  return loadTable().size > 0;
}

export function lookupModelPricing(providerId: string, modelId: string): ModelPricing | undefined {
  return loadTable().get(providerId)?.get(modelId);
}

/** Provider-scoped lookup first, then the first provider that lists the same model id. */
export function lookupModelPricingAny(modelId: string, providerId?: string): ModelPricing | undefined {
  const t = loadTable();
  if (providerId) {
    const hit = t.get(providerId)?.get(modelId);
    if (hit) return hit;
  }
  for (const models of t.values()) {
    const hit = models.get(modelId);
    if (hit) return hit;
  }
  return undefined;
}

export function modelCostTier(
  providerId: string,
  modelId: string,
  thresholds: number | Readonly<ModelCostThresholds> = DEFAULT_COST_THRESHOLDS,
): ModelCostTier {
  return costTierFor(lookupModelPricing(providerId, modelId), thresholds);
}

/** Includes ultra-premium for backward-compatible high-cost discovery. */
export function listPremiumModelIds(
  thresholds: number | Readonly<ModelCostThresholds> = DEFAULT_COST_THRESHOLDS,
  ultraOnly = false,
): string[] {
  const out = new Set<string>();
  for (const models of loadTable().values()) {
    for (const [id, pricing] of models) {
      const tier = costTierFor(pricing, thresholds);
      if (tier === 'ultra_premium' || (!ultraOnly && tier === 'premium')) out.add(id);
    }
  }
  return [...out].sort();
}
