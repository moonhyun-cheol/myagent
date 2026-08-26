import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();

spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });

const lic = path.join(root, 'data', 'vault', 'license.ocx');
const keys = path.join(root, 'data', 'vault', 'provider-keys.json');
const userConfig = path.join(root, 'data', 'config', 'user-overrides.json');
copyFileSync(path.join(root, 'data', 'vault', 'license.ocx.example'), lic);
if (existsSync(keys)) unlinkSync(keys);
mkdirSync(path.dirname(userConfig), { recursive: true });
writeFileSync(userConfig, '{}\n', 'utf8');
process.env.MY_AGENT_ROOT = root;
// This step covers the full curation pipeline (plain providers, stub remote models,
// category labels, mode hints), which the shipped matrix_only config hides on purpose.
process.env.MY_AGENT_MODEL_CURATE_MATRIX_ONLY = '0';

const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const port = 10295;
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

try {
  const save = await fetch(`http://127.0.0.1:${port}/providers/minimax/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'stub:test-key', model_id: 'MiniMax-M2.1' }),
  });
  const saved = await save.json();
  if (!save.ok || !saved.providers?.find((p) => p.id === 'minimax' && p.configured)) {
    console.error('save key failed', saved);
    process.exit(1);
  }

  const list = await fetch(`http://127.0.0.1:${port}/providers`).then((r) => r.json());
  const minimax = list.providers.find((p) => p.id === 'minimax');
  if (!minimax?.key_hint) {
    console.error('key hint missing', minimax);
    process.exit(1);
  }

  const test = await fetch(`http://127.0.0.1:${port}/providers/minimax/test`, { method: 'POST' });
  const testData = await test.json();
  if (!test.ok || !testData.ok) {
    console.error('test failed', testData);
    process.exit(1);
  }

  const picker = await fetch(`http://127.0.0.1:${port}/models/picker`).then((r) => r.json());
  if (!picker.options.some((o) => o.value === 'provider:minimax')) {
    console.error('picker missing provider', picker);
    process.exit(1);
  }

  const chat = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': 'prov-test' },
    body: JSON.stringify({
      message: 'hello provider',
      model: 'provider:minimax',
      attachments: [],
    }),
  });
  const chatData = await chat.json();
  if (!chat.ok || !String(chatData.content).includes('stub cloud')) {
    console.error('chat via provider failed', chatData);
    process.exit(1);
  }

  await fetch(`http://127.0.0.1:${port}/providers/custom/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: 'stub:custom-owui',
      base_url: 'http://127.0.0.1:19999/api/v1',
    }),
  });
  const pickerOwui = await fetch(`http://127.0.0.1:${port}/models/picker`).then((r) => r.json());
  const owuiOpts = pickerOwui.options.filter((o) => o.value.startsWith('provider:custom@'));
  if (owuiOpts.length === 0) {
    console.error('custom remote models missing from picker', pickerOwui.options);
    process.exit(1);
  }
  if (!owuiOpts.some((o) => typeof o.category === 'string' && o.category.length > 0)) {
    console.error('curated category labels missing', owuiOpts);
    process.exit(1);
  }
  if (!pickerOwui.mode_hints?.web_dev?.label) {
    console.error('mode_hints missing web_dev', pickerOwui.mode_hints);
    process.exit(1);
  }

  const { curateRemoteModels, loadCurateConfig } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'remote-model-curate.js')).href
  );
  // Derive the keeper from the live config so curation updates (exclusions, newer model
  // generations) cannot silently turn this into a stale fixture.
  const curateCfg = loadCurateConfig(true);
  const keeperSuffix = curateCfg.mode_models?.web_dev?.primary ?? curateCfg.pinned_suffixes?.[0];
  if (!keeperSuffix) {
    console.error('curate config has no mode_models.web_dev.primary / pinned_suffixes');
    process.exit(1);
  }
  const keeperId = `${curateCfg.openrouter_prefix}${keeperSuffix}`;
  const curated = curateRemoteModels(['--', keeperId]);
  if (curated.length !== 1 || curated[0].id !== keeperId) {
    console.error('curateRemoteModels failed', { keeperId, curated });
    process.exit(1);
  }
  const selectedOwui = owuiOpts[0];
  const selectedModel = decodeURIComponent(String(selectedOwui.value).split('@').slice(1).join('@'));
  const chatOwui = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': 'prov-owui' },
    body: JSON.stringify({
      message: 'pick curated model',
      model: selectedOwui.value,
      attachments: [],
    }),
  });
  const chatOwuiData = await chatOwui.json();
  if (!chatOwui.ok || !String(chatOwuiData.content).includes(selectedModel)) {
    console.error('chat via custom remote model failed', chatOwuiData);
    process.exit(1);
  }

  const { parseRemoteModelIds } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'openai-compatible.js')).href
  );
  const owuiItems = parseRemoteModelIds({
    items: [{ id: 'gpt-4-custom', name: 'Custom GPT-4' }, { id: 'llama3.1', name: 'Llama' }],
    total: 2,
  });
  if (!owuiItems.includes('gpt-4-custom') || !owuiItems.includes('llama3.1')) {
    console.error('parseRemoteModelIds items format failed', owuiItems);
    process.exit(1);
  }

  const { findOwuiFileIds, stripOwuiImageMarkdown, owuiFileIdFromUrl } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'image', 'owui-media.js')).href
  );
  const { shortModelName } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'remote-model-curate.js')).href
  );
  const sample =
    '![Generated image 1](/api/v1/files/dd70a79a-b6c9-43fd-b147-7e64734018cf/content)';
  const ids = findOwuiFileIds(sample);
  if (ids.length !== 1 || ids[0] !== 'dd70a79a-b6c9-43fd-b147-7e64734018cf') {
    console.error('findOwuiFileIds failed', ids);
    process.exit(1);
  }
  if (!owuiFileIdFromUrl('https://ai.example.com/api/v1/files/abc-123/content')) {
    console.error('owuiFileIdFromUrl absolute failed');
    process.exit(1);
  }
  const stripped = stripOwuiImageMarkdown(sample);
  if (stripped.includes('![') || stripped.includes('/api/v1/files/')) {
    console.error('stripOwuiImageMarkdown failed', stripped);
    process.exit(1);
  }
  if (shortModelName(`${curateCfg.openrouter_prefix}black-forest-labs.flux.2-max`) !== 'flux.2-max') {
    console.error('shortModelName flux failed');
    process.exit(1);
  }
  if (shortModelName(`${curateCfg.openrouter_prefix}openai.gpt-5.4`) !== 'gpt-5.4') {
    console.error('shortModelName gpt failed');
    process.exit(1);
  }

  const del = await fetch(`http://127.0.0.1:${port}/providers/minimax/key`, { method: 'DELETE' });
  if (!del.ok) {
    console.error('delete key failed');
    process.exit(1);
  }

  console.log('verify-providers OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
  if (existsSync(keys)) unlinkSync(keys);
}
