#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

const root = process.cwd();
const service = await import(pathToFileURL(path.join(root, 'core/dist/support/error-report-service.js')).href);
const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-local-error-log-'));
try {
  const result = await service.sendErrorReportNow(root, temp, '', {
    subject: 'fixture error',
    summary: 'repro with api_key=super-secret and sk-example12345678',
    rawError: 'Bearer hidden-token-value timeout',
    mode: 'manual',
  }, true);
  assert.equal(result.ok, true);
  assert.match(result.report_id, /^ERR-/);
  assert.equal(result.log_path, 'data/logs/error-reports.jsonl');

  const logPath = path.join(temp, 'logs', 'error-reports.jsonl');
  const raw = readFileSync(logPath, 'utf8');
  assert.doesNotMatch(raw, /super-secret|sk-example12345678|hidden-token-value/);
  const row = JSON.parse(raw.trim());
  assert.equal(row.schema_version, 1);
  assert.equal(row.report_id, result.report_id);
  assert.equal(row.mode, 'manual');
  assert.equal(row.related_logs.agent_audit, 'data/audit/agent-ledger.jsonl');
  assert.equal(row.related_logs.llm_wire, 'data/logs/llm-wire.jsonl');

  const status = service.getErrorReportPublicConfig(root, temp, '');
  assert.deepEqual(status, {
    enabled: true,
    configured: true,
    storage: 'local_jsonl',
    log_path: 'data/logs/error-reports.jsonl',
  });

  const serviceSource = readFileSync(path.join(root, 'core/src/support/error-report-service.ts'), 'utf8');
  const ui = readFileSync(path.join(root, 'ui/workspace/src/components/ErrorReportMenu.tsx'), 'utf8');
  const routes = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
  const server = readFileSync(path.join(root, 'core/src/api-server.ts'), 'utf8');
  const assemble = readFileSync(path.join(root, 'tools/assemble-dispatch.mjs'), 'utf8');
  for (const source of [serviceSource, ui, routes, server, assemble]) {
    assert.doesNotMatch(source, /gmail\.com|sendSmtpMail|ERROR_REPORT_TO|ErrorReportStore/);
  }
  assert.match(ui, /data\/logs\/error-reports\.jsonl/);
  assert.match(ui, /지금 기록/);
  assert.match(routes, /MY Agent 수동 오류 기록/);
  console.log('local error log contract: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
