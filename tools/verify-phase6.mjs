import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();

spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });

const lic = path.join(root, 'data', 'vault', 'license.ocx');
const keys = path.join(root, 'data', 'vault', 'provider-keys.json');
const sessionsDir = path.join(root, 'data', 'sessions');
copyFileSync(path.join(root, 'data', 'vault', 'license.ocx.example'), lic);
process.env.MY_AGENT_ROOT = root;

const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const port = 10296;
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

try {
  await fetch(`http://127.0.0.1:${port}/providers/minimax/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'stub:phase6', model_id: 'MiniMax-M2.1' }),
  });

  const created = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());

  const session = created.id;
  const res = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': session },
    body: JSON.stringify({
      message: 'stream hello',
      mode: 'chat',
      model: 'provider:minimax',
      attachments: [],
    }),
  });

  if (!res.ok) {
    console.error('stream failed', res.status);
    process.exit(1);
  }

  const text = await res.text();
  if (!text.includes('stub stream') || !/type":\s*"done"/.test(text)) {
    console.error('stream body unexpected', text.slice(0, 400));
    process.exit(1);
  }

  const saved = await fetch(`http://127.0.0.1:${port}/sessions/${session}`).then((r) => r.json());
  if (saved.messages.length < 2) {
    console.error('session not persisted', saved);
    process.exit(1);
  }

  const list = await fetch(`http://127.0.0.1:${port}/sessions`).then((r) => r.json());
  if (!list.sessions.some((s) => s.id === session)) {
    console.error('session list missing', list);
    process.exit(1);
  }

  console.log('verify-phase6 OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
  if (existsSync(keys)) unlinkSync(keys);
  if (existsSync(sessionsDir)) rmSync(sessionsDir, { recursive: true, force: true });
}
