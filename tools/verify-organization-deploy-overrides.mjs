#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(root, 'core', 'dist');

async function importDist(relative) {
  return import(pathToFileURL(path.join(distRoot, relative)).href);
}

const { loadDeployDefaults } = await importDist('config/deploy-defaults.js');

const neutralRoot = path.join(root, '.tmp', 'neutral-deploy-defaults');
mkdirSync(neutralRoot, { recursive: true });
const prevOrgRoot = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
try {
  const neutral = loadDeployDefaults(neutralRoot);
  assert.equal(neutral.openclaw_adapter_base_url ?? '', '', 'neutral core must not ship org OpenClaw URL');
} finally {
  if (prevOrgRoot === undefined) delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
  else process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT = prevOrgRoot;
}

const sandbox = path.join(root, '.tmp', 'organization-deploy-overrides');
const orgRoot = path.join(sandbox, 'organization-module');
mkdirSync(orgRoot, { recursive: true });
writeFileSync(
  path.join(orgRoot, 'deploy-overrides.json'),
  `${JSON.stringify({
    openclaw_adapter_base_url: 'http://127.0.0.1:8790',
    activation_server_url: 'http://127.0.0.1:10201',
    openclaw_actor_id: 'cqr-pa',
    openclaw_fallback_local: false,
  }, null, 2)}\n`,
  'utf8',
);

const prev = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
const prevActivation = process.env.MY_AGENT_ACTIVATION_SERVER_URL;
process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT = orgRoot;
delete process.env.MY_AGENT_ACTIVATION_SERVER_URL;
try {
  const merged = loadDeployDefaults(sandbox);
  assert.equal(merged.openclaw_adapter_base_url, 'http://127.0.0.1:8790');
  assert.equal(merged.activation_server_url, 'http://127.0.0.1:10201');
  assert.equal(merged.openclaw_actor_id, 'cqr-pa');
  assert.equal(merged.openclaw_fallback_local, false);

  process.env.MY_AGENT_ACTIVATION_SERVER_URL = '0';
  const disabled = loadDeployDefaults(sandbox);
  assert.equal(disabled.activation_server_url, undefined);
} finally {
  if (prev === undefined) delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
  else process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT = prev;
  if (prevActivation === undefined) delete process.env.MY_AGENT_ACTIVATION_SERVER_URL;
  else process.env.MY_AGENT_ACTIVATION_SERVER_URL = prevActivation;
}

console.log('verify-organization-deploy-overrides: ok');
