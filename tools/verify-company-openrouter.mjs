import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderStore } from '../core/dist/providers/provider-store.js';
import { MemoryMasterKeyStore } from '../core/dist/providers/os-secret-store.js';
import { responsesCompletion } from '../core/dist/providers/responses-compatible.js';
import {
  defaultCompanyModelIds,
  loadCurateConfig,
  normalizeCompanyModelId,
  resolveDefaultOwuiModel,
} from '../core/dist/providers/remote-model-curate.js';

const root = process.cwd();
const providerDefaults = JSON.parse(
  readFileSync(path.join(root, 'core', 'config', 'defaults', 'providers.json'), 'utf8'),
);
const companyDefault = (providerDefaults.providers || providerDefaults).find?.((p) => p.id === 'custom');
assert.ok(companyDefault, 'providers.json must define the custom (company) provider');
const tempRoot = mkdtempSync(path.join(tmpdir(), 'cqr-openrouter-'));
const vaultPath = path.join(tempRoot, 'provider-vault.json');

try {
  const masterKeys = new MemoryMasterKeyStore();
  const store = new ProviderStore(vaultPath, tempRoot, masterKeys);
  const company = store.getDefinition('custom');
  assert.ok(company, 'company provider must exist');
  // Display name and default model come from providers.json (SSOT); only their shape is pinned here.
  assert.equal(company.name, companyDefault.name);
  assert.match(company.name, /OpenRouter/);
  assert.equal(company.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(company.default_model, companyDefault.default_model);
  assert.match(company.default_model, /^[a-z0-9-]+\/[\w.:-]+$/i);
  assert.equal(company.wire_api, 'responses');

  store.saveKey('custom', 'sk-or-test-current', {
    base_url: 'https://attacker.invalid/v1',
    model_id: 'openai/gpt-5.6-terra-pro',
  });
  let resolved = store.resolveProvider('custom');
  assert.equal(resolved?.baseUrl, 'https://openrouter.ai/api/v1', 'company endpoint must be immutable');
  assert.equal(resolved?.wireApi, 'responses');

  const raw = JSON.parse(readFileSync(vaultPath, 'utf8'));
  raw.entries.custom.base_url = 'https://provider.example/api';
  raw.entries.custom.model_id = 'open_webui_openrouter_integration.anthropic.claude-opus-5';
  writeFileSync(vaultPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const migrated = new ProviderStore(vaultPath, tempRoot, masterKeys);
  assert.equal(migrated.getSecret('custom'), null, 'legacy OWUI key must not resolve');
  assert.equal(migrated.listPublic().find((item) => item.id === 'custom')?.configured, false);
  assert.throws(() => migrated.saveKey('custom', ''), /API 키를 입력하세요/);

  migrated.saveKey('custom', 'sk-or-test-reentered');
  resolved = migrated.resolveProvider('custom');
  assert.equal(resolved?.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(resolved?.modelId, companyDefault.default_model);

  const cfg = loadCurateConfig(true);
  const defaults = defaultCompanyModelIds(cfg);
  assert.ok(defaults.length > 0);
  assert.ok(defaults.every((id) => id.includes('/') && !id.startsWith('open_web_ui_')));
  assert.equal(
    normalizeCompanyModelId('open_webui_openrouter_integration.openai.gpt-5.6-terra-pro', cfg),
    'openai/gpt-5.6-terra-pro',
  );
  assert.equal(
    resolveDefaultOwuiModel(['openai/gpt-5.6-terra-pro', 'anthropic/claude-opus-5'], cfg),
    'anthropic/claude-opus-5',
  );

  const ui = readFileSync(path.join(root, 'ui', 'workspace', 'src', 'components', 'ModelManagementModal.tsx'), 'utf8');
  assert.match(ui, /MY OpenRouter/);
  assert.match(ui, /고정 엔드포인트/);
  assert.match(ui, /Responses API/);

  // Current IA: MY default connection → connected personal models → add personal → advanced compatible API.
  const companyIndex = ui.indexOf('MY 기본 연결');
  const connectedProvidersIndex = ui.indexOf('연결된 개인 모델');
  const addPersonalIndex = ui.indexOf('개인 모델 추가');
  const advancedApiIndex = ui.indexOf('기타 호환 API');
  assert.ok(companyIndex >= 0, 'MY default connection section must exist');
  assert.ok(
    companyIndex < connectedProvidersIndex && connectedProvidersIndex < addPersonalIndex,
    'model management IA must stay in company → connected → add order',
  );
  assert.ok(advancedApiIndex > addPersonalIndex, 'advanced compatible API must stay at the bottom');
  assert.match(ui, /grid gap-3 md:grid-cols-3/);

  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      id: 'resp_openrouter_route',
      model: 'anthropic/claude-opus-5',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await responsesCompletion(
      'https://openrouter.ai/api/v1',
      'sk-or-test-route',
      'anthropic/claude-opus-5',
      [{ role: 'user', content: 'ping' }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestedUrl, 'https://openrouter.ai/api/v1/responses');

  console.log('company-openrouter verify: PASS');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
