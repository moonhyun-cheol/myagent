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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'cqr-openrouter-'));
const vaultPath = path.join(tempRoot, 'provider-vault.json');

try {
  const masterKeys = new MemoryMasterKeyStore();
  const store = new ProviderStore(vaultPath, tempRoot, masterKeys);
  const company = store.getDefinition('custom');
  assert.ok(company, 'company provider must exist');
  assert.equal(company.name, 'MY OpenRouter');
  assert.equal(company.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(company.default_model, 'anthropic/claude-opus-5');
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
  assert.equal(resolved?.modelId, 'anthropic/claude-opus-5');

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

  const activeConfigurationIndex = ui.indexOf('1 · 핵심 설정');
  const connectedProvidersIndex = ui.indexOf('2 · 관리');
  const addAndAdvancedIndex = ui.indexOf('3 · 추가 및 확장');
  const advancedApiIndex = ui.indexOf('기타 호환 API');
  assert.ok(activeConfigurationIndex >= 0, 'active configuration section must exist');
  assert.ok(
    activeConfigurationIndex < connectedProvidersIndex && connectedProvidersIndex < addAndAdvancedIndex,
    'model management IA must stay in active → connected → add order',
  );
  assert.ok(advancedApiIndex > addAndAdvancedIndex, 'advanced compatible API must stay at the bottom');
  assert.match(ui, /role="status"[\s\S]*aria-live="polite"/);
  assert.match(ui, /absolute right-6[\s\S]*embedded \? 'bottom-6' : 'bottom-20'/);
  assert.match(ui, /개인 연결 \{connectedPersonal\.length\}개/);
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
