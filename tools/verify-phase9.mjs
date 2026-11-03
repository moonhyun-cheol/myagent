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

// Ollama/MiniMax defaults were removed (b8281e0). No local provider ships by default, so
// this checks the cloud side of local_only: BYOK providers hide and new cloud keys block.
try {
  await fetch(`${base}/providers/anthropic/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'stub:p9', model_id: 'claude-opus-4-8' }),
  });
  await fetch(`${base}/providers/default`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'anthropic' }),
  });

  // Anthropic is a primary BYOK provider, so it stays visible even under matrix_only.
  const picker0 = await fetch(`${base}/models/picker`).then((r) => r.json());
  if (!providerOptions(picker0, 'anthropic').length) {
    throw new Error('expected primary BYOK anthropic in picker');
  }

  const stream = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': 'p9-explicit' },
    body: JSON.stringify({ message: 'hello explicit pick', model: 'provider:anthropic', mode: 'chat' }),
  });
  if (stream.status !== 200) throw new Error(`explicit pick stream ${stream.status}`);
  const body = await stream.text();
  if (!body.includes('stub stream') && !body.includes('token')) {
    throw new Error('explicit pick stream empty');
  }

  await fetch(`${base}/config/local-only`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ local_only: true }),
  });
  const picker1 = await fetch(`${base}/models/picker`).then((r) => r.json());
  if (!picker1.local_only) throw new Error('local_only flag expected');
  if (providerOptions(picker1, 'anthropic').length) throw new Error('anthropic should be hidden in local_only');

  const block = await fetch(`${base}/providers/openai/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'sk-test' }),
  });
  if (block.status !== 403) throw new Error('openai key should block in local_only');

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
