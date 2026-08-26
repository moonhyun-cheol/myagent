#!/usr/bin/env node
/**
 * MY Agent license admin — keygen, issue, verify.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = path.join(root, 'tools', 'keys');
const pubDest = path.join(root, 'core', 'config', 'defaults', 'license-public.pem');
const privPath = path.join(keysDir, 'license-private.pem');

function getArg(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function ensureBuilt() {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function loadDist() {
  const format = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'license', 'license-format.js')).href
  );
  const crypto = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'license', 'license-crypto.js')).href
  );
  return { format, crypto };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'keygen') {
    mkdirSync(keysDir, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(pubDest, publicKey.export({ type: 'spki', format: 'pem' }));
    console.log('Wrote private:', privPath);
    console.log('Wrote public :', pubDest);
    return;
  }

  if (
    cmd === 'issue' ||
    cmd === 'verify' ||
    cmd === 'bundle-keys' ||
    cmd === 'machine-id' ||
    cmd === 'allowlist'
  ) {
    ensureBuilt();
  }

  if (cmd === 'machine-id' || cmd === 'whoami') {
    const cqrRoot = process.env.MY_AGENT_ROOT ?? root;
    const win = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'license', 'windows-user-id.js')).href
    );
    if (cmd === 'whoami') {
      console.log(win.computeWindowsUserId());
      return;
    }
    const mod = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'license', 'machine-id.js')).href
    );
    console.log(mod.computeMachineId(cqrRoot));
    return;
  }

  if (cmd === 'bundle-keys') {
    const deployPath = path.join(root, 'core', 'config', 'defaults', 'deploy-defaults.json');
    const deploy = JSON.parse(readFileSync(deployPath, 'utf8'));
    const org = getArg(args, '--org') ?? 'dev';
    const out = getArg(args, '--out') ?? path.join(root, 'deploy', 'output', 'keys-bundle.enc');
    const defaultProvider = getArg(args, '--default-provider') ?? (org === 'dev' ? 'custom' : 'ollama');
    const allowMissingOwui = args.includes('--allow-missing-owui');
    if (args.includes('--stub-owui')) {
      process.env.MY_AGENT_BUNDLE_STUB_OWUI = '1';
    }

    const bundleMod = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'key-bundle.js')).href
    );
    const { buildDefaultBundlePayload } = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'default-bundle-payload.js')).href
    );

    const payload = buildDefaultBundlePayload({
      orgId: org,
      cqrRoot: root,
      defaultProviderId: defaultProvider,
      deploy,
      requireOpenWebUi: !allowMissingOwui,
    });

    const enc = bundleMod.encryptBundle(payload);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, enc + '\n', 'utf8');
    console.log('Wrote keys bundle ->', out);
    console.log('  org     :', org);
    console.log('  default :', payload.default_provider_id);
    console.log('  providers:', Object.keys(payload.entries).join(', '));
    console.log('  ollama  :', payload.entries.ollama.base_url);
    console.log('  ollama model:', payload.entries.ollama.model_id);
    if (payload.entries.custom) {
      console.log('  custom  :', payload.entries.custom.base_url);
      console.log('  owui model:', payload.entries.custom.model_id || '(auto)');
    }
    return;
  }

  if (cmd === 'allowlist') {
    const dataDir = path.join(root, 'activation-server');
    const policyPath = path.join(dataDir, 'policy.json');
    const legacyPath = path.join(dataDir, 'allowlist.json');
    const targetPath = existsSync(policyPath) ? policyPath : legacyPath;
    const sub = args[0];
    const win = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'license', 'windows-user-id.js')).href
    );

    if (!existsSync(targetPath)) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        targetPath,
        JSON.stringify(
          {
            org_id: 'myorg',
            license_days: null,
            require_allowlist: true,
            features: [
              'chat',
              'manager',
              'local_models',
              'image_generation',
              'deep_research',
              'local_image',
              'web_dev',
              'browser_automation',
            ],
            allowed_users: [],
          },
          null,
          2,
        ) + '\n',
      );
    }

    const policy = JSON.parse(readFileSync(targetPath, 'utf8'));
    policy.allowed_users = policy.allowed_users ?? [];
    policy.require_allowlist = true;

    if (sub === 'list') {
      console.log(JSON.stringify(policy, null, 2));
      return;
    }

    const userRaw = getArg(args, '--user');
    if (!userRaw) {
      console.error('Usage: allowlist add|remove|list --user DOMAIN\\user');
      process.exit(1);
    }
    const user = win.normalizeUserHint(userRaw);

    if (sub === 'add') {
      if (!policy.allowed_users.includes(user)) policy.allowed_users.push(user);
    } else if (sub === 'remove') {
      policy.allowed_users = policy.allowed_users.filter((u) => u !== user);
    } else {
      console.error('Usage: allowlist add|remove|list --user DOMAIN\\user');
      process.exit(1);
    }

    writeFileSync(targetPath, JSON.stringify(policy, null, 2) + '\n');
    console.log(`${sub} ${user}`);
    console.log('allowed:', policy.allowed_users.join(', ') || '(empty)');
    return;
  }

  const { format, crypto } = await loadDist();

  if (cmd === 'issue') {
    if (!existsSync(privPath)) {
      console.error('Private key missing. Run: node tools/cqr-admin.mjs keygen');
      process.exit(1);
    }
    const org = getArg(args, '--org') ?? 'dev';
    const out = getArg(args, '--out') ?? path.join(root, 'data', 'vault', 'license.ocx');
    const days = Number(getArg(args, '--days') ?? '365');
    const features = (
      getArg(args, '--features') ??
      'chat,manager,local_models,image_generation,deep_research,local_image,web_dev,browser_automation'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const userRaw = getArg(args, '--user') ?? null;
    const machine = getArg(args, '--machine') ?? null;

    const win = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'license', 'windows-user-id.js')).href
    );
    const user_hint = userRaw ? win.normalizeUserHint(userRaw) : null;

    const now = new Date();
    const exp = new Date(now);
    exp.setUTCDate(exp.getUTCDate() + days);

    const payload = {
      v: 1,
      org_id: org,
      features,
      issued_at: now.toISOString(),
      expires_at: exp.toISOString(),
      machine_hint: user_hint ? null : machine,
      user_hint,
      nonce: randomUUID(),
    };

    const priv = readFileSync(privPath, 'utf8');
    const sig = crypto.signLicensePayload(payload, priv);
    const doc = format.buildSignedLicense(payload, sig);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, format.serializeLicense(doc));
    console.log('Issued license ->', out);
    console.log('  org     :', org);
    if (user_hint) console.log('  user    :', user_hint);
    if (machine && !user_hint) console.log('  machine :', machine);
    console.log('  expires :', payload.expires_at);
    return;
  }

  if (cmd === 'verify') {
    const file = args.find((a) => !a.startsWith('--')) ?? path.join(root, 'data', 'vault', 'license.ocx');
    const raw = readFileSync(file, 'utf8');
    const doc = format.parseSignedLicense(raw);
    if (!doc) {
      console.error('Invalid license file');
      process.exit(1);
    }
    const ok = crypto.verifyLicenseSignature(doc.payload, doc.sig);
    console.log('signature:', ok ? 'VALID' : 'INVALID');
    console.log('org      :', doc.payload.org_id);
    console.log('expires  :', doc.payload.expires_at);
    console.log('features :', doc.payload.features.join(', '));
    if (doc.payload.user_hint) console.log('user     :', doc.payload.user_hint);
    if (doc.payload.machine_hint) console.log('machine  :', doc.payload.machine_hint);
    process.exit(ok ? 0 : 1);
  }

  console.log(`MY Agent license admin

  node tools/cqr-admin.mjs keygen
  node tools/cqr-admin.mjs issue [--org NAME] [--user DOMAIN\\user] [--out PATH] [--days N] [--features a,b,c]
  node tools/cqr-admin.mjs whoami
  node tools/cqr-admin.mjs verify [license.ocx]
  node tools/cqr-admin.mjs bundle-keys [--org NAME] [--ollama-url URL] [--model NAME] [--out PATH]
  node tools/cqr-admin.mjs allowlist add|remove|list --user DOMAIN\\user`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
