/**
 * Provider-reported model pricing → cost tier.
 *
 * The premium rule is price-based, never a model-name list: a model is
 * `premium` when the provider's output price is >= the configured threshold
 * (USD per 1M output tokens, `deploy-defaults.json`
 * `premium_output_usd_per_million`, default 50). Models whose provider does not
 * publish pricing stay `unknown` — we do not guess.
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
}

export type ModelCostTier = 'premium' | 'standard' | 'unknown';

export const DEFAULT_PREMIUM_OUTPUT_USD_PER_MILLION = 50;

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
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
  };
}

export function costTierFor(
  pricing: ModelPricing | undefined,
  thresholdUsdPerMillion = DEFAULT_PREMIUM_OUTPUT_USD_PER_MILLION,
): ModelCostTier {
  if (!pricing || pricing.output === undefined) return 'unknown';
  return pricing.output >= thresholdUsdPerMillion ? 'premium' : 'standard';
}

export function resolvePremiumOutputThreshold(cqrRoot?: string): number {
  const root = cqrRoot ?? process.env.MY_AGENT_ROOT ?? '';
  try {
    const value = Number(loadDeployDefaults(root).premium_output_usd_per_million);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PREMIUM_OUTPUT_USD_PER_MILLION;
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

export function modelCostTier(
  providerId: string,
  modelId: string,
  thresholdUsdPerMillion: number,
): ModelCostTier {
  return costTierFor(lookupModelPricing(providerId, modelId), thresholdUsdPerMillion);
}

/** All model ids (any provider) whose known output price meets the threshold. */
export function listPremiumModelIds(thresholdUsdPerMillion: number): string[] {
  const out = new Set<string>();
  for (const models of loadTable().values()) {
    for (const [id, pricing] of models) {
      if (costTierFor(pricing, thresholdUsdPerMillion) === 'premium') out.add(id);
    }
  }
  return [...out].sort();
}
