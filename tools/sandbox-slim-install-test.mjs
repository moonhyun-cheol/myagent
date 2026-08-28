#!/usr/bin/env node
/**
 * Sandbox install test for slim (deferred) install zip.
 * 1) Prefer deploy/output/LATEST_SLIM_INSTALL_ZIP.txt (or publish slim first)
 * 2) Extract → install.ps1 into deploy/output/sandbox-slim-install
 * 3) Assert core/runtime markers (Node + pipeline; optional Playwright/ffmpeg if --with-optional)
 *
 * Usage:
 *   node tools/sandbox-slim-install-test.mjs
 *   node tools/sandbox-slim-install-test.mjs --with-optional   # Playwright + ffmpeg
 *   node tools/sandbox-slim-install-test.mjs --publish   # build slim zip first
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const sandboxRoot = path.join(
  process.env.TEMP || process.env.TMP || outDir,
  `cqr-sandbox-slim-${process.pid}`,
);
const extractDir = path.join(sandboxRoot, 'extract');
const installDir = path.join(sandboxRoot, 'install');
const wantPublish = process.argv.includes('--publish');
const withOptional = process.argv.includes('--with-optional');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
    ...opts,
  });
  if ((r.status ?? 1) !== 0) {
    fail(`${cmd} ${args.join(' ')} exit ${r.status}`);
  }
  return r;
}

if (wantPublish) {
  console.log('--- publish slim zip ---');
  run(process.execPath, [
    path.join(root, 'tools/publish.mjs'),
    '--node-mode=deferred',
    '--venv-mode=deferred',
  ]);
}

const slimPtr = path.join(outDir, 'LATEST_SLIM_INSTALL_ZIP.txt');
let zipPath = existsSync(slimPtr) ? readFileSync(slimPtr, 'utf8').trim() : '';
if (!zipPath || !existsSync(zipPath)) {
  const ver = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  const guess = path.join(outDir, `MYAgent-v${ver}-install-slim.zip`);
  if (existsSync(guess)) zipPath = guess;
}
if (!zipPath || !existsSync(zipPath)) {
  fail('slim zip missing — run: node tools/publish.mjs --node-mode=deferred --venv-mode=deferred');
}
ok(`slim zip ${zipPath} (${(statSync(zipPath).size / 1e6).toFixed(1)} MB)`);

for (const d of [extractDir, installDir]) {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}
mkdirSync(sandboxRoot, { recursive: true });
ok(`sandbox root ${sandboxRoot}`);

run('powershell', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
]);

const appSrc = existsSync(path.join(extractDir, 'app', 'core', 'dist', 'main.js'))
  ? path.join(extractDir, 'app')
  : existsSync(path.join(extractDir, 'core', 'dist', 'main.js'))
    ? extractDir
    : null;
if (!appSrc) fail('zip layout: neither app/core/dist/main.js nor core/dist/main.js');
ok(`extract layout source=${path.relative(extractDir, appSrc) || '.'}`);

if (existsSync(path.join(appSrc, 'runtime', 'node', 'node.exe'))) {
  fail('slim zip must NOT ship runtime/node/node.exe (deferred)');
}
ok('slim zip has no bundled node.exe');

const installPs1 = path.join(appSrc, 'tools', 'install', 'install.ps1');
if (!existsSync(installPs1)) fail(`missing ${installPs1}`);

console.log(
  `--- install.ps1 (sandbox)${withOptional ? ' + Playwright/ffmpeg' : ' skip optional'} ---`,
);
const installEnv = {
  ...process.env,
  MY_AGENT_INSTALL_TARGET: installDir,
};
if (!withOptional) {
  installEnv.MY_AGENT_INSTALL_SKIP_OPTIONAL = '1';
} else {
  delete installEnv.MY_AGENT_INSTALL_SKIP_OPTIONAL;
}

run(
  'powershell',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    installPs1,
    '-SourceDir',
    appSrc,
    '-TargetDir',
    installDir,
  ],
  {
    env: installEnv,
  },
);

const checks = [
  ['core/dist/main.js', true],
  ['ui/workspace/dist/index.html', true],
  ['MYAgent.exe', true],
  ['INSTALL-DONE.txt', true],
  ['runtime/node/node.exe', true],
  ['modules/organization', false],
  ['bin/cqr-pa/cqr-pa.exe', false],
  ['runtime/pipeline-venv/Scripts/python.exe', false],
];
if (withOptional) {
  checks.push(
    ['runtime/ffmpeg/ffmpeg.exe', true],
    ['runtime/playwright/browsers/.chromium-installed', true],
    ['node_modules/playwright/package.json', true],
  );
}

for (const [rel, required] of checks) {
  const p = path.join(installDir, rel);
  if (!existsSync(p)) {
    if (required) fail(`after install missing ${rel}`);
    console.log(`SKIP optional missing: ${rel}`);
  } else {
    ok(rel);
  }
}

// Smoke: portable node can run core entry
const nodeExe = path.join(installDir, 'runtime', 'node', 'node.exe');
const smoke = spawnSync(nodeExe, ['-e', "console.log('node-ok', process.version)"], {
  cwd: installDir,
  encoding: 'utf8',
});
if (smoke.status !== 0) fail(`portable node smoke failed: ${smoke.stderr || smoke.stdout}`);
ok(`portable node ${String(smoke.stdout || '').trim()}`);

if (withOptional) {
  const ffmpegExe = path.join(installDir, 'runtime', 'ffmpeg', 'ffmpeg.exe');
  const ff = spawnSync(ffmpegExe, ['-version'], { encoding: 'utf8', timeout: 30_000 });
  if (ff.status !== 0) fail(`ffmpeg -version failed: ${ff.stderr || ff.stdout}`);
  const first = String(ff.stdout || '').split(/\r?\n/)[0] || '';
  ok(`ffmpeg ${first.slice(0, 80)}`);

  const nodeExe2 = path.join(installDir, 'runtime', 'node', 'node.exe');
  // Prefer install-tree playwright if present
  const pwCli = path.join(installDir, 'node_modules', 'playwright', 'cli.js');
  if (existsSync(pwCli)) {
    const pw = spawnSync(
      nodeExe2,
      [pwCli, '--version'],
      { cwd: installDir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(installDir, 'runtime', 'playwright', 'browsers') } },
    );
    if (pw.status !== 0) {
      console.warn(`WARN playwright --version: ${pw.stderr || pw.stdout}`);
    } else {
      ok(`playwright ${String(pw.stdout || '').trim()}`);
    }
  }
  const chromiumDir = path.join(installDir, 'runtime', 'playwright', 'browsers');
  if (!existsSync(chromiumDir)) fail('runtime/playwright/browsers missing');
  ok(`playwright browsers root present`);
}

const summary = {
  ok: true,
  zip: zipPath,
  zip_mb: Number((statSync(zipPath).size / 1e6).toFixed(1)),
  extract: extractDir,
  install: installDir,
  skip_optional: !withOptional,
  with_optional: withOptional,
};
writeFileSync(
  path.join(outDir, 'sandbox-slim-install-result.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
);
console.log('sandbox-slim-install-test: OK');
console.log(JSON.stringify(summary, null, 2));
