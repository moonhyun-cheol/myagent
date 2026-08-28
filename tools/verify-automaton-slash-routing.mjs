#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(root, 'core', 'dist');

async function importDist(relative) {
  return import(pathToFileURL(path.join(distRoot, relative)).href);
}

const { resetAutomatonToolManifestCache, peekAutomatonIntent, isAutomatonTool } = await Promise.all([
  importDist('automaton/tool-catalog.js'),
  importDist('automaton/tool-map.js'),
  importDist('router/automaton-intent.js'),
]).then(([catalog, toolMap, intent]) => ({ ...catalog, ...toolMap, ...intent }));

const prev = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
resetAutomatonToolManifestCache();
const neutral = peekAutomatonIntent('/반품율분석 text: OVERALL');
assert.equal(neutral, null, 'neutral core must not route company slash commands');

const sandbox = path.join(root, '.tmp', 'automaton-slash-routing');
const orgRoot = path.join(sandbox, 'organization-module');
mkdirSync(orgRoot, { recursive: true });
writeFileSync(
  path.join(orgRoot, 'automaton-tools.manifest.json'),
  `${JSON.stringify({
    version: 2,
    tools: [{
      id: 'amazon_return_manager_direct',
      description_ko: '반품율 분석',
      slash_prefixes: ['/반품율분석'],
      default_command: '/반품율분석',
      anchors_ko: ['/반품율분석'],
      intent_phrases_ko: ['반품율'],
      intent_boost_ko: ['반품율'],
      intent_pattern_strings: ['반품'],
      intent_examples: ['/반품율분석 OVERALL'],
    }],
  }, null, 2)}\n`,
  'utf8',
);

process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT = orgRoot;
resetAutomatonToolManifestCache();
try {
  const hit = peekAutomatonIntent('/반품율분석 text: OVERALL', sandbox);
  assert.ok(hit, 'org module slash manifest must route /반품율분석');
  assert.equal(hit.toolId, 'amazon_return_manager_direct');
  assert.equal(hit.commandText, '/반품율분석 text: OVERALL');
  assert.equal(
    isAutomatonTool(hit.toolId, sandbox),
    true,
    'orchestrator guard must accept the peeked org tool when cqrRoot is passed',
  );
  assert.equal(
    isAutomatonTool(hit.toolId),
    true,
    'env-based org overlay must still resolve without repeating cqrRoot',
  );

  delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
  const bundledRoot = path.join(sandbox, 'bundled-product');
  const bundledOrg = path.join(bundledRoot, 'modules', 'organization');
  mkdirSync(bundledOrg, { recursive: true });
  writeFileSync(
    path.join(bundledOrg, 'automaton-tools.manifest.json'),
    readFileSync(path.join(orgRoot, 'automaton-tools.manifest.json'), 'utf8'),
  );
  resetAutomatonToolManifestCache();
  const bundledHit = peekAutomatonIntent('/반품율분석 text: OVERALL', bundledRoot);
  assert.ok(bundledHit, 'bundled modules/organization must route /반품율분석');
  assert.equal(bundledHit.toolId, 'amazon_return_manager_direct');
  assert.equal(
    isAutomatonTool(bundledHit.toolId, bundledRoot),
    true,
    'production bundled overlay must pass the orchestrator guard with cqrRoot',
  );
} finally {
  if (prev === undefined) delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
  else process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT = prev;
  resetAutomatonToolManifestCache();
}

console.log('verify-automaton-slash-routing: ok');
