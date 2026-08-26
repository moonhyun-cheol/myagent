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
copyFileSync(path.join(root, 'data', 'vault', 'license.ocx.example'), lic);
process.env.MY_AGENT_ROOT = root;

const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);
const { extractDocxTextLegacy } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'attachments', 'docx-extract.js')).href
);

const port = 10297;
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

try {
  await fetch(`http://127.0.0.1:${port}/providers/minimax/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'stub:phase7', model_id: 'MiniMax-M2.1' }),
  });
  await fetch(`http://127.0.0.1:${port}/providers/default`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'minimax' }),
  });

  const research = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': 'p7-research' },
    body: JSON.stringify({ message: 'AI market outlook', mode: 'deep_research', attachments: [] }),
  });
  const rd = await research.json();
  if (!research.ok || !rd.research?.url || !String(rd.content).includes('stub cloud')) {
    console.error('research failed', rd);
    process.exit(1);
  }

  const docxSample = Buffer.from(
    'PK\x03\x04word/document.xml<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>',
  );
  const docxText = extractDocxTextLegacy(docxSample, 500);
  if (!docxText.includes('Hello DOCX')) {
    console.error('docx extract failed', docxText);
    process.exit(1);
  }

  console.log('verify-phase7 OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
  if (existsSync(keys)) unlinkSync(keys);
  const sessionsDir = path.join(root, 'data', 'sessions');
  if (existsSync(sessionsDir)) rmSync(sessionsDir, { recursive: true, force: true });
}
