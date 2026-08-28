#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelPicker, selectRecentRemoteModelIds } from '../core/dist/models/model-picker.js';
import {
  describeRemoteModels,
} from '../core/dist/providers/remote-model-curate.js';
import { configurationWireCandidates } from '../core/dist/providers/provider-wire-api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const explicitFable = describeRemoteModels(['anthropic/claude-fable-5']);
assert.deepEqual(
  explicitFable.map((model) => model.id),
  ['anthropic/claude-fable-5'],
  'an explicit user model selection must survive automatic family pruning',
);
assert.deepEqual(
  selectRecentRemoteModelIds([
    { id: 'vendor/older', created_at: 100 },
    { id: 'vendor/no-date' },
    { id: 'vendor/newest', created_at: 300 },
    { id: 'vendor/newer', created_at: 200 },
  ], 2),
  ['vendor/newest', 'vendor/newer'],
  'recent discovery must use provider publication metadata and omit undated guesses',
);

const app = read('shell/CqrPa.Shell/App.xaml.cs');
assert.doesNotMatch(app, /WaitForHealth\(/, 'WPF startup must not block before showing the window');
assert.match(app, /new MainWindow\(root, _api\.Port, _api\)/);
assert.ok(app.indexOf('new MainWindow') < app.indexOf('win.Show()'));

const windowXaml = read('shell/CqrPa.Shell/MainWindow.xaml');
const windowCode = read('shell/CqrPa.Shell/MainWindow.xaml.cs');
const shellHost = read('shell/CqrPa.Shell/ApiProcessHost.cs');
assert.match(windowXaml, /x:Name="StartupOverlay"/);
assert.match(windowXaml, /x:Name="StartupRetryButton"/);
assert.match(windowCode, /WaitForHealthAsync/);
assert.match(shellHost, /if \(IsReady\(h\)\)/, 'shell readiness must use API health and matching product root');
assert.match(shellHost, /string\.Equals\(expectedRoot, actualRoot, StringComparison\.OrdinalIgnoreCase\)/);
assert.doesNotMatch(shellHost, /if \(h\.Ok && h\.Version == _expectedVersion\)/, 'version skew must not trap the shell behind the loading overlay');
assert.match(windowCode, /OnWorkspaceNavigationCompleted/);

const apiServer = read('core/src/api-server.ts');
assert.match(apiServer, /setImmediate\(\(\) => \{[\s\S]*sweepCheckpoints[\s\S]*sweepSessionTemp/);

const sidebar = read('ui/workspace/src/components/GeminiNavSidebar.tsx');
assert.match(sidebar, /SettingsModal/);
assert.doesNotMatch(sidebar, /overlay === 'models'/);
const settings = [
  read('ui/workspace/src/components/SettingsModal.tsx'),
  read('ui/workspace/src/components/SettingsAgentPage.tsx'),
].join('\n');
for (const marker of ['모델·프로바이더', '동작·승인', 'settings-reasoning-level', 'settings-autopilot-mode', 'settings-approval-delegation-mode']) {
  assert.ok(settings.includes(marker), `settings center marker missing: ${marker}`);
}
assert.match(settings, /<ModelManagementModal open embedded/);
const chatPane = read('ui/workspace/src/components/ChatPane.tsx');
assert.doesNotMatch(chatPane, /settings-autopilot-mode|settings-approval-delegation-mode|setAgentAutopilot|setApprovalDelegation/);
assert.doesNotMatch(chatPane, /const MODES|setAiMode|>텍스트<|>코드<|>이미지</, 'composer must use one unified input');
assert.match(chatPane, /할 일 입력… \(@ 또는 피커로 파일 컨텍스트\)/);
const workspaceStore = read('ui/workspace/src/store/workspaceStore.ts');
assert.doesNotMatch(workspaceStore, /get\(\)\.aiMode|job\.mode\b|mapAiModeToApi|postChat/);
assert.match(workspaceStore, /const primaryMode = job\.skillMode \|\| 'chat'/);
const workspaceClient = read('ui/workspace/src/api/myAgentClient.ts');
assert.doesNotMatch(workspaceClient, /category_label|mapAiModeToApi|export async function postChat/);
const modelPickerSource = read('core/src/models/model-picker.ts');
assert.doesNotMatch(modelPickerSource, /category_label|formatProviderModelLabel/);
const curateSource = read('core/src/providers/remote-model-curate.ts');
assert.doesNotMatch(curateSource, /categoryLabel|formatProviderModelLabel/);
const curateConfig = JSON.parse(read('core/config/defaults/openwebui-model-curate.json'));
assert.ok(
  Object.values(curateConfig.categories).every((category) => !Object.hasOwn(category, 'label')),
  'internal model categories must not carry user-facing explanations',
);
const modal = read('ui/workspace/src/components/ModelManagementModal.tsx');
for (const marker of ['MY OpenRouter', 'OpenAI', 'Anthropic', 'Gemini', '기타 호환 API']) {
  assert.ok(modal.includes(marker), `model center marker missing: ${marker}`);
}
for (const marker of ['선택된 MY 모델', 'OpenAI 호환', 'Anthropic 호환', '기본 세트 복원']) {
  assert.ok(modal.includes(marker), `model personalization marker missing: ${marker}`);
}
assert.doesNotMatch(modal, /MiniMax/, 'vendor-specific personal cards must not leak into model manager');
assert.doesNotMatch(modal, /ManagerExtras|User MCP|로컬 LLM|로컬 이미지/, 'non-model runtime settings must not leak into model manager');

let fetchCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  fetchCount += 1;
  return new Response(JSON.stringify({ data: [{ id: 'remote-test-model' }] }), {
    headers: { 'content-type': 'application/json' },
  });
};

const definitions = [
  {
    id: 'custom',
    name: 'MY OpenRouter',
    kind: 'openai_compatible',
    base_url: 'https://company.test/api',
    default_model: 'company-default',
    custom: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai_compatible',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-personal',
  },
];
const secrets = {
  custom: { api_key: 'stub-key', model_id: 'company-default' },
  openai: { api_key: 'stub-key', model_id: 'gpt-personal' },
};
const providerStore = {
  listDefinitions: () => definitions,
  getConfiguredIds: () => Object.keys(secrets),
  getDefaultId: () => 'custom',
  getSecret: (id) => secrets[id] ?? null,
  getDefinition: (id) => definitions.find((item) => item.id === id),
};
const registry = { load: () => ({ default_llm_id: null, models: [] }) };

try {
  const cold = await buildModelPicker(registry, {}, providerStore);
  assert.equal(fetchCount, 0, 'cold picker must not probe company /models');
  assert.ok(cold.options.some((item) => item.value.includes('company-default')));
  assert.ok(cold.options.some((item) => item.value === 'provider:openai'));
  assert.ok(
    cold.options.every((item) => !item.label.includes('★')),
    'model picker labels must not include default stars',
  );
  assert.ok(
    cold.options
      .filter((item) => item.provider_id === 'custom')
      .every((item) => !/\([^)]*\)/.test(item.label)),
    'company model labels must not include category explanations',
  );
  assert.equal(cold.company_models?.source, 'default');
  assert.ok((cold.company_models?.selected.length ?? 0) > 0, 'fixed company defaults required');

  const personalizedId = 'open_webui_openrouter_integration.vendor.personal-model';
  const normalizedPersonalizedId = 'vendor/personal-model';
  const personalized = await buildModelPicker(registry, { company_model_ids: [personalizedId] }, providerStore);
  assert.equal(personalized.company_models?.source, 'personalized');
  assert.deepEqual(personalized.company_models?.selected, [normalizedPersonalizedId]);
  assert.ok(personalized.options.some((item) => item.value.includes(encodeURIComponent(normalizedPersonalizedId))));

  await buildModelPicker(registry, {}, providerStore, { refreshRemote: true });
  assert.ok(fetchCount > 0, 'explicit refresh must probe remote models');
} finally {
  globalThis.fetch = originalFetch;
}

assert.deepEqual(configurationWireCandidates({ ...definitions[0], id: 'user_openai', custom: false, user_defined: true, compatibility: 'openai' }, 'claude-routed'), ['responses', 'chat_completions']);
assert.deepEqual(configurationWireCandidates({ ...definitions[0], id: 'user_anthropic', custom: false, user_defined: true, compatibility: 'anthropic' }, 'any-model'), ['messages']);

console.log('verify-startup-model-center: PASS');
