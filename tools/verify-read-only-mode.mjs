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
const hadLicense = existsSync(lic);
for (const f of [lic, rootLic, activation]) {
  if (existsSync(f)) unlinkSync(f);
}

const apiUrl = pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href;
const { createApiServer } = await import(apiUrl);

const port = 10299;
const srv = await createApiServer(port);

await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));

try {
  const status = await fetch(`http://127.0.0.1:${port}/license/status`).then((r) => r.json());

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
