#!/usr/bin/env node
/**
 * High-cost ($) model tier: provider input price >= threshold (USD / 1M input tokens).
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

// 2. Tier boundaries (default $4 input, inclusive)
const tier = (input, threshold) => pricing.costTierFor(input === undefined ? undefined : { input }, threshold);
assert.equal(tier(3.99), 'standard');
assert.equal(tier(4), 'premium', '$4 input exactly is premium (inclusive)');
assert.equal(tier(150), 'premium');
assert.equal(tier(0), 'standard');
assert.equal(tier(undefined), 'unknown', 'missing pricing is never guessed');
assert.equal(pricing.costTierFor({ output: 600 }), 'unknown', 'output-only price does not decide the tier');
assert.equal(pricing.costTierFor({ input: 3, output: 600 }), 'standard', 'output price is ignored');
assert.equal(tier(4, 8), 'standard', 'threshold is configurable');
assert.equal(tier(8, 8), 'premium');

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
assert.equal(pricing.modelCostTier('custom', 'vendor/brand-new-giant', 4), 'premium');
assert.equal(pricing.modelCostTier('custom', 'vendor/cheap', 4), 'standard');
assert.equal(pricing.modelCostTier('custom', 'vendor/no-pricing', 4), 'unknown');
assert.equal(pricing.modelCostTier('openai', 'vendor/brand-new-giant', 4), 'unknown', 'tier is per provider');
pricing.recordProviderPricing('custom', [{ id: 'vendor/x' }]);
assert.equal(pricing.modelCostTier('custom', 'vendor/brand-new-giant', 4), 'premium', 'unpriced listing keeps old table');
assert.deepEqual(pricing.listPremiumModelIds(4), ['vendor/brand-new-giant']);
assert.deepEqual(pricing.listPremiumModelIds(100), []);
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

// 7. UI source: badge is `$` only, banner text only, no price text / hover tooltip
const ui = (p) => readFileSync(new URL(`../ui/workspace/src/${p}`, import.meta.url), 'utf8');
const badge = ui('components/PremiumCostBadge.tsx');
assert.match(badge, />\s*\$\s*</, 'badge renders a bare $');
assert.doesNotMatch(badge, /title=/, 'badge has no hover tooltip');
const chat = ui('components/ChatPane.tsx');
assert.match(chat, /고비용 모델 사용 중</);
assert.doesNotMatch(chat, /100만 토큰당/, 'no price text in chat UI');
assert.match(chat, /cost_tier === 'premium' \? <PremiumCostBadge/);
const cost = ui('lib/modelCost.ts');
assert.doesNotMatch(cost, /fable|astra|opus|o1-pro/i, 'UI keeps no model-name list');

// 8. Cold boot without a price table: one background warm-up, none once prices exist
const picker = await import(new URL('models/model-picker.js', dist));
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
