import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { REQUIRED_LICENSE_FEATURES } from './deploy-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { guardUserVault } = await import('./verify-vault-backup.mjs');
guardUserVault();
const vault = path.join(root, 'data', 'vault');
const licPath = path.join(vault, 'license.ocx');
const keysPath = path.join(vault, 'provider-keys.json');
const bundlePath = path.join(vault, 'keys-bundle.enc');
const activation = path.join(vault, 'activation.json');

for (const f of [licPath, keysPath, bundlePath, activation]) {
  if (existsSync(f)) unlinkSync(f);
}

process.env.MY_AGENT_ROOT = root;
process.env.MY_AGENT_LICENSE_ENFORCEMENT = '1';
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(1);

const format = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'license', 'license-format.js')).href
);
const crypto = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'license', 'license-crypto.js')).href
);
const win = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'license', 'windows-user-id.js')).href
);
const machineMod = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'license', 'machine-id.js')).href
);
const bundle = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'key-bundle.js')).href
);

const who = win.computeWindowsUserId();
const machineId = machineMod.computeMachineId(root);
const priv = readFileSync(path.join(root, 'tools', 'keys', 'license-private.pem'), 'utf8');
const UNLIMITED = '2099-12-31T23:59:59.000Z';

function issueLicense(userId, mid) {
  const now = new Date();
  const payload = {
    v: 1,
    org_id: 'p11test',
    features: [...REQUIRED_LICENSE_FEATURES],
    issued_at: now.toISOString(),
    expires_at: UNLIMITED,
    machine_hint: mid,
    user_hint: win.normalizeUserHint(userId),
    nonce: randomUUID(),
  };
  const sig = crypto.signLicensePayload(payload, priv);
  return format.serializeLicense(format.buildSignedLicense(payload, sig));
}

const { buildDefaultBundlePayload } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'default-bundle-payload.js')).href
);
const keysBundle = bundle.encryptBundle(
  buildDefaultBundlePayload({
    orgId: 'p11test',
    cqrRoot: root,
    defaultProviderId: 'ollama',
    requireOpenWebUi: false,
  }),
);

const actPort = 10291;

const actSrv = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${actPort}`);
  if (req.method === 'POST' && url.pathname === '/v1/activate') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const user = win.normalizeUserHint(body.windows_user);
    const mid = String(body.machine_id ?? '');
    if (!mid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'MACHINE_REQUIRED' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        license: issueLicense(user, mid),
        keys_bundle: keysBundle,
        org_id: 'p11test',
        expires_at: UNLIMITED,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((r) => actSrv.listen(actPort, '127.0.0.1', r));

async function waitForCentralActivation(base, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetch(`${base}/setup/status`).then((r) => r.json());
    if (!last.needs_license && last.license_mode === 'full' && last.keys_configured) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `central activation timed out: ${JSON.stringify({
      license_mode: last?.license_mode,
      needs_license: last?.needs_license,
      keys_configured: last?.keys_configured,
      activation_error: last?.activation_error,
    })}`,
  );
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const apiPort = 10292;
process.env.CQR_ACTIVATION_SERVER_URL = `http://127.0.0.1:${actPort}`;

const { createApiServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'api-server.js')).href
);

const srv = await createApiServer(apiPort);
await new Promise((r) => srv.listen(apiPort, '127.0.0.1', r));
let srv2 = null;

try {
  const base = `http://127.0.0.1:${apiPort}`;
  await waitForCentralActivation(base);

  const providers = await fetch(`${base}/providers`).then((r) => r.json());
  const owui = providers.providers?.find((p) => p.id === 'custom');
  const ollama = providers.providers?.find((p) => p.id === 'ollama');
  if (!ollama?.configured) throw new Error('ollama not configured after activation');
  if (owui?.configured) throw new Error('company Open WebUI secret must not ship in activation bundle');

  const licDoc = format.parseSignedLicense(readFileSync(licPath, 'utf8'));
  if (!licDoc?.payload.user_hint || !licDoc.payload.machine_hint) {
    throw new Error('license must bind user + machine');
  }
  if (licDoc.payload.machine_hint !== machineId) {
    throw new Error('license machine_hint mismatch');
  }
  if (licDoc.payload.expires_at !== UNLIMITED) {
    throw new Error('expected unlimited expiry in test license');
  }

  delete process.env.CQR_ACTIVATION_SERVER_URL;

  const offlinePort = 10293;
  srv2 = await createApiServer(offlinePort);
  await new Promise((r) => srv2.listen(offlinePort, '127.0.0.1', r));
  const st2 = await fetch(`http://127.0.0.1:${offlinePort}/setup/status`).then((r) => r.json());
  if (st2.needs_license) throw new Error('offline: expected cached license to work without server');

  console.log('verify-phase11 OK');
} finally {
  delete process.env.CQR_ACTIVATION_SERVER_URL;
  if (srv2) await closeServer(srv2);
  await closeServer(srv);
  await closeServer(actSrv);
}
