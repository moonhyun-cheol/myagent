#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSignedEnvelope,
  verifySignedEnvelope,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0];

function getArg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const privateKeyPath = path.resolve(
  getArg(
    '--private',
    process.env.MY_AGENT_UPDATE_SIGNING_KEY
      ?? path.join(root, 'tools', 'keys', 'update-private.pem'),
  ),
);
const publicKeyPath = path.resolve(
  getArg(
    '--public',
    process.env.MY_AGENT_UPDATE_PUBLIC_KEY
      ?? path.join(root, 'core', 'config', 'defaults', 'update-public.pem'),
  ),
);

function fail(message) {
  console.error(`update-admin: ${message}`);
  process.exit(1);
}

function keyFingerprint(publicPem) {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

if (command === 'keygen') {
  if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
    fail('refusing to overwrite an existing update signing key');
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  mkdirSync(path.dirname(privateKeyPath), { recursive: true });
  mkdirSync(path.dirname(publicKeyPath), { recursive: true });
  writeFileSync(privateKeyPath, privatePem, { encoding: 'utf8', mode: 0o600 });
  try
  {
    chmodSync(privateKeyPath, 0o600);
  }
  catch
  {
    // Windows ACLs are managed separately; chmod is best effort.
  }
  writeFileSync(publicKeyPath, publicPem, 'utf8');
  console.log('Update signing key created.');
  console.log('Private key:', privateKeyPath);
  console.log('Public key :', publicKeyPath);
  console.log('Fingerprint:', keyFingerprint(publicPem));
  console.log('Back up the private key offline. Never commit or upload it.');
  process.exit(0);
}

if (command === 'status') {
  if (!existsSync(privateKeyPath)) fail(`private key missing: ${privateKeyPath}`);
  if (!existsSync(publicKeyPath)) fail(`public key missing: ${publicKeyPath}`);
  const privatePem = readFileSync(privateKeyPath, 'utf8');
  const publicPem = readFileSync(publicKeyPath, 'utf8');
  const probe = createSignedEnvelope(
    { purpose: 'cqr-pa-update-key-status', schema: 1 },
    privatePem,
  );
  if (!verifySignedEnvelope(probe, publicPem)) fail('private/public update keys do not match');
  console.log('Update signing key: VALID');
  console.log('Fingerprint:', keyFingerprint(publicPem));
  process.exit(0);
}

console.log(`Usage:
  node tools/update-admin.mjs keygen [--private PATH] [--public PATH]
  node tools/update-admin.mjs status [--private PATH] [--public PATH]`);
process.exit(1);
