import path from 'node:path';
import { existsSync, unlinkSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { missingFeatures, readLicenseFeatures } from './deploy-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();

const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(1);

const example = path.join(root, 'data', 'vault', 'license.ocx.example');
const lic = path.join(root, 'data', 'vault', 'license.ocx');
const activation = path.join(root, 'data', 'vault', 'activation.json');
const userConfig = path.join(root, 'data', 'config', 'user-overrides.json');

if (existsSync(activation)) unlinkSync(activation);
mkdirSync(path.dirname(userConfig), { recursive: true });
writeFileSync(userConfig, '{}\n', 'utf8');

if (!existsSync(example)) {
  console.error('Missing license.ocx.example ??run npm run admin:keygen && npm run admin:issue');
  process.exit(1);
}

const exampleMissing = missingFeatures(readLicenseFeatures(example));
if (exampleMissing.length) {
  console.error(
    'verify-license FAILED: license.ocx.example missing features:',
    exampleMissing.join(', '),
  );
  console.error('Run: node tools/ensure-dev-keys.mjs');
  process.exit(1);
}

copyFileSync(example, lic);

process.env.MY_AGENT_ROOT = root;
if (!('CQR_ACTIVATION_SERVER_URL' in process.env)) {
  process.env.CQR_ACTIVATION_SERVER_URL = '';
}
const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const port = 10298;
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

try {
  const status = await fetch(`http://127.0.0.1:${port}/license/status`).then((r) => r.json());
  if (status.mode !== 'full') {
    console.error('verify-license FAILED: expected full mode, got', status);
    process.exit(1);
  }

  const chat = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"message":"hello"}',
  });
  if (chat.status !== 200) {
    console.error('verify-license FAILED: chat expected 200, got', chat.status);
    process.exit(1);
  }

  const badSig = path.join(root, 'data', 'vault', 'license-bad.ocx');
  const { readFileSync } = await import('node:fs');
  const doc = JSON.parse(readFileSync(lic, 'utf8'));
  doc.sig = 'AAAA';
  writeFileSync(badSig, JSON.stringify(doc));
  copyFileSync(badSig, lic);
  if (existsSync(activation)) unlinkSync(activation);

  const srv2 = await createApiServer(10297);
  await new Promise((r) => srv2.listen(10297, '127.0.0.1', r));
  const bad = await fetch('http://127.0.0.1:10297/license/status').then((r) => r.json());
  await new Promise((r) => srv2.close(r));
  if (bad.mode !== 'read_only' || bad.reason !== 'LICENSE_SIGNATURE_INVALID') {
    console.error('verify-license FAILED: bad signature should be read_only', bad);
    process.exit(1);
  }

  console.log('verify-license OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
}
