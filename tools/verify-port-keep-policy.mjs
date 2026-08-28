#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepRuleFor, loadPortKeepPolicy, shouldKeepLocal } from './port-keep-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadPortKeepPolicy(root);
const ids = policy.keep.map((rule) => rule.id);

for (const id of [
  'identity',
  'port_policy',
  'company_matrix',
  'install_first_run',
  'public_entry',
  'product_ui',
  'contract_verify',
]) {
  assert.ok(ids.includes(id), `missing keep rule: ${id}`);
}

assert.equal(policy.accepts_legacy_edits, false);
assert.equal(keepRuleFor('tools/install/install-ui.ps1', policy)?.id, 'install_first_run');
assert.equal(keepRuleFor('tools/install/optional-runtimes.ps1', policy)?.id, 'install_first_run');
assert.equal(keepRuleFor('core/config/defaults/openwebui-model-curate.json', policy)?.id, 'company_matrix');
assert.equal(keepRuleFor('ui/workspace/src/components/SettingsAgentPage.tsx', policy)?.id, 'product_ui');
assert.equal(keepRuleFor('channels/stable.json', policy)?.id, 'public_entry');
assert.equal(shouldKeepLocal('core/src/agent/code-agent.ts', policy), false);
assert.equal(shouldKeepLocal('core/src/routes/dispatch.ts', policy), false);

const extra = policy.extra_from_legacy || [];
assert.equal(
  extra.some((file) => /Settings|install-ui|ModelManagement/i.test(file)),
  false,
  'EXTRA must not pull archive UI/install files over MY Agent',
);

const apply = readFileSync(path.join(root, 'tools', 'port-apply.mjs'), 'utf8');
assert.match(apply, /from '\.\/port-keep-policy\.mjs'/);
assert.match(apply, /keep \$\{rule\.id\}/);
assert.doesNotMatch(apply, /const KEEP_LOCAL = new Set/);
assert.doesNotMatch(apply, /SettingsAgentPage/);

const status = readFileSync(path.join(root, 'tools', 'port-status.mjs'), 'utf8');
assert.match(status, /from '\.\/port-keep-policy\.mjs'/);
assert.match(status, /keep_local/);

const target = JSON.parse(readFileSync(path.join(root, 'repo-target.json'), 'utf8'));
assert.equal(target.accepts_legacy_edits, false);

console.log('verify-port-keep-policy: PASS');
