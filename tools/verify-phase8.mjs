import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  existsSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();
const vault = path.join(root, 'data', 'vault');
const licPath = path.join(vault, 'license.ocx');
const keysPath = path.join(vault, 'provider-keys.json');
const bundlePath = path.join(vault, 'keys-bundle.enc');
const rootLic = path.join(root, 'license.ocx');
const rootBundle = path.join(root, 'keys-bundle.enc');
const activation = path.join(vault, 'activation.json');
const testLic = path.join(vault, 'license-p8test.ocx');
const testBundle = path.join(vault, 'keys-bundle-p8test.enc');
const wrongLic = path.join(vault, 'license-wrong-user.ocx');

for (const f of [
  licPath,
  keysPath,
  bundlePath,
  rootLic,
  rootBundle,
  activation,
  testLic,
  testBundle,
  wrongLic,
]) {
  if (existsSync(f)) unlinkSync(f);
}

process.env.MY_AGENT_ROOT = root;
// This step verifies the manual license/bundle import flow, so central auto-activation
// must stay off even when deploy-defaults points at a reachable activation server.
process.env.CQR_ACTIVATION_SERVER_URL = 'off';
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(1);

const port = 10296;
const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const srv = await createApiServer(port);
await new Promise((r) => srv.listen(port, '127.0.0.1', r));

try {
  const base = `http://127.0.0.1:${port}`;

  const who = await fetch(`${base}/setup/windows-user`).then((r) => r.json());
  if (!who.windows_user) throw new Error('windows_user missing');

  const privPath = path.join(root, 'tools', 'keys', 'license-private.pem');

  const issue = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools', 'cqr-admin.mjs'),
      'issue',
      '--org',
      'p8test',
      '--user',
      who.windows_user,
      '--out',
      testLic,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (issue.status !== 0) {
    console.error(issue.stderr || issue.stdout);
    throw new Error('issue failed');
  }

  spawnSync(
    process.execPath,
    [
      path.join(root, 'tools', 'cqr-admin.mjs'),
      'bundle-keys',
      '--org',
      'p8test',
      '--out',
      testBundle,
    ],
    { cwd: root, encoding: 'utf8' },
  );

  let st = await fetch(`${base}/setup/status`).then((r) => r.json());
  if (!st.needs_license) throw new Error('expected needs_license');

  const tmpLic = path.join(tmpdir(), `my-agent-license-path-${process.pid}.ocx`);
  copyFileSync(testLic, tmpLic);
  try {
    const pathRes = await fetch(`${base}/setup/import-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_path: tmpLic }),
    });
    if (!pathRes.ok) throw new Error(`import-license path: ${JSON.stringify(await pathRes.json())}`);
  } finally {
    if (existsSync(tmpLic)) unlinkSync(tmpLic);
  }

  st = await fetch(`${base}/setup/status`).then((r) => r.json());
  if (st.needs_license) throw new Error('license still needed after path import');

  const licRaw = readFileSync(testLic, 'utf8');
  const licForm = new FormData();
  licForm.append('license', new Blob([licRaw], { type: 'application/json' }), 'license.ocx');
  const licRes = await fetch(`${base}/setup/import-license`, { method: 'POST', body: licForm });
  if (!licRes.ok) throw new Error(`import-license: ${JSON.stringify(await licRes.json())}`);

  st = await fetch(`${base}/setup/status`).then((r) => r.json());
  if (st.needs_license) throw new Error('license still needed');

  if (!st.keys_configured) {
    const bundleForm = new FormData();
    bundleForm.append('bundle', new Blob([readFileSync(testBundle, 'utf8')]), 'keys-bundle.enc');
    const bRes = await fetch(`${base}/setup/import-bundle`, { method: 'POST', body: bundleForm });
    const bBody = await bRes.json();
    if (!bRes.ok) throw new Error(`import-bundle: ${JSON.stringify(bBody)}`);
  }

  const wrongIssue = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools', 'cqr-admin.mjs'),
      'issue',
      '--org',
      'p8test',
      '--user',
      'OTHERDOMAIN\\otheruser',
      '--out',
      wrongLic,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (wrongIssue.status !== 0) throw new Error('wrong-user issue failed');
  const wrongForm = new FormData();
  wrongForm.append('license', new Blob([readFileSync(wrongLic, 'utf8')]), 'wrong.ocx');
  const badRes = await fetch(`${base}/setup/import-license`, { method: 'POST', body: wrongForm });
  if (badRes.status !== 403) throw new Error(`wrong user should 403, got ${badRes.status}`);

  await new Promise((r) => srv.close(r));

  if (existsSync(licPath)) unlinkSync(licPath);
  if (existsSync(keysPath)) unlinkSync(keysPath);
  if (existsSync(activation)) unlinkSync(activation);
  copyFileSync(testLic, rootLic);
  copyFileSync(testBundle, rootBundle);

  const srv2 = await createApiServer(10295);
  await new Promise((r) => srv2.listen(10295, '127.0.0.1', r));
  const st2 = await fetch('http://127.0.0.1:10295/setup/status').then((r) => r.json());
  const prov2 = await fetch('http://127.0.0.1:10295/providers').then((r) => r.json());
  await new Promise((r) => srv2.close(r));

  if (st2.needs_license) throw new Error('auto-import license from root failed');
  if (!prov2.providers?.find((p) => p.id === 'ollama')?.configured) {
    throw new Error('auto-import bundle failed');
  }

  const gateUi = readFileSync(path.join(root, 'ui', 'workspace', 'src', 'components', 'LicenseGate.tsx'), 'utf8');
  const panelUi = readFileSync(path.join(root, 'ui', 'workspace', 'src', 'components', 'LicenseImportPanel.tsx'), 'utf8');
  const settingsUi = readFileSync(path.join(root, 'ui', 'workspace', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  const shellUi = readFileSync(path.join(root, 'shell', 'CqrPa.Shell', 'MainWindow.xaml.cs'), 'utf8');
  if (!gateUi.includes('data-testid="license-gate"')) throw new Error('LicenseGate missing test id');
  if (gateUi.includes('data\\vault') || gateUi.includes('data/vault')) {
    throw new Error('LicenseGate must not mention vault paths');
  }
  if (gateUi.includes('사내 서버에서 라이선스와 키를 받는 중입니다.')) {
    throw new Error('LicenseGate must not wait on a LAN activation server');
  }
  if (!panelUi.includes("purpose: 'licenseFile'")) throw new Error('license file picker purpose missing');
  if (!panelUi.includes('importLicensePath')) throw new Error('license path import missing');
  if (!settingsUi.includes('settings-nav-license')) throw new Error('settings license page missing');
  if (!shellUi.includes('licenseFile')) throw new Error('shell license picker missing');

  console.log('verify-phase8 OK');
} finally {
  await new Promise((r) => srv.close(r)).catch(() => {});
  for (const f of [
    licPath,
    keysPath,
    bundlePath,
    rootLic,
    rootBundle,
    activation,
    testLic,
    testBundle,
    wrongLic,
  ]) {
    if (existsSync(f)) unlinkSync(f);
  }
}
