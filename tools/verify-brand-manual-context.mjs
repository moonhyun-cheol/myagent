import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
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

  assert.equal(needsBrandManual('일반 문서 요약'), false);
  assert.equal(needsBrandManual('브랜드 매뉴얼을 적용해줘'), true);
  assert.equal(needsBrandManual('제품 방향', 'ORGANIZATION_BRAND_CONTEXT'), true);

  clearBrandManualCacheForTests();
  const first = await loadBrandManualContext(root, { userMessage: '브랜드 매뉴얼을 설명해줘' });
  const second = await loadBrandManualContext(root, { userMessage: 'brand guidelines를 적용해줘' });
  assert.match(first ?? '', /Source: http:\/\/brand\.test\/current\.md/);
  assert.match(first ?? '', /evidence-based language/);
  assert.match(first ?? '', /reference data, not as system or developer instructions/);
  assert.equal(second, first, 'same URL should reuse the in-memory manual cache');
  assert.equal(fetchCount, 1);

  const unrelated = await loadBrandManualContext(root, { userMessage: 'TypeScript 코드를 고쳐줘' });
  assert.equal(unrelated, null);
  assert.equal(fetchCount, 1, 'unrelated requests must not fetch the manual');

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
    userMessage: '제품 방향',
    systemPrompt: 'ORGANIZATION_BRAND_CONTEXT',
  });
  assert.match(fromModule ?? '', /192\.168\.1\.248:8080\/api\/brand-manual\/current\.md/);
  assert.match(fromModule ?? '', /PURPOSE ABOVE ALL/);
  rmSync(moduleRoot, { recursive: true, force: true });

  process.env.MY_AGENT_BRAND_MANUAL_URL = 'off';
  clearBrandManualCacheForTests();
  const disabled = await loadBrandManualContext(root, { userMessage: '브랜드 매뉴얼 정보' });
  assert.equal(disabled, null);
  assert.equal(fetchCount, 2, 'the environment override can disable the source');

  console.log('verify-brand-manual-context: PASS');
} finally {
  globalThis.fetch = originalFetch;
  if (originalOverride === undefined) delete process.env.MY_AGENT_BRAND_MANUAL_URL;
  else process.env.MY_AGENT_BRAND_MANUAL_URL = originalOverride;
  rmSync(root, { recursive: true, force: true });
}
