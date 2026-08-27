#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return '';
  return String(process.argv[index + 1] ?? '').trim();
}

const zipPath = arg('zip');
const feedPath = arg('feed');
const installRoot = arg('root') || root;
if (!zipPath) {
  console.error('usage: node tools/install-organization-module.mjs --zip <module.zip> [--feed <update-feed.json>] [--root <install>] [--public-key <pem>]');
  process.exit(1);
}

const installerHref = pathToFileURL(
  path.join(root, 'core', 'dist', 'updates', 'organization-module-installer.js'),
).href;
const cryptoHref = pathToFileURL(
  path.join(root, 'core', 'dist', 'updates', 'organization-module-crypto.js'),
).href;
const { installOrganizationModule } = await import(installerHref);
const { OrganizationModuleError } = await import(cryptoHref);

try {
  const publicKeyPath = arg('public-key');
  const result = installOrganizationModule({
    cqrRoot: path.resolve(installRoot),
    zipPath: path.resolve(zipPath),
    feedPath: feedPath ? path.resolve(feedPath) : undefined,
    publicKeyPem: publicKeyPath ? readFileSync(path.resolve(publicKeyPath), 'utf8') : undefined,
  });
  console.log(
    `organization-module installed ${result.installed.version} sequence=${result.installed.update_sequence}`,
  );
  console.log('root', result.installed.root);
} catch (error) {
  if (error instanceof OrganizationModuleError) {
    console.error(`install-organization-module: ${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
