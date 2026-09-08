import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, unlinkSync, copyFileSync, writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();
const lic = path.join(root, 'data', 'vault', 'license.ocx');
const keys = path.join(root, 'data', 'vault', 'provider-keys.json');
const configPath = path.join(root, 'data', 'config', 'user-overrides.json');
const example = path.join(root, 'data', 'vault', 'license.ocx.example');

for (const f of [keys, configPath]) {
  if (existsSync(f)) unlinkSync(f);
}
copyFileSync(example, lic);

process.env.MY_AGENT_ROOT = root;
process.env.CQR_ACTIVATION_SERVER_URL = 'off';
const build = await import('node:child_process').then(({ spawnSync }) =>
  spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' }),
);
if (build.status !== 0) process.exit(1);

const port = 0;
const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);
const srv = await createApiServer(port);
await new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(port, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${srv.address().port}`;
const providerOptions = (picker, id) => picker.options.filter(
  (option) => option.kind === 'provider' && option.provider_id === id,
);
function assertOllamaOptions(picker) {
  const options = providerOptions(picker, 'ollama');
  if (!options.length || options.some((option) =>
    !option.value.startsWith('provider:ollama@')
    || !decodeURIComponent(option.value.slice('provider:ollama@'.length)).trim()
    || option.access_mode !== 'local')) {
    throw new Error('expected explicit local Ollama model picks');
  }
}

try {
  await fetch(`${base}/providers/ollama/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'stub:ollama', model_id: 'qwen2.5:latest' }),
  });
  await fetch(`${base}/providers/minimax/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'stub:mini', model_id: 'MiniMax-M2.1' }),
  });
  await fetch(`${base}/providers/default`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'ollama' }),
  });

  const { loadCurateConfig } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'remote-model-curate.js')).href
  );
  // matrix_only curation keeps the default picker limited to the workspace matrix, so
  // plain providers are hidden there but must stay usable by explicit pick (stream below)
  // and must reappear once local_only turns the matrix off.
  const matrixOnly = loadCurateConfig().matrix_only === true;
  const picker0 = await fetch(`${base}/models/picker`).then((r) => r.json());
  assertOllamaOptions(picker0);
  const minimax0 = providerOptions(picker0, 'minimax');
  if (matrixOnly) {
    if (minimax0.length) {
      throw new Error('minimax should be hidden under matrix_only curation');
    }
  } else if (!minimax0.length) {
    throw new Error('expected both ollama and minimax in picker');
  }

  const stream = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': 'p9-ollama' },
    body: JSON.stringify({ message: 'hello ollama', model: 'provider:ollama', mode: 'chat' }),
  });
  if (stream.status !== 200) throw new Error(`ollama stream ${stream.status}`);
  const body = await stream.text();
  if (!body.includes('stub stream') && !body.includes('token')) {
    throw new Error('ollama stream empty');
  }

  await fetch(`${base}/config/local-only`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ local_only: true }),
  });
  const picker1 = await fetch(`${base}/models/picker`).then((r) => r.json());
  if (!picker1.local_only) throw new Error('local_only flag expected');
  if (providerOptions(picker1, 'minimax').length) throw new Error('minimax should be hidden in local_only');
  assertOllamaOptions(picker1);

  const block = await fetch(`${base}/providers/openai/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'sk-test' }),
  });
  if (block.status !== 403) throw new Error('openai key should block in local_only');

  const ollamaTest = await fetch(`${base}/providers/ollama/test`, { method: 'POST' }).then((r) => r.json());
  if (!ollamaTest.ok) throw new Error('ollama stub test failed');

  await fetch(`${base}/config/local-only`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ local_only: false }),
  });

  console.log('verify-phase9 OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
  if (existsSync(keys)) unlinkSync(keys);
  if (existsSync(configPath)) unlinkSync(configPath);
}
