#!/usr/bin/env node
/** Smoke: OpenClaw gate signing + workflow map + optional /health. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const {
    formatAutomatonEnvelope,
    formatAutomatonEnvelopeWithContract,
  } = await import('../core/dist/automaton/format-result.js');
  const text = formatAutomatonEnvelope('organization-tool', {
    status: 'ok',
    route: 'openclaw_adapter',
    result: { excel_file: 'report.xlsx' },
  });
  assert.match(text, /report\.xlsx/);

  const authoritativeCtr = [
    '======작업 완료======',
    'CTR 리포트 (TAC_BOONIE)',
    '기간: 2026-01-01 ~ 2026-09-14',
    '데이터: 120행 / RAW 3개',
    '파일:',
    "'C:/reports/CTR\\_TAC.xlsx'",
  ].join('\n');
  const passthrough = formatAutomatonEnvelopeWithContract(
    'downloadtable_ctr',
    {
      status: 'ok',
      message: authoritativeCtr,
      result: {
        stdout: 'engine: internal',
        artifacts: [{ path: 'C:/internal/debug.json', role: 'debug' }],
      },
    },
    { profile: 'discord', template_id: 'ctr-report', fallback_profile: 'files' },
    'CTR',
  );
  assert.equal(passthrough, authoritativeCtr);
  assert.doesNotMatch(passthrough, /engine:|debug\.json|status:/i);

  const stockMessage = [
    '스탁: M스탁',
    '모델명: TAC-123',
    '사이즈: 32X30',
    '수량: 12',
    '',
    '출처: BMS gdslist (https://example.invalid/gdslist)',
  ].join('\n');
  const stockPassthrough = formatAutomatonEnvelopeWithContract(
    'us_sample_stock_lookup',
    { status: 'ok', result: { output: { result: { message: stockMessage, qty: 12 } } } },
    { profile: 'discord', template_id: 'us-sample-stock', fallback_profile: 'quantity', fields: ['qty'] },
    '미국샘플재고',
  );
  assert.equal(stockPassthrough, stockMessage);

  const quantity = formatAutomatonEnvelopeWithContract(
    'us_sample_stock_lookup',
    {
      status: 'ok',
      result: {
        output: {
          result: { qty: 12, json_output: 'C:/internal/result.json' },
        },
        artifacts: [{ name: 'debug', path: 'C:/internal/debug.json' }],
      },
    },
    { profile: 'quantity', fields: ['qty'] },
    '미국 샘플 재고',
  );
  assert.equal(quantity, '미국 샘플 재고는 12개입니다.');
  assert.doesNotMatch(quantity, /json|internal|artifact/i);

  const files = formatAutomatonEnvelopeWithContract(
    'downloadtable_po_review',
    {
      status: 'ok',
      result: {
        artifacts: [
          { name: '최종 발주검토', path: 'C:/output/review.xlsx', role: 'final' },
          { name: '중간 JSON', path: 'C:/output/debug.json', role: 'intermediate' },
          { name: '실행 로그', path: 'C:/output/run.xlsx', role: 'log' },
        ],
      },
    },
    { profile: 'files', allowed_extensions: ['.xlsx'] },
    '발주검토자료',
  );
  assert.match(files, /작업을 완료했습니다/);
  assert.match(files, /review\.xlsx/);
  assert.doesNotMatch(files, /debug\.json|run\.xlsx/);

  const missingFile = formatAutomatonEnvelopeWithContract(
    'downloadtable_po_review',
    { status: 'ok', result: { artifacts: [{ path: 'C:/output/debug.json' }] } },
    { profile: 'files', allowed_extensions: ['.xlsx'] },
    '발주검토자료',
  );
  assert.match(missingFile, /최종 파일을 확인하지 못했습니다/);
  assert.doesNotMatch(missingFile, /작업을 완료했습니다/);
}

{
  const orchestratorSource = readFileSync(
    path.join(root, 'core', 'src', 'chat', 'chat-orchestrator.ts'),
    'utf8',
  );
  assert.match(orchestratorSource, /responseProfile\s*!==\s*'auto'/);
  assert.match(orchestratorSource, /publishStatus\(result\.content\)/);
}

{
  const sandbox = path.join(root, '.tmp', 'adapter-connection');
  const orgRoot = path.join(sandbox, 'modules', 'organization');
  mkdirSync(orgRoot, { recursive: true });
  writeFileSync(
    path.join(orgRoot, 'adapter-connection.json'),
    `${JSON.stringify({
      version: 1,
      base_url: 'http://127.0.0.1:8790',
      transport: {
        request_path: '/cqr/adapter/request',
        status_path_template: '/cqr/adapter/jobs/{job_id}',
        poll_interval_ms: 2500,
      },
      authentication: {
        mode: 'install_bootstrap',
        bootstrap_path: '/cqr/adapter/auth/bootstrap',
        bootstrap_key: 'install-fixture',
      },
      progress: {
        accepted_text: '명령어 접수',
        running_text: '진행 중',
        completed_text: '완료',
        failed_text: '실패',
      },
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(orgRoot, 'module.json'),
    `${JSON.stringify({
      id: 'organization',
      adapter_connection_file: 'adapter-connection.json',
      openclaw_adapter_base_url: 'http://127.0.0.1:8790',
    }, null, 2)}\n`,
    'utf8',
  );

  const {
    buildAdapterStatusUrl,
    formatAdapterProgressMessage,
    loadAdapterConnection,
  } = await import('../core/dist/automaton/adapter-connection.js');
  const {
    buildAutomatonAckContent,
    formatUnsupportedAutomatonBatch,
  } = await import('../core/dist/automaton/automaton-ack.js');

  try {
    const conn = loadAdapterConnection(sandbox);
    assert.ok(conn);
    assert.equal(conn.base_url, 'http://127.0.0.1:8790');
    assert.equal(conn.authentication?.bootstrap_key, 'install-fixture');
    assert.equal(
      buildAdapterStatusUrl(conn.base_url, 'job-1', conn.transport?.status_path_template),
      'http://127.0.0.1:8790/cqr/adapter/jobs/job-1',
    );
    const progress = formatAdapterProgressMessage(conn, {
      commandText: '/발주검토자료 CRGO_PT',
      status: 'queued',
    });
    assert.match(progress, /명령어 접수|접수:/);
    assert.match(progress, /상태:/);
    assert.doesNotMatch(progress, /중앙 허브/);
    assert.doesNotMatch(progress, /전달 경로/);
    assert.doesNotMatch(progress, /쪽지 수신자/);
    const requestId = '7d722b55-3788-4514-b50e-9fc4ef6878ac';
    const ack = buildAutomatonAckContent('/발주검토자료 CRGO_PT, TAC_BOONIE', 'downloadtable_po_review', {
      requestId,
      response: {
        profile: 'discord',
        template_id: 'po-review',
        fallback_profile: 'files',
        ack: {
          enabled: true,
          command_id: 'downloadtable_po_review',
          batch_time_hint: '수 분 이상 (데이터 범위에 따라 달라질 수 있음)',
        },
        batch: { supported: true, label_ko: '발주검토자료', cap: null },
      },
    });
    assert.equal(ack, [
      '처리 접수 완료',
      '- command: downloadtable_po_review',
      '- batch: 2건 (한 번에 실행, 상한 무제한)',
      '- 2건 배치 접수 · 완료까지 수 분 이상 (데이터 범위에 따라 달라질 수 있음) 소요될 수 있습니다.',
      `- request_id: \`${requestId}\``,
      '작업이 길어질 수 있어 백그라운드에서 실행합니다.',
      '결과가 준비되면 이 채널로 안내됩니다.',
    ].join('\n'));
    assert.doesNotMatch(ack, /중앙 허브|전달 경로|쪽지 수신자|상태:/);
    assert.equal(
      formatUnsupportedAutomatonBatch('/모델가계도 TAC, CRGO', {
        profile: 'discord',
        template_id: 'model-genealogy',
        fallback_profile: 'text',
        batch: { supported: false, label_ko: '모델가계도' },
      }),
      '모델가계도: 이 명령은 쉼표(,) 배치 입력을 지원하지 않습니다. 한 번에 하나씩 요청하세요.',
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
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
      requestId: 'fixed-request-id',
      nopsUserId: 'JEWEL9505',
    });
    const args = built.rawRequest.args;
    assert.equal(built.requestId, 'fixed-request-id');
    assert.equal(built.rawRequest.request_id, 'fixed-request-id');
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
