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

const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);
const port = 10293;
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

// Exiting mid-flight while the http server is closing trips a libuv
// UV_HANDLE_CLOSING assertion on Windows, so failures set an exit code and let the
// finally block shut the server down once.
try {
  const session = 'phase4-test';

  const img = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': session },
    body: JSON.stringify({ message: '고양이 로고', mode: 'image_gen', attachments: [] }),
  });
  const imgData = await img.json();
  if (!img.ok || !imgData.image?.url) {
    throw new Error(`image chat failed: ${JSON.stringify(imgData).slice(0, 800)}`);
  }

  const imgGet = await fetch(`http://127.0.0.1:${port}${imgData.image.url}`);
  if (!imgGet.ok) {
    throw new Error(`image fetch failed: HTTP ${imgGet.status}`);
  }

  const res = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': session },
    body: JSON.stringify({ message: 'AI 시장 동향', mode: 'deep_research', attachments: [] }),
  });
  const resData = await res.json();
  if (!res.ok || !resData.research?.url) {
    throw new Error(`research failed: ${JSON.stringify(resData).slice(0, 800)}`);
  }

  const md = await fetch(`http://127.0.0.1:${port}${resData.research.url}`);
  if (!md.ok) {
    throw new Error('research md failed');
  }

  console.log('verify-phase4 OK');
} catch (err) {
  console.error(`verify-phase4 FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (srv.listening) await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
}
