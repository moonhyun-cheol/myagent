#!/usr/bin/env node
/** Smoke: OpenClaw gate signing + workflow map + optional /health. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildGateCommandContextPayload,
  canonicalJsonBytes,
  signGateCommandContext,
} = await import('../core/dist/automaton/openclaw-gate-context.js');
const { resolveOpenClawWorkflow } = await import('../core/dist/automaton/openclaw-workflow-map.js');
const { probeOpenClawAdapterHealth } = await import('../core/dist/automaton/openclaw-adapter-client.js');
const { ensureOpenClawAdapterVault } = await import('../core/dist/automaton/openclaw-adapter-provision.js');
const { writeOpenClawAdapterVault } = await import('../core/dist/automaton/openclaw-adapter-vault.js');

{
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seedHex = Buffer.from(String(jwk.d), 'base64url').toString('hex');
  const payload = buildGateCommandContextPayload({
    requestId: 'req-test',
    transactionId: 'txn-test',
    actorId: 'my-agent-test',
    taskProfileId: 'safe_code_execution',
    toolId: 'safe_code_execution',
  });
  const signed = signGateCommandContext(payload, seedHex);
  assert.equal(signed.version, 'gate-command-context/v1');
  assert.ok(signed.signature);
  const valid = cryptoVerify(
    null,
    canonicalJsonBytes(signed.payload),
    publicKey,
    Buffer.from(signed.signature, 'base64url'),
  );
  assert.equal(valid, true);
}

{
  assert.equal(resolveOpenClawWorkflow('organization-tool'), null);
}

{
  const base =
    process.env.OPENCLAW_ADAPTER_BASE_URL?.trim()
    || 'http://127.0.0.1:8790';
  const health = await probeOpenClawAdapterHealth(base);
  if (health.ok) {
    console.log('OK health', base);
  } else {
    console.log('SKIP health', health.error || health.status);
  }
}

{
  const vaultDir = path.join(root, 'data', '_openclaw_provision_test');
  mkdirSync(vaultDir, { recursive: true });
  try {
    writeOpenClawAdapterVault(vaultDir, root, {
      base_url: 'http://127.0.0.1:8790',
      token: 'fixture-token',
      source: 'manual',
    });
    const r = await ensureOpenClawAdapterVault(root, vaultDir);
    assert.equal(r.ok, true);
    assert.equal(r.written, false);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
}

{
  const { formatAutomatonEnvelope } = await import('../core/dist/automaton/format-result.js');
  const text = formatAutomatonEnvelope('organization-tool', {
    status: 'ok',
    route: 'openclaw_adapter',
    result: { excel_file: 'report.xlsx' },
  });
  assert.match(text, /report\.xlsx/);
}

{
  const sandbox = path.join(root, '.tmp', 'openclaw-raw-request');
  const orgRoot = path.join(sandbox, 'modules', 'organization');
  mkdirSync(orgRoot, { recursive: true });
  writeFileSync(
    path.join(orgRoot, 'openclaw-workflow-map.json'),
    `${JSON.stringify({
      version: 2,
      workflows: {
        downloadtable_ctr: {
          task_profile_id: 'safe_online_execution',
          tool_id: 'safe_code_execution',
          args: {
            direct_action: 'command_repair_sequence',
            command_id: 'downloadtable_ctr',
          },
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const prevRoot = process.env.MY_AGENT_ROOT;
  const prevOrg = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
  delete process.env.MY_AGENT_ROOT;
  delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;

  const { resetOpenClawWorkflowMapCache } = await import('../core/dist/automaton/openclaw-workflow-map.js');
  const { buildOpenClawRawRequest } = await import('../core/dist/automaton/openclaw-adapter-client.js');
  const { AutomatonDispatchError } = await import('../core/dist/automaton/errors.js');
  const { automatonBackgroundNeedsChatFollowUp } = await import('../core/dist/automaton/format-result.js');
  const cfg = { baseUrl: 'http://127.0.0.1:8790', token: 't' };

  try {
    resetOpenClawWorkflowMapCache();
    try {
      buildOpenClawRawRequest('downloadtable_ctr', '/CTR COMBAT_SHRT', cfg);
      assert.fail('empty cqrRoot must not invent an OpenClaw workflow');
    } catch (err) {
      assert.equal(err instanceof AutomatonDispatchError, true);
      assert.match(String(err.message), /remote map 없음/);
    }

    resetOpenClawWorkflowMapCache();
    const built = buildOpenClawRawRequest('downloadtable_ctr', '/CTR COMBAT_SHRT', cfg, {
      cqrRoot: sandbox,
      nopsUserId: 'JEWEL9505',
    });
    const args = built.rawRequest.args;
    assert.equal(built.rawRequest.nopspro_user_id, 'JEWEL9505');
    assert.ok(args && typeof args === 'object');
    assert.equal(args.nopspro_user_id, 'JEWEL9505');
    assert.equal(args.requested_text, '/CTR COMBAT_SHRT');
    assert.equal(args.command_id, 'downloadtable_ctr');

    assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'ok' }, 'JEWEL9505'), false);
    assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'ok' }, ''), true);
    assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'mcp_spawn_failed' }, 'JEWEL9505'), true);
    assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'denied' }, 'JEWEL9505'), true);
  } finally {
    if (prevRoot === undefined) delete process.env.MY_AGENT_ROOT;
    else process.env.MY_AGENT_ROOT = prevRoot;
    if (prevOrg === undefined) delete process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT;
    else process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT = prevOrg;
    resetOpenClawWorkflowMapCache();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('verify-openclaw-adapter-client: pass');
