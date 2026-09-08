import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();

spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });

const example = path.join(root, 'data', 'vault', 'license.ocx.example');
const lic = path.join(root, 'data', 'vault', 'license.ocx');
copyFileSync(example, lic);

const llmDir = path.join(root, 'data', 'models', 'llm');
mkdirSync(llmDir, { recursive: true });
const fakeGguf = path.join(llmDir, 'test-tiny.gguf');
writeFileSync(fakeGguf, 'GGUF' + '\0'.repeat(2048));

process.env.MY_AGENT_ROOT = root;
const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const srv = await createApiServer(0);
await new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', resolve);
});
const address = srv.address();
if (!address || typeof address === 'string') throw new Error('model verification server has no TCP port');
const port = address.port;

try {
  const scan = await fetch(`http://127.0.0.1:${port}/models/scan`, { method: 'POST' });
  if (scan.status !== 200) {
    console.error('scan failed', scan.status, await scan.text());
    process.exit(1);
  }
  const scanned = await scan.json();
  if (scanned.models.length < 1) {
    console.error('expected at least 1 model');
    process.exit(1);
  }

  const llm = scanned.models.find((m) => m.kind === 'llm' && m.filename === 'test-tiny.gguf');
  if (!llm) {
    console.error('scanned test-tiny.gguf model not found');
    process.exit(1);
  }

  const def = await fetch(`http://127.0.0.1:${port}/models/default`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'llm', id: llm.id }),
  });
  if (def.status !== 200) {
    console.error('set default failed', def.status);
    process.exit(1);
  }

  const verify = await fetch(`http://127.0.0.1:${port}/models/${llm.id}/verify`, { method: 'POST' });
  const vr = await verify.json();
  if (!verify.ok || !vr.ok) {
    console.error('verify failed', vr);
    process.exit(1);
  }

  const list = await fetch(`http://127.0.0.1:${port}/models?kind=llm`).then((r) => r.json());
  if (list.default_llm_id !== llm.id) {
    console.error('default not persisted');
    process.exit(1);
  }

  // Bind the chat to a general (non-workspace) project so a configured global
  // dev workspace cannot redirect this local-model smoke test into the agent plane.
  const project = await fetch(`http://127.0.0.1:${port}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `model-verify-${Date.now()}`, kind: 'project' }),
  }).then((r) => r.json());
  const testSessionId = `mtest-${process.pid}-${Date.now()}`;
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: testSessionId, project_id: project.id }),
  });
  if (!sessionResponse.ok) {
    console.error('create isolated model test session failed', sessionResponse.status, await sessionResponse.text());
    process.exit(1);
  }
  const chat = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQR-Session': testSessionId },
    body: JSON.stringify({ message: 'hi', model: llm.id, attachments: [] }),
  });
  const chatData = await chat.json();
  if (!chat.ok || !String(chatData.content).includes('test-tiny.gguf')) {
    console.error('chat local model failed', chatData);
    process.exit(1);
  }

  const picker = await fetch(`http://127.0.0.1:${port}/models/picker`).then((r) => r.json());
  const { loadCurateConfig } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'remote-model-curate.js')).href
  );
  // matrix_only curation ships the workspace matrix only, so local GGUF entries are
  // deliberately absent from the picker even while they stay the persisted default.
  const matrixOnly = loadCurateConfig().matrix_only === true;
  const listsLocal = picker.options?.some((o) => o.value === llm.id);
  if (matrixOnly) {
    if (listsLocal) {
      console.error('picker leaked local model under matrix_only curation', picker);
      process.exit(1);
    }
    if (picker.default_llm_id !== llm.id) {
      console.error('picker lost local default under matrix_only curation', picker);
      process.exit(1);
    }
  } else if (!listsLocal) {
    console.error('picker missing model', picker);
    process.exit(1);
  }

  // upload second tiny gguf
  const boundary = '----cqrboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="upload-test.gguf"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    'GGUF' +
    '\0'.repeat(512) +
    `\r\n--${boundary}--\r\n`;
  const upload = await fetch(`http://127.0.0.1:${port}/models/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const upData = await upload.json();
  if (!upload.ok || !upData.models?.length) {
    console.error('upload failed', upload.status, upData);
    process.exit(1);
  }

  console.log('verify-models OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(lic)) unlinkSync(lic);
  if (existsSync(fakeGguf)) unlinkSync(fakeGguf);
  const uploaded = path.join(llmDir, 'upload-test.gguf');
  if (existsSync(uploaded)) unlinkSync(uploaded);
}
