#!/usr/bin/env node
/** Smoke: OpenClaw gate signing + workflow map + optional /health. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
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

console.log('verify-openclaw-adapter-client: pass');
