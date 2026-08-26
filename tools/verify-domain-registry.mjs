#!/usr/bin/env node
/**
 * Domain registry + bare-module guard + edit→write heal goldens.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contentInventsDomainApiFromRegistry,
  loadDomainConnectors,
  matchDomainConnectors,
  resetDomainConnectorsCache,
  resolveDeliverySecrets,
  secretsForDataSources,
} from '../core/dist/agent/agent-domain-registry.js';
import { inferArtifactContract } from '../core/dist/agent/agent-artifact-contract.js';
import {
  isBlockedBareModuleRead,
  looksLikeBareNpmModuleId,
} from '../core/dist/agent/agent-bare-module-guard.js';
import { applyToolSchemaCompat } from '../core/dist/agent/tool-schema-compat.js';
import { CODE_AGENT_TOOLS } from '../core/dist/agent/agent-tool-definitions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MY_AGENT_ROOT = root;
resetDomainConnectorsCache();

const doc = loadDomainConnectors(root);
assert.deepEqual(doc.connectors, []);
assert.ok(doc.deliveryProfiles.some((p) => p.id === 'discord_webhook'));

const connectorRoot = mkdtempSync(path.join(tmpdir(), 'my-agent-domain-'));
try {
  const defaults = path.join(connectorRoot, 'core', 'config', 'defaults');
  mkdirSync(defaults, { recursive: true });
  writeFileSync(path.join(defaults, 'domain-connectors.json'), `${JSON.stringify({
    version: 1,
    connectors: [{
      id: 'inventory_service',
      match: ['INVENTORY_SERVICE', 'inventory records'],
      fixtureOkMatch: ['fixture', 'sample'],
      defaultStatus: 'unknown',
      requiredSecrets: ['INVENTORY_API_URL', 'INVENTORY_API_KEY'],
      inventPathPatterns: ['/inventory/private/'],
      noteUnknown: 'Schema is unknown; require a fixture or clarification.',
      noteFixtureOk: 'Fixture-only connector.',
    }],
    deliveryProfiles: doc.deliveryProfiles,
  }, null, 2)}\n`, 'utf8');
  resetDomainConnectorsCache();
  const hits = matchDomainConnectors('INVENTORY_SERVICE fixture', connectorRoot);
  assert.equal(hits[0]?.id, 'inventory_service');
  assert.equal(hits[0]?.status, 'fixture_ok');
  assert.ok(secretsForDataSources(hits, connectorRoot).includes('INVENTORY_API_KEY'));

  const unknown = matchDomainConnectors('INVENTORY_SERVICE integration', connectorRoot);
  assert.equal(unknown[0]?.status, 'unknown');
  assert.equal(
    contentInventsDomainApiFromRegistry(
      'Confirmed live endpoint: /inventory/private/stock',
      unknown,
      connectorRoot,
    ),
    true,
  );
} finally {
  rmSync(connectorRoot, { recursive: true, force: true });
  resetDomainConnectorsCache();
}

{
  const d = resolveDeliverySecrets({
    message: 'Discord 일간 매크로 OpenClaw 금지',
    artifactKind: 'discord_bot',
    cqrRoot: root,
  });
  assert.equal(d.profileId, 'discord_webhook');
  assert.ok(d.secrets.includes('DISCORD_WEBHOOK_URL'));
}

{
  const d = resolveDeliverySecrets({
    message: 'Discord Bot Token + discord.js 게이트웨이',
    artifactKind: 'discord_bot',
    cqrRoot: root,
  });
  assert.equal(d.profileId, 'discord_bot_token');
  assert.ok(d.secrets.includes('DISCORD_BOT_TOKEN'));
}

{
  const c = inferArtifactContract(
    '개인용 Discord 일간 매크로. OpenClaw 금지.',
  );
  assert.ok(c.requiredSecrets.includes('DISCORD_WEBHOOK_URL'));
  assert.deepEqual(c.dataSources, []);
}

assert.equal(looksLikeBareNpmModuleId('discord.js'), true);
assert.equal(looksLikeBareNpmModuleId('dotenv'), true);
assert.equal(looksLikeBareNpmModuleId('app.js'), false);
assert.equal(looksLikeBareNpmModuleId('src/index.js'), false);
assert.equal(isBlockedBareModuleRead(root, 'discord.js'), true);
assert.equal(isBlockedBareModuleRead(root, 'package.json'), false);

{
  const compat = applyToolSchemaCompat(
    {
      id: '1',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({
          path: 'README.md',
          new_text: '# hello\n\nfull rewrite body here\n',
        }),
      },
    },
    CODE_AGENT_TOOLS,
  );
  assert.equal(compat.toolCall.function.name, 'write_file');
  assert.equal(compat.reroutedFrom, 'edit_file');
  assert.equal(compat.validation.ok, true);
}

{
  const compat = applyToolSchemaCompat(
    {
      id: '2',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({
          path: 'a.js',
          old_text: '',
          new_text: 'console.log(1)\n',
        }),
      },
    },
    CODE_AGENT_TOOLS,
  );
  assert.equal(compat.toolCall.function.name, 'write_file', 'empty old_text → write');
  assert.equal(compat.validation.ok, true);
}

console.log('verify-domain-registry: ok');
