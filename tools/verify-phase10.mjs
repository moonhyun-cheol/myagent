import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  existsSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpInstall = path.join(root, 'deploy', 'output', 'p10-test-install');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(process.execPath, [path.join(root, 'tools', 'build.mjs')]);

const emb = spawnSync(process.execPath, [path.join(root, 'tools', 'embed-portable-node.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (emb.status !== 0) process.exit(1);
const nodeExe = path.join(root, 'runtime', 'node', 'node.exe');
if (!existsSync(nodeExe)) {
  console.error('verify-phase10: embedded node missing');
  process.exit(1);
}

run(
  process.execPath,
  [path.join(root, 'tools', 'publish-delta.mjs')],
  { env: { ...process.env, MY_AGENT_SECURE_UPDATE: '1' } },
);
const deltaList = readFileSync(path.join(root, 'deploy', 'output', 'LATEST_DELTA_ZIP.txt'), 'utf8').trim();
if (!existsSync(deltaList)) {
  console.error('verify-phase10: delta zip missing');
  process.exit(1);
}

if (existsSync(tmpInstall)) rmSync(tmpInstall, { recursive: true, force: true });
mkdirSync(tmpInstall, { recursive: true });
mkdirSync(path.join(tmpInstall, 'core', 'dist'), { recursive: true });
mkdirSync(path.join(tmpInstall, 'data', 'vault'), { recursive: true });
writeFileSync(path.join(tmpInstall, 'data', 'vault', 'keep-me.txt'), 'user-data-marker', 'utf8');
writeFileSync(
  path.join(tmpInstall, 'manifest.json'),
  JSON.stringify({ name: 'MY Agent', version: '0.0.1-test' }, null, 2),
  'utf8',
);

const apply = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'tools', 'update', 'apply-delta.ps1'),
    '-Root',
    tmpInstall,
    '-ZipPath',
    deltaList,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, MY_AGENT_UPDATE_SKIP_OPTIONAL: '1' },
  },
);
if (apply.status !== 0) process.exit(1);

if (!existsSync(path.join(tmpInstall, 'data', 'vault', 'keep-me.txt'))) {
  console.error('verify-phase10: data/ not preserved');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(path.join(tmpInstall, 'manifest.json'), 'utf8'));
if (!manifest.version || manifest.version === '0.0.1-test') {
  console.error('verify-phase10: manifest not updated');
  process.exit(1);
}
if (!existsSync(path.join(tmpInstall, 'core', 'dist', 'main.js'))) {
  console.error('verify-phase10: core/dist missing after delta');
  process.exit(1);
}
if (!existsSync(path.join(tmpInstall, 'core', 'config', 'defaults', 'deploy-defaults.json'))) {
  console.error('verify-phase10: core/config/defaults missing after delta');
  process.exit(1);
}
const distDefaults = path.join(tmpInstall, 'core', 'dist', 'config', 'defaults', 'deploy-defaults.json');
if (!existsSync(distDefaults)) {
  console.error('verify-phase10: core/dist/config/defaults missing after delta');
  process.exit(1);
}
const manifestVer = manifest.version;
const rulebookGen = path.join(tmpInstall, 'rulebook', 'docs', 'generated');
if (!existsSync(rulebookGen)) {
  console.error('verify-phase10: rulebook/docs/generated missing after delta');
  process.exit(1);
}
const genFiles = readdirSync(rulebookGen).filter((f) => f.startsWith('RULEBOOK_MY_AGENT_MAIN_v'));
if (genFiles.length === 0 || !genFiles.some((f) => f.includes(manifestVer))) {
  console.error('verify-phase10: generated rulebook not synced to manifest version');
  process.exit(1);
}
if (!existsSync(path.join(root, 'deploy', 'output', 'delta-stage', 'update-payload.json'))) {
  console.error('verify-phase10: signed update-payload.json missing after secure delta');
  process.exit(1);
}
if (existsSync(path.join(tmpInstall, 'modules', 'organization'))) {
  console.error('verify-phase10: neutral core delta must not contain organization modules');
  process.exit(1);
}
if (!existsSync(path.join(tmpInstall, 'tools', 'bootstrap-ffmpeg.ps1'))) {
  console.error('verify-phase10: tools/bootstrap-ffmpeg.ps1 missing after delta');
  process.exit(1);
}
if (!existsSync(path.join(tmpInstall, 'tools', 'bootstrap-oss-sidecars.ps1'))) {
  console.error('verify-phase10: tools/bootstrap-oss-sidecars.ps1 missing after delta');
  process.exit(1);
}
if (!existsSync(path.join(tmpInstall, 'tools', 'bootstrap-oss-sidecars-if-needed.ps1'))) {
  console.error('verify-phase10: tools/bootstrap-oss-sidecars-if-needed.ps1 missing after delta');
  process.exit(1);
}
if (!existsSync(path.join(tmpInstall, 'core', 'config', 'defaults', 'user-mcp-servers.default.json'))) {
  console.error('verify-phase10: user-mcp-servers.default.json missing after delta');
  process.exit(1);
}

process.env.MY_AGENT_ROOT = root;
const port = 10293;
const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);
const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

try {
  const diag = await fetch(`http://127.0.0.1:${port}/admin/diagnostics`).then((r) => r.json());
  if (diag.product !== 'MY Agent' || !diag.version) {
    throw new Error('diagnostics invalid');
  }
  if (!existsSync(path.join(root, 'logs', 'api-start.log'))) {
    throw new Error('api-start.log missing');
  }
  console.log('verify-phase10 OK');
} finally {
  await new Promise((r) => srv.close(r));
  if (existsSync(tmpInstall)) rmSync(tmpInstall, { recursive: true, force: true });
}
