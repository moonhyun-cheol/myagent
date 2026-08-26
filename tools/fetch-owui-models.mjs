#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
if (!secret?.base_url || !secret.api_key) {
  console.error('CUSTOM_PROVIDER_NOT_CONFIGURED');
  process.exit(1);
}
const base = secret.base_url.replace(/\/$/, '');
const res = await fetch(`${base}/models`, {
  headers: { Authorization: `Bearer ${secret.api_key}` },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const rows = data.data || data.items || data.models || (Array.isArray(data) ? data : []);
const ids = rows
  .map((r) => (typeof r === 'string' ? r : r.id || r.name || r.model))
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));
console.log(JSON.stringify(ids, null, 2));
