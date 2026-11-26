import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../ui/workspace/node_modules/vite/dist/node/index.js';

// Isolated browser fixture: no real sessions, provider keys or external requests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = [
  { value: 'auto', label: '기본 (자동)', cost_tier: 'ultra_premium', access_mode: 'auto' },
  ...[['normal', 'standard'], ['high', 'premium'], ['ultra', 'ultra_premium'], ['unknown', 'unknown']].map(([id, tier]) => ({
    value: `provider:custom@${encodeURIComponent(`vendor/${id}`)}`, label: `테스트 ${id}`,
    cost_tier: tier, access_mode: 'managed', provider_id: 'custom',
  })),
];
const payload = {
  options, premium_model_ids: ['vendor/high', 'vendor/ultra'], ultra_premium_model_ids: ['vendor/ultra'],
  company_models: { selected: ['vendor/high', 'vendor/ultra'], defaults: [], featured: [], recent: [], available: ['vendor/high', 'vendor/ultra'], premium: ['vendor/high', 'vendor/ultra'], ultra_premium: ['vendor/ultra'] },
};
const entry = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ChatPane } from '/src/components/ChatPane.tsx';
  import { ModelManagementModal } from '/src/components/ModelManagementModal.tsx';
  import { useWorkspaceStore } from '/src/store/workspaceStore.ts';
  import { modelCostTierForRef } from '/src/lib/modelCost.ts';
  import '/src/index.css';
  window.fixtureStore = useWorkspaceStore;
  window.modelCostTierForRef = modelCostTierForRef;
  const settings = location.search.includes('settings');
  createRoot(document.getElementById('root')).render(settings
    ? React.createElement(ModelManagementModal, { open: true, onClose() {}, embedded: true })
    : React.createElement(ChatPane));
`;
const chromiumPath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
let server;
let browser;
try {
  server = await createServer({
    root: path.join(root, 'ui/workspace'), configFile: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'cost-tier-fixture',
      resolveId(id) { if (id === '/cost-entry.js') return '\0cost-tier-fixture'; },
      load(id) { if (id === '\0cost-tier-fixture') return entry; },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
          if (url.pathname === '/test') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><div id="root" style="height:100vh"></div><script type="module" src="/cost-entry.js"></script></body></html>'); return; }
          if (url.pathname === '/models/picker') return json(payload);
          if (url.pathname === '/providers') return json({ providers: [{ id: 'custom', name: 'MY OpenRouter', configured: true }] });
          if (url.pathname.startsWith('/config')) return json({});
          if (url.pathname === '/skills/selectable') return json({ skills: [] });
          if (url.pathname.startsWith('/sessions')) return json({ sessions: [], attachments: [] });
          next();
        });
      },
    }],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/test`);
  await page.getByTestId('chat-model-select').waitFor();
  await page.evaluate(async () => { await window.fixtureStore.getState().refreshModelPicker(); });
  const banner = page.getByTestId('premium-model-banner');
  await banner.filter({ hasText: '초고비용 모델 사용 중' }).waitFor();
  assert.equal(await banner.getByRole('img', { name: '초고비용 모델', exact: true }).innerText(), '$$$');
  await page.getByTestId('chat-model-select').click();
  const high = page.getByRole('option', { name: '테스트 high', exact: false });
  assert.equal(await high.getByTestId('premium-cost-badge').innerText(), '$');
  const ultra = page.getByRole('option', { name: '테스트 ultra', exact: false });
  assert.equal(await ultra.getByTestId('premium-cost-badge').innerText(), '$$$');
  await high.click();
  await banner.filter({ hasText: /^\$\s*고비용 모델 사용 중$/ }).waitFor();
  await page.getByTestId('chat-model-select').click();
  await page.getByRole('option', { name: '테스트 normal', exact: true }).click();
  await banner.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('chat-model-select').getByTestId('premium-cost-badge').count(), 0);
  await page.getByTestId('chat-model-select').click();
  await page.getByRole('option', { name: '테스트 unknown', exact: true }).click();
  assert.equal(await banner.count(), 0);
  console.log('PASS: real picker click path, auto ultra, premium $, ultra $$$, normal/unknown without warning');

  await page.evaluate(() => {
    const store = window.fixtureStore;
    const { modelOptions, premiumModelIds, ultraPremiumModelIds } = store.getState();
    const get = ref => window.modelCostTierForRef(ref, new Set(premiumModelIds), modelOptions, new Set(ultraPremiumModelIds));
    for (const ref of ['vendor/ultra', 'OpenRouter/vendor/ultra', 'provider:custom@vendor%2Fultra']) {
      if (get(ref) !== 'ultra_premium') throw new Error(`bad ultra reference: ${ref}`);
    }
    if (get('vendor/normal') !== 'unknown') throw new Error('unlisted price is not guessed');
    store.setState({ chat: [
      { id: 'high', role: 'assistant', mode: 'chat', text: '고비용 답변', model: 'OpenRouter/vendor/high' },
      { id: 'ultra', role: 'assistant', mode: 'chat', text: '초고비용 답변', model: 'OpenRouter/vendor/ultra' },
    ] });
  });
  await page.locator('[data-chat-turn-id="ultra"] .chat-bubble--ultra-premium').waitFor();
  assert.equal(await page.locator('[data-chat-turn-id="high"] .chat-bubble--premium').count(), 1);
  assert.equal(await page.locator('[data-chat-turn-id="ultra"] .chat-model-switch [data-cost-tier="ultra_premium"]').count(), 1);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const colors = await page.locator('[data-chat-turn-id="ultra"] .premium-cost-badge').last().evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
    assert.equal(colors.background, 'rgb(220, 38, 38)');
    assert.equal(colors.color, 'rgb(255, 255, 255)');
  }
  console.log('PASS: history references, answer borders, model-switch badge, light/dark ultra styling');
  await page.goto(`${origin}/test?settings`);
  await page.getByText('MY OpenRouter', { exact: true }).first().waitFor();
  // Default-model select options carry the same tiers as the composer.
  await page.waitForFunction(() => [...document.querySelectorAll('option')].some(el => el.textContent.includes('테스트 ultra $$$')));
  assert.equal(await page.locator('option').filter({ hasText: '테스트 high $' }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: settings default-model tier labels and no browser runtime errors');
} finally {
  await browser?.close();
  await server?.close();
}
