#!/usr/bin/env node
/**
 * Price tiers: input/output OR thresholds (USD / 1M tokens).
 * Price-based only — no model-name list. Requires `npx tsc -p tsconfig.json` (core/dist).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = new URL('../core/dist/', import.meta.url);
const pricing = await import(new URL('models/model-pricing.js', dist));
const oai = await import(new URL('providers/openai-compatible.js', dist));

// 1. Unit conversion (OpenRouter: USD per token, often strings)
assert.equal(pricing.perTokenToPerMillion('0.00005'), 50);
assert.equal(pricing.perTokenToPerMillion(0.0006), 600);
assert.equal(pricing.perTokenToPerMillion('0.00004999'), 49.99);
assert.equal(pricing.perTokenToPerMillion('-1'), undefined, 'variable pricing (-1) is unknown');
assert.equal(pricing.perTokenToPerMillion('abc'), undefined);
assert.equal(pricing.perTokenToPerMillion(''), undefined);
assert.equal(pricing.perTokenToPerMillion(null), undefined);
assert.equal(pricing.perTokenToPerMillion('0'), 0);

// 2. Inclusive boundaries, OR rules, higher-tier precedence and unknown prices.
const tier = (input, threshold) => pricing.costTierFor(input === undefined ? undefined : { input, output: 0 }, threshold);
assert.equal(tier(3.99), 'standard');
assert.equal(tier(4), 'premium', '$4 input exactly is premium (inclusive)');
assert.equal(tier(7.999), 'premium');
assert.equal(tier(8), 'ultra_premium');
assert.equal(tier(150), 'ultra_premium');
assert.equal(tier(0), 'standard');
assert.equal(tier(undefined), 'unknown', 'missing pricing is never guessed');
assert.equal(pricing.costTierFor({ output: 600 }), 'ultra_premium', 'known output can trigger tier');
assert.equal(pricing.costTierFor({ input: 3, output: 600 }), 'ultra_premium');
assert.equal(pricing.costTierFor({ input: 0, output: 19.999 }), 'standard');
assert.equal(pricing.costTierFor({ input: 0, output: 20 }), 'premium');
assert.equal(pricing.costTierFor({ input: 4, output: 39.999 }), 'premium');
assert.equal(pricing.costTierFor({ input: 4, output: 40 }), 'ultra_premium');
assert.equal(pricing.costTierFor({ input: 8, output: 0 }), 'ultra_premium');
assert.equal(pricing.costTierFor({ input: 1 }), 'unknown');
assert.equal(pricing.costTierFor({ output: 1 }), 'unknown');
assert.equal(pricing.costTierFor({ input: 4 }), 'premium');
assert.equal(pricing.costTierFor({ output: 20 }), 'premium');
assert.equal(pricing.costTierFor({ input: NaN, output: -1 }), 'unknown');
assert.equal(pricing.costTierFor({ input: Infinity, output: 0 }), 'unknown');
assert.equal(pricing.costTierFor({ input: 0, output: 0 }), 'standard');
const customThresholds = { input: 6, output: 30, ultraInput: 12, ultraOutput: 60 };
assert.equal(pricing.costTierFor({ input: 5, output: 29 }, customThresholds), 'standard');
assert.equal(pricing.costTierFor({ input: 6, output: 0 }, customThresholds), 'premium');
assert.equal(pricing.costTierFor({ input: 0, output: 60 }, customThresholds), 'ultra_premium');

// 3. /models parsing keeps pricing (new models need no code change)
const parsed = oai.parseRemoteModels({
  data: [
    { id: 'vendor/brand-new-giant', pricing: { prompt: '0.00002', completion: '0.00009', input_cache_read: '0.000002' } },
    { id: 'vendor/cheap', pricing: { prompt: '0.0000002', completion: '0.0000012' } },
    { id: 'vendor/variable', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'vendor/no-pricing' },
  ],
});
const byId = Object.fromEntries(parsed.map((m) => [m.id, m]));
assert.deepEqual(byId['vendor/brand-new-giant'].pricing, { input: 20, output: 90, cache_read: 2 });
assert.deepEqual(byId['vendor/cheap'].pricing, { input: 0.2, output: 1.2 });
assert.equal(byId['vendor/variable'].pricing, undefined);
assert.equal(byId['vendor/no-pricing'].pricing, undefined);

// 4. Persisted table: survives "restart", provider without pricing keeps previous data
const dir = mkdtempSync(path.join(tmpdir(), 'premium-tier-'));
const file = path.join(dir, 'model-pricing.json');
pricing.setModelPricingFileForTest(file);
pricing.recordProviderPricing('custom', parsed);
assert.ok(existsSync(file), 'pricing table persisted');
pricing.setModelPricingFileForTest(file); // drop memory → reload from disk
assert.equal(pricing.modelCostTier('custom', 'vendor/brand-new-giant', 4), 'ultra_premium');
assert.equal(pricing.modelCostTier('custom', 'vendor/cheap', 4), 'standard');
assert.equal(pricing.modelCostTier('custom', 'vendor/no-pricing', 4), 'unknown');
assert.equal(pricing.modelCostTier('openai', 'vendor/brand-new-giant', 4), 'unknown', 'tier is per provider');
pricing.recordProviderPricing('custom', [{ id: 'vendor/x' }]);
assert.equal(pricing.modelCostTier('custom', 'vendor/brand-new-giant', 4), 'ultra_premium', 'unpriced listing keeps old table');
assert.deepEqual(pricing.listPremiumModelIds(4), ['vendor/brand-new-giant']);
assert.deepEqual(pricing.listPremiumModelIds(4, true), ['vendor/brand-new-giant']);
assert.deepEqual(pricing.listPremiumModelIds({ input: 100, output: 100, ultraInput: 200, ultraOutput: 200 }), []);
const doc = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(doc.version, 1);

// 5. Corrupt cache file → empty table, no throw
const bad = path.join(dir, 'bad.json');
await import('node:fs').then((fs) => fs.writeFileSync(bad, '{not json'));
pricing.setModelPricingFileForTest(bad);
assert.deepEqual(pricing.listPremiumModelIds(4), []);

// 6. Threshold from deploy-defaults (repo default = $4 input)
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
assert.equal(pricing.resolvePremiumInputThreshold(repoRoot), 4);
assert.equal(pricing.resolvePremiumInputThreshold(path.join(dir, 'no-such-root')), 4, 'missing config → default 4');
assert.deepEqual(pricing.resolveCostThresholds(repoRoot), { input: 4, output: 20, ultraInput: 8, ultraOutput: 40 });
assert.deepEqual(pricing.resolveCostThresholds(path.join(dir, 'no-such-root')), pricing.DEFAULT_COST_THRESHOLDS);

// 7. UI source: distinct markers and banners; no model-name list.
const ui = (p) => readFileSync(new URL(`../ui/workspace/src/${p}`, import.meta.url), 'utf8');
const badge = ui('components/PremiumCostBadge.tsx');
assert.ok(badge.includes("ultra ? '$$$' : '$'"), 'distinct ultra marker');
assert.doesNotMatch(badge, /title=/, 'badge has no hover tooltip');
const chat = ui('components/ChatPane.tsx');
assert.ok(chat.includes('초고비용 모델 사용 중'));
assert.ok(chat.includes('고비용 모델 사용 중'));
assert.doesNotMatch(chat, /100만 토큰당/, 'no price text in chat UI');
assert.match(chat, /PremiumCostBadge tier=\{model\.cost_tier/);
const cost = ui('lib/modelCost.ts');
assert.doesNotMatch(cost, /fable|astra|opus|o1-pro/i, 'UI keeps no model-name list');

// 8. Cold boot without a price table: one background warm-up, none once prices exist
const picker = await import(new URL('models/model-picker.js', dist));
pricing.setModelPricingFileForTest(null);
pricing.recordProviderPricing('custom', [
  { id: 'vendor/normal', pricing: { input: 2, output: 10 } },
  { id: 'vendor/high', pricing: { input: 1, output: 20 } },
  { id: 'vendor/ultra', pricing: { input: 8, output: 10 } },
]);
const definition = { id: 'custom', name: 'OpenRouter', custom: true, base_url: 'https://openrouter.ai/api/v1', default_model: 'vendor/ultra' };
const tierStore = {
  listDefinitions: () => [definition], getConfiguredIds: () => ['custom'],
  getDefaultId: () => 'custom', getDefinition: () => definition,
  getSecret: () => ({ model_id: 'vendor/ultra' }),
  resolveProvider: (_id, modelId) => ({ def: definition, modelId, baseUrl: definition.base_url }),
};
const payload = await picker.buildModelPicker(
  { load: () => ({ default_llm_id: null, models: [] }) },
  { company_model_ids: ['vendor/normal', 'vendor/high', 'vendor/ultra'] }, tierStore,
  { cqrRoot: repoRoot },
);
assert.equal(payload.options[0].cost_tier, 'ultra_premium', 'auto follows resolved default');
assert.deepEqual(payload.options.slice(1).map(m => m.cost_tier).sort(), ['premium', 'standard', 'ultra_premium']);
assert.deepEqual(payload.premium_model_ids, ['vendor/high', 'vendor/ultra']);
assert.deepEqual(payload.ultra_premium_model_ids, ['vendor/ultra']);
assert.deepEqual(payload.company_models.ultra_premium, ['vendor/ultra']);
assert.equal(payload.premium_output_usd_per_million, 20);
assert.equal(payload.ultra_premium_output_usd_per_million, 40);
let fetches = 0;
const fakeStore = {
  getConfiguredIds: () => ['custom'],
  getDefinition: () => ({ custom: true, base_url: 'http://127.0.0.1:9' }),
  getSecret: () => { fetches += 1; return null; }, // no key → fetch path exits without network
};
const emptyFile = path.join(dir, 'empty-pricing.json');
pricing.setModelPricingFileForTest(emptyFile);
assert.equal(pricing.hasModelPricing(), false);
assert.equal(picker.warmModelPricingIfMissing(fakeStore), true, 'warms when no price table');
assert.equal(picker.isModelPricingWarming(), true);
assert.equal(picker.warmModelPricingIfMissing(fakeStore), true, 'second call joins in-flight warm');
await new Promise((r) => setTimeout(r, 20));
assert.equal(picker.isModelPricingWarming(), false, 'warm flag clears after completion');
assert.equal(fetches, 1, 'only one fetch for concurrent triggers');
pricing.setModelPricingFileForTest(file);
assert.equal(pricing.hasModelPricing(), true);
assert.equal(picker.warmModelPricingIfMissing(fakeStore), false, 'no warm once prices are persisted');
pricing.setModelPricingFileForTest(emptyFile);
assert.equal(
  picker.warmModelPricingIfMissing({ ...fakeStore, getDefinition: () => ({ custom: false }) }),
  false,
  'no warm without a custom (priced) provider',
);
const storeSrc = ui('store/workspaceStore.ts');
assert.match(storeSrc, /picker\.pricing_warming && pricingRepollCount < 6/, 'UI re-polls a bounded number of times');

console.log('verify-premium-model-tier: OK');
