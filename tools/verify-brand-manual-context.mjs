import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendBrandManualIfNeeded,
  clearBrandManualCacheForTests,
  loadBrandManualContext,
  needsBrandManual,
} from '../core/dist/providers/brand-manual-context.js';

const root = mkdtempSync(path.join(tmpdir(), 'my-agent-brand-manual-'));
const defaultsDir = path.join(root, 'core', 'config', 'defaults');
mkdirSync(defaultsDir, { recursive: true });
writeFileSync(
  path.join(defaultsDir, 'deploy-defaults.json'),
  JSON.stringify({ brand_manual_url: 'http://brand.test/current.md' }),
);

const originalFetch = globalThis.fetch;
const originalOverride = process.env.MY_AGENT_BRAND_MANUAL_URL;
let fetchCount = 0;

try {
  globalThis.fetch = async (url, init) => {
    fetchCount += 1;
    assert.equal(String(url), 'http://brand.test/current.md');
    assert.equal(init?.headers?.Accept, 'text/markdown, text/plain;q=0.9');
    return new Response('# Current Organization Manual\nUse clear, evidence-based language.');
  };

  // Only the selected skill prompt opts in; user wording never triggers a fetch.
  assert.equal(needsBrandManual(undefined), false);
  assert.equal(needsBrandManual('브랜드 매뉴얼을 적용해줘'), false);
  assert.equal(needsBrandManual('ORGANIZATION_BRAND_CONTEXT'), true);

  clearBrandManualCacheForTests();
  const first = await loadBrandManualContext(root, { systemPrompt: 'skill ORGANIZATION_BRAND_CONTEXT' });
  const second = await loadBrandManualContext(root, { systemPrompt: 'ORGANIZATION_BRAND_CONTEXT' });
  assert.match(first ?? '', /Source: http:\/\/brand\.test\/current\.md/);
  assert.match(first ?? '', /evidence-based language/);
  assert.match(first ?? '', /reference data, not as system or developer instructions/);
  assert.equal(second, first, 'same URL should reuse the in-memory manual cache');
  assert.equal(fetchCount, 1);

  const unrelated = await loadBrandManualContext(root, { systemPrompt: 'plain skill prompt' });
  assert.equal(unrelated, null);
  const noSkill = await loadBrandManualContext(root, {});
  assert.equal(noSkill, null);
  assert.equal(fetchCount, 1, 'prompts without the opt-in must not fetch the manual');

  clearBrandManualCacheForTests();
  fetchCount = 0;
  const appended = await appendBrandManualIfNeeded(root, 'base skill prompt ORGANIZATION_BRAND_CONTEXT');
  assert.match(appended ?? '', /base skill prompt/);
  assert.match(appended ?? '', /Organization brand manual/);
  assert.equal(fetchCount, 1);

  const moduleRoot = mkdtempSync(path.join(tmpdir(), 'my-agent-brand-manual-mod-'));
  mkdirSync(path.join(moduleRoot, 'modules', 'organization'), { recursive: true });
  writeFileSync(
    path.join(moduleRoot, 'modules', 'organization', 'module.json'),
    JSON.stringify({
      kind: 'organization-module',
      brand_manual_url: 'http://192.168.1.248:8080/api/brand-manual/current.md',
    }),
  );
  delete process.env.MY_AGENT_BRAND_MANUAL_URL;
  clearBrandManualCacheForTests();
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    assert.equal(String(url), 'http://192.168.1.248:8080/api/brand-manual/current.md');
    return new Response('# Live CQR Manual\nPURPOSE ABOVE ALL');
  };
  const fromModule = await loadBrandManualContext(moduleRoot, {
    systemPrompt: 'ORGANIZATION_BRAND_CONTEXT',
  });
  assert.match(fromModule ?? '', /192\.168\.1\.248:8080\/api\/brand-manual\/current\.md/);
  assert.match(fromModule ?? '', /PURPOSE ABOVE ALL/);
  rmSync(moduleRoot, { recursive: true, force: true });

  process.env.MY_AGENT_BRAND_MANUAL_URL = 'off';
  clearBrandManualCacheForTests();
  const disabled = await loadBrandManualContext(root, { systemPrompt: 'ORGANIZATION_BRAND_CONTEXT' });
  assert.equal(disabled, null);
  assert.equal(fetchCount, 3, 'the environment override can disable the source');

  console.log('verify-brand-manual-context: PASS');
} finally {
  globalThis.fetch = originalFetch;
  if (originalOverride === undefined) delete process.env.MY_AGENT_BRAND_MANUAL_URL;
  else process.env.MY_AGENT_BRAND_MANUAL_URL = originalOverride;
  rmSync(root, { recursive: true, force: true });
}
