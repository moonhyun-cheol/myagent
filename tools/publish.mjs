#!/usr/bin/env node
/**
 * Build the neutral product install zip (no secrets, user data, or organization modules).
 * Usage: node tools/publish.mjs [--no-node] [--node-mode=bundled|deferred]
 */
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const stageDir = path.join(outDir, 'stage');
const appDir = path.join(stageDir, 'app');
const skipNodeFlag = process.argv.includes('--no-node');
const nodeModeArg = process.argv.find((a) => a.startsWith('--node-mode='));
const nodeMode = nodeModeArg?.split('=')[1] ?? 'bundled';
if (nodeMode !== 'bundled' && nodeMode !== 'deferred') {
  console.error('publish: --node-mode must be bundled or deferred');
  process.exit(1);
}
const nodeDeferred = nodeMode === 'deferred';
const skipNode = skipNodeFlag || nodeDeferred;
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const ver = manifest.version ?? '1.0.0';

const norm = spawnSync(
  process.execPath,
  [path.join(root, 'tools', 'normalize-encoding.mjs'), '--target', 'source'],
  { cwd: root, stdio: 'inherit' },
);
if (norm.status !== 0) process.exit(norm.status ?? 1);

{
  const installUi = readFileSync(path.join(root, 'tools/install/install-ui.ps1'), 'utf8');
  for (const m of installUi.matchAll(/-match\s+'([^']*)'/g)) {
    if (/[^\x00-\x7F]/.test(m[1])) {
      console.error(
        'publish: install-ui.ps1 -match must be ASCII-only (PowerShell 5.1 no-BOM Korean regex crash)',
      );
      process.exit(1);
    }
  }
}

import { checkDeployParity } from './deploy-parity.mjs';
import { publishShell } from './shell-publish.mjs';
import { publishUpdater } from './updater-publish.mjs';

const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const parity = checkDeployParity(root);
for (const w of parity.warnings) console.warn(`publish parity WARN: ${w}`);
if (!parity.ok) {
  for (const e of parity.errors) console.error(`publish parity FAIL: ${e}`);
  console.error('publish aborted — fix deploy parity (policy.json, deploy-defaults, license.ocx.example)');
  process.exit(1);
}
console.log('publish: deploy parity OK (dev test === activation features)');

if (nodeDeferred) {
  console.log('publish: deferred node mode — runtime/node created at install (nodejs.org required)');
} else if (!skipNode) {
  const emb = spawnSync(process.execPath, [path.join(root, 'tools', 'embed-portable-node.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (emb.status !== 0) process.exit(emb.status ?? 1);
}

const skipDirs = new Set([
  '.git',
  'node_modules',
  'logs',
  'deploy',
  'stage',
  '.cursor',
  // Dev scratch — previously shipped ~340 MB into slim zip (gitignored, copyTree did not skip).
  '.tmp',
  'test-results',
  '.my_agent_remote',
]);

/**
 * Matched at every path depth, not just the first segment: `skipDirs` only
 * checked the top-level name, so `ui/workspace/node_modules` shipped 223 MB of
 * dev dependencies (monaco-editor, typescript, oxlint) inside the install zip.
 * The app only needs the built `ui/workspace/dist`.
 */
const skipAnySegment = new Set([
  'node_modules',
  '.git',
  '.github',
  '.cursor',
  '.build',
  '.tmp',
  '__pycache__',
]);
const skipExactFiles = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  'PORT.md',
  'repo-target.json',
]);
const skipRelPrefixes = [
  'tools/keys',
  'tools/cache',
  'runtime/node',
  'runtime/pipeline-venv',
  'runtime/python-embed',
  'runtime/playwright',
  // Video keyframes bootstrap at install/first-run (tools/bootstrap-ffmpeg.ps1).
  // Shipping the essentials build added ~194 MB and dominated slim zip size.
  'runtime/ffmpeg',
  // Portable OSS sidecars (markitdown/repomix/ast-grep) — install/START/UPDATE bootstrap.
  'runtime/oss-sidecars',
  'bin/my-agent',
  '.github',
  '.build',
  'activation-server',
];

/**
 * The only `data/` files that ship — everything else there is runtime state and
 * the empty dirs are recreated below. Copying the live tree shipped the dev's
 * `data/vault/.verify-backup/provider-keys.json`, sessions and audit logs, and
 * the nested `data/agent-checkpoints` snapshots pushed paths past the 260-char
 * `Compress-Archive` limit, so the install zip silently failed to build.
 */
const dataAllowlist = new Set([
  'data/_model_bakeoff/summary.json',
  'data/owui-models-snapshot.json',
  'data/vault/.gitkeep',
  'data/vault/license.ocx.example',
  'data/config/user-mcp-servers.example.json',
]);

function shouldCopyData(norm) {
  if (dataAllowlist.has(norm)) return true;
  // Still descend into the directories that lead to an allowlisted file.
  for (const keep of dataAllowlist) {
    if (keep.startsWith(`${norm}/`)) return true;
  }
  return false;
}

function shouldCopy(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (norm === 'install.bat' || norm === 'tools/install/install.bat') return false;
  if (norm.includes('tools/test-')) return false;
  const parts = norm.split('/');
  const base = parts[parts.length - 1];
  if (skipExactFiles.has(base)) return false;
  if (base.endsWith('.tsbuildinfo')) return false;
  if (parts.some((seg) => skipAnySegment.has(seg))) return false;
  const top = parts[0];
  if (skipDirs.has(top)) return false;
  if (top === 'data') return shouldCopyData(norm);
  for (const p of skipRelPrefixes) {
    if (norm === p || norm.startsWith(p + '/')) return false;
  }
  return true;
}

function copyTree(src, dst, base = '') {
  for (const name of readdirSync(src)) {
    const rel = base ? `${base}/${name}` : name;
    if (!shouldCopy(rel)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d, rel);
    } else {
      mkdirSync(path.dirname(d), { recursive: true });
      cpSync(s, d);
    }
  }
}

if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
copyTree(root, appDir);

// runtime/node is in skipRelPrefixes (avoid copying while embed runs / size control);
// bundled mode must still ship node.exe into the stage explicitly.
if (!skipNode && !nodeDeferred) {
  const nodeSrc = path.join(root, 'runtime', 'node');
  const nodeExe = path.join(nodeSrc, 'node.exe');
  const nodeDst = path.join(appDir, 'runtime', 'node');
  if (!existsSync(nodeExe)) {
    console.error('publish: runtime/node/node.exe missing (run embed-portable-node)');
    process.exit(1);
  }
  mkdirSync(path.dirname(nodeDst), { recursive: true });
  if (existsSync(nodeDst)) rmSync(nodeDst, { recursive: true, force: true });
  cpSync(nodeSrc, nodeDst, { recursive: true });
  console.log('publish: bundled runtime/node -> stage');
}

const deployDefaultsPath = path.join(appDir, 'core', 'config', 'defaults', 'deploy-defaults.json');
let bundleOrg = process.env.MY_AGENT_BUNDLE_ORG ?? 'myorg';
const policyPath = path.join(root, 'activation-server', 'policy.json');
if (existsSync(policyPath)) {
  try {
    bundleOrg = JSON.parse(readFileSync(policyPath, 'utf8')).org_id ?? bundleOrg;
  } catch {
    /* ignore */
  }
}

if (existsSync(deployDefaultsPath)) {
  const deployDoc = JSON.parse(readFileSync(deployDefaultsPath, 'utf8'));
  deployDoc.note = 'Neutral core bundle. Install organization modules through their independent signed update stream.';
  writeFileSync(deployDefaultsPath, JSON.stringify(deployDoc, null, 2) + '\n', 'utf8');
}

const defaultBundlePath = path.join(appDir, 'core', 'config', 'defaults', 'keys-bundle.default.enc');
const bundle = spawnSync(
  process.execPath,
  [
    path.join(root, 'tools', 'cqr-admin.mjs'),
    'bundle-keys',
    '--org',
    bundleOrg,
    '--out',
    defaultBundlePath,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (bundle.status !== 0) process.exit(bundle.status ?? 1);

const actBundleDir = path.join(root, 'activation-server');
mkdirSync(actBundleDir, { recursive: true });
cpSync(defaultBundlePath, path.join(actBundleDir, 'keys-bundle.enc'));
console.log(`publish: synced non-secret local-provider bundle -> activation-server/ (org=${bundleOrg})`);

const shellProj = path.join(appDir, 'shell', 'CqrPa.Shell', 'CqrPa.Shell.csproj');
const shellOut = path.join(appDir, 'bin', 'my-agent');
if (existsSync(shellProj)) {
  const shell = publishShell({
    // Repo root — not stage/app. Using appDir put NuGet + dotnet-cli (~340 MB) into the zip.
    root,
    projPath: shellProj,
    outDir: shellOut,
    label: 'publish',
  });
  if (!shell.ok) {
    console.error(shell.reason);
    process.exit(1);
  }
  const publishedExe = path.join(shellOut, 'MYAgent.exe');
  const productExe = path.join(appDir, 'MYAgent.exe');
  if (!existsSync(publishedExe)) {
    console.error(`publish: shell executable missing after publish: ${publishedExe}`);
    process.exit(1);
  }
  cpSync(publishedExe, productExe);
  console.log('publish: single user entry -> app/MYAgent.exe');
  // Drop Debug/Release/obj trees left by the publish build — the runnable
  // binary is already in bin/my-agent; shipping shell/**/bin added megabytes of
  // duplicate WebView2 XML/DLL and inflated the slim install zip.
  for (const junk of ['bin', 'obj']) {
    const junkPath = path.join(appDir, 'shell', 'CqrPa.Shell', junk);
    if (existsSync(junkPath)) rmSync(junkPath, { recursive: true, force: true });
  }
  // Slim: MYAgent.exe is the entry. bin/my-agent is the same self-contained publish (~70 MB extra).
  if (nodeDeferred) {
    const dupBin = path.join(appDir, 'bin');
    if (existsSync(dupBin)) rmSync(dupBin, { recursive: true, force: true });
    console.log('publish: slim — dropped duplicate bin/my-agent');
  }
}

const updater = publishUpdater({
  root,
  outDir: path.join(root, 'bin', 'my-agent-updater'),
  label: 'publish',
});
if (!updater.ok) {
  console.error(updater.reason);
  process.exit(1);
}
cpSync(updater.executable, path.join(appDir, 'MYAgent.Updater.exe'));
console.log('publish: update helper -> app/MYAgent.Updater.exe');

const stagedTmp = path.join(appDir, '.tmp');
if (existsSync(stagedTmp)) {
  rmSync(stagedTmp, { recursive: true, force: true });
  console.log('publish: dropped stage .tmp (dotnet/nuget cache)');
}

for (const sub of [
  'data/vault',
  'data/config',
  'data/sessions',
  'data/models/llm',
  'data/attachments',
  'data/outputs/images',
  'data/outputs/research',
]) {
  mkdirSync(path.join(appDir, ...sub.split('/')), { recursive: true });
}

writeFileSync(
  path.join(appDir, 'data', 'vault', '.gitkeep'),
  '# license.ocx / keys-bundle.enc — tools/commands/setup-vault.bat 또는 앱 초기 설정\n',
);

writeFileSync(path.join(appDir, 'VERSION.txt'), `MY Agent v${ver}\n`, 'utf8');

const readme = `MY Agent v${ver}
============

zip 구조: install.bat (루트) + app\\ (본체)

1. install.bat — 설치 폴더 선택 · 바탕화면 바로가기
2. MYAgent.exe — 앱 실행 (사용자 시작점)

설치 후 채팅·범용 스킬·브라우저 자동화·심층리서치를 사용할 수 있습니다.

업데이트: UPDATE.bat (delta zip, data/ 보존)
관리자 명령: tools\commands\

Node: ${
  skipNode
    ? nodeDeferred
      ? 'install 시 nodejs.org 에서 다운로드 (인터넷 필요)'
      : '이번 빌드: 미포함'
    : 'runtime/node/node.exe 포함'
}
Ollama: keys-bundle.default.enc (활성화 시 자동 적용 · org=${bundleOrg})
조직 전용 기능: 별도의 서명된 모듈 업데이트로 설치

install 시 필수 다운로드 (인터넷 필요 · 모든 PC 동일 런타임 경험 · 토큰/유료키 불필요):
  · runtime/node — Node.js
  · runtime/ffmpeg — 영상 첨부 키프레임
  · runtime/playwright/browsers — web_dev 브라우저 도구 (Chromium)
  · runtime/oss-sidecars — markitdown / repomix / ast-grep

토큰·유료 API 키가 있어야만 되는 기능은 제품 기본 경로에 넣지 않음 (설치 시 자동 발급되는 org 번들만 예외).

옵션 (zip 미포함 · 수동 drop-in):
  · runtime/llama-cpp/llama-server.exe — 로컬 GGUF 추론
  · runtime/sd-cpp/sd.exe — 로컬 Stable Diffusion 이미지

관리자: docs/DEPLOY.md — 활성화 서버 + allowlist
`;
writeFileSync(path.join(appDir, 'README-설치.txt'), readme, 'utf8');
cpSync(path.join(root, 'tools', 'install', 'install.bat'), path.join(stageDir, 'install.bat'));
writeFileSync(
  path.join(stageDir, 'README-설치.txt'),
  [
    `MY Agent v${ver} — first install`,
    '',
    'Use this zip: MYAgent-v*-install.zip',
    'Do not use GitHub "Source code (zip)" (no MYAgent.exe, includes .github).',
    'Do not use MYAgent-v*-delta.zip here (that file is for in-app / UPDATE.bat updates).',
    '',
    '1. Run install.bat (do not run as administrator).',
    '2. After install, launch MYAgent.exe from the install folder or the desktop shortcut.',
    '   Extracted zip root has install.bat + app\\ ; the exe is inside app\\ until install.bat copies it.',
    '',
  ].join('\n'),
  'utf8',
);
const koreanInstall = path.join(root, '설치.bat');
if (existsSync(koreanInstall)) {
  cpSync(koreanInstall, path.join(stageDir, '설치.bat'));
}

mkdirSync(outDir, { recursive: true });
const slimZip = nodeDeferred;
const zipName = slimZip
  ? `MYAgent-v${ver}-install-slim.zip`
  : `MYAgent-v${ver}-install.zip`;
const zipPath = path.join(outDir, zipName);

if (process.platform === 'win32') {
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (ps.status !== 0) process.exit(ps.status ?? 1);
  // Compress-Archive can throw (long paths, vanished dirs) and still exit 0,
  // which previously printed "Published ->" for a zip that was never written.
  if (!existsSync(zipPath)) {
    console.error(
      `publish zip FAILED: ${zipPath} was not created. `
      + 'Check Compress-Archive errors above (paths over 260 chars are the usual cause).',
    );
    process.exit(1);
  }
} else {
  console.error('publish zip: Windows Compress-Archive required');
  process.exit(1);
}

if (slimZip) {
  writeFileSync(path.join(outDir, 'LATEST_SLIM_INSTALL_ZIP.txt'), zipPath + '\n');
} else {
  writeFileSync(path.join(outDir, 'LATEST_INSTALL_ZIP.txt'), zipPath + '\n');
}

const verifyArgs = [
  path.join(root, 'tools', 'verify-publish-bundle.mjs'),
  '--app-dir',
  appDir,
];
if (skipNode) verifyArgs.push('--no-node');
if (nodeDeferred) verifyArgs.push('--node-mode=deferred');
const verify = spawnSync(process.execPath, verifyArgs, { cwd: root, stdio: 'inherit' });
if (verify.status !== 0) process.exit(verify.status ?? 1);

console.log('Published ->', zipPath);
