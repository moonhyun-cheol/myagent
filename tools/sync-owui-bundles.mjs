#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = path.join(root, 'tools', 'keys');
const keyPath = path.join(keysDir, 'openwebui-api-key.txt');

process.env.MY_AGENT_ROOT = root;

if (!existsSync(path.join(root, 'core', 'dist', 'providers', 'provider-store.js'))) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const { ProviderStore } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'provider-store.js')).href
);
const store = new ProviderStore(path.join(root, 'data', 'vault', 'provider-keys.json'), root);
const secret = store.getSecret('custom');
if (!secret?.api_key) {
  console.error('custom provider key missing in vault');
  process.exit(1);
}

mkdirSync(keysDir, { recursive: true });
writeFileSync(keyPath, secret.api_key.trim() + '\n', 'utf8');
console.log('Wrote', keyPath);

const bundles = [
  {
    org: 'myorg',
    out: path.join(root, 'core', 'config', 'defaults', 'keys-bundle.default.enc'),
    defaultProvider: 'ollama',
  },
  {
    org: 'dev',
    out: path.join(root, 'core', 'config', 'defaults', 'keys-bundle.dev.enc'),
    defaultProvider: 'custom',
  },
];

for (const b of bundles) {
  const args = [
    path.join(root, 'tools', 'cqr-admin.mjs'),
    'bundle-keys',
    '--org',
    b.org,
    '--default-provider',
    b.defaultProvider,
    '--out',
    b.out,
  ];
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log('sync-owui-bundles OK');
