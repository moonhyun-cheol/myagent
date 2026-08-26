import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();

spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });

const example = path.join(root, 'data', 'vault', 'license.ocx.example');
const lic = path.join(root, 'data', 'vault', 'license.ocx');
if (existsSync(lic)) unlinkSync(lic);
copyFileSync(example, lic);

process.env.MY_AGENT_ROOT = root;
const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const port = 10296;
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

const testFile = path.join(root, 'data', 'attachments', '_test_upload.txt');
writeFileSync(testFile, 'hello cqr attachment', 'utf8');

try {
  const boundary = '----CqrBoundary7MA4YWxk';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="note.txt"',
    'Content-Type: text/plain',
    '',
    'hello cqr attachment',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const up = await fetch(`http://127.0.0.1:${port}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-CQR-Session': 'verify-session',
    },
    body,
  });

  if (up.status !== 201) {
    console.error('upload failed', up.status, await up.text());
    process.exit(1);
  }

  const { attachments } = await up.json();
  const id = attachments[0]?.id;
  if (!id) {
    console.error('no attachment id');
    process.exit(1);
  }

  const get = await fetch(`http://127.0.0.1:${port}/attachments/${id}?session=verify-session`);
  if (get.status !== 200) {
    console.error('get failed', get.status);
    process.exit(1);
  }
  const text = await get.text();
  if (text !== 'hello cqr attachment') {
    console.error('content mismatch', text);
    process.exit(1);
  }

  const ro = await fetch(`http://127.0.0.1:${port}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (existsSync(lic)) unlinkSync(lic);
  const srv2 = await createApiServer(10295);
  await new Promise((r) => srv2.listen(10295, '127.0.0.1', r));
  const ro2 = await fetch('http://127.0.0.1:10295/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-CQR-Session': 'x',
    },
    body,
  });
  srv2.close();
  if (ro2.status !== 403) {
    console.error('read-only upload should 403, got', ro2.status);
    process.exit(1);
  }

  console.log('verify-attachments OK');
} finally {
  srv.close();
  if (existsSync(lic)) unlinkSync(lic);
  if (existsSync(testFile)) unlinkSync(testFile);
}
