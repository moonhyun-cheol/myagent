import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();
process.env.MY_AGENT_ROOT = root;
process.env.CQR_ACTIVATION_SERVER_URL = '';

const lic = path.join(root, 'data', 'vault', 'license.ocx');
const rootLic = path.join(root, 'license.ocx');
const activation = path.join(root, 'data', 'vault', 'activation.json');
for (const f of [lic, rootLic, activation]) {
  if (existsSync(f)) unlinkSync(f);
}

const apiUrl = pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href;
const { createApiServer } = await import(apiUrl);

process.env.MY_AGENT_LICENSE_ENFORCEMENT = '0';
const openPort = 10296;
const openSrv = await createApiServer(openPort);
await new Promise((resolve) => openSrv.listen(openPort, '127.0.0.1', resolve));
try {
  const openStatus = await fetch(`http://127.0.0.1:${openPort}/license/status`).then((r) => r.json());
  if (openStatus.mode !== 'full' || openStatus.enforced !== false) {
    console.error('verify-read-only-mode FAILED: default should be unenforced full', openStatus);
    process.exit(1);
  }
  const openChat = await fetch(`http://127.0.0.1:${openPort}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"message":"hi"}',
  });
  if (openChat.status === 403) {
    const openBody = await openChat.json();
    console.error('verify-read-only-mode FAILED: default must not 403 chat', openBody);
    process.exit(1);
  }
} finally {
  await new Promise((resolve) => openSrv.close(resolve));
}

process.env.MY_AGENT_LICENSE_ENFORCEMENT = '1';
const port = 10299;
const srv = await createApiServer(port);

await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));

try {
  const chat = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"message":"hi"}',
  });

  const body = await chat.json();
  if (chat.status !== 403) {
    console.error('verify-read-only-mode FAILED: expected 403, got', chat.status);
    process.exit(1);
  }
  const allowed = ['LICENSE_READ_ONLY', 'LICENSE_MISSING', 'LICENSE_INVALID', 'LICENSE_SIGNATURE_INVALID'];
  if (!allowed.includes(body.error)) {
    console.error('verify-read-only-mode FAILED: bad body', body);
    process.exit(1);
  }

  console.log('verify-read-only-mode OK');
} finally {
  await new Promise((resolve) => srv.close(resolve));
}
