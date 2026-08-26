#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';

const root = process.cwd();
const reviewer = await import(pathToFileURL(path.join(root, 'core/dist/agent/approval-auto-review.js')).href);
const approval = await import(pathToFileURL(path.join(root, 'core/dist/agent/tool-approval.js')).href);

assert.deepEqual(reviewer.parseApprovalReview('{"decision":"allow","confidence":0.95,"reason":"contained"}'), {
  decision: 'allow', confidence: 0.95, reason: 'contained',
});
assert.equal(reviewer.parseApprovalReview('{"decision":"allow","confidence":0.89,"reason":"explicit model decision"}').decision, 'allow');
assert.equal(reviewer.parseApprovalReview('not json').decision, 'ask_user');
const safeContext = reviewer.buildApprovalReviewContext(
  'use api_key=super-secret-value and sk-example12345678',
  { id: 'x', tool: 'write_file', summary: 'write', argsPreview: JSON.stringify({ path: 'a.ts', content: 'password=do-not-send\nfull source' }), danger: false, delegable: true },
);
assert.doesNotMatch(safeContext, /super-secret-value|sk-example12345678|do-not-send|full source/);
assert.match(safeContext, /REDACTED/);
assert.match(safeContext, /content_chars/);

const workspace = path.join(os.tmpdir(), 'cqr-pa-review-workspace');
assert.equal(approval.canDelegateToolApproval('apply_patch', { files: [{ path: 'a.ts', action: 'delete' }] }, workspace), false);
assert.equal(approval.canDelegateToolApproval('apply_patch', { patch: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' }, workspace), false);
assert.equal(approval.canDelegateToolApproval('apply_patch', { files: [{ path: 'a.ts', action: 'update', edits: [] }] }, workspace), true);
assert.equal(approval.canDelegateToolApproval('run_terminal', { command: 'python -m pytest -q' }, workspace), true);

const outside = path.join(os.tmpdir(), 'cqr-pa-external-info');
const grants = new Set();
const externalRead = approval.needsHumanApproval(
  'list_directory',
  { path: outside },
  {},
  { workspaceRoot: workspace, approvedExternalReadRoots: grants },
);
assert.equal(externalRead.needed, true);
assert.equal(externalRead.danger, false);
assert.equal(externalRead.access, 'external_read');
assert.equal(externalRead.expires, 'run');
assert.equal(approval.canDelegateToolApproval('read_file', { path: outside }, workspace), true);
for (const grant of externalRead.grantRoots ?? []) grants.add(grant);
assert.equal(
  approval.needsHumanApproval(
    'read_file',
    { path: path.join(outside, 'nested', 'next.md') },
    {},
    { workspaceRoot: workspace, approvedExternalReadRoots: grants },
  ).needed,
  false,
  'same approved external root should be readable for the current run',
);
assert.equal(
  approval.needsHumanApproval(
    'read_file',
    { path: path.join(workspace, 'src', 'a.ts') },
    {},
    { workspaceRoot: workspace, approvedExternalReadRoots: grants },
  ).needed,
  false,
  'workspace-contained read must not prompt',
);
const externalWrite = approval.needsHumanApproval(
  'write_file',
  { path: path.join(outside, 'result.md'), content: 'result' },
  {},
  { workspaceRoot: workspace, approvedExternalReadRoots: grants },
);
assert.equal(externalWrite.needed, true);
assert.equal(externalWrite.danger, true);
assert.equal(externalWrite.access, 'external_write');
assert.equal(externalWrite.expires, 'once');

const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-auto-review-'));
const responsesProvider = {
  resolveProvider: (providerId, modelId) => {
    assert.equal(providerId, 'custom');
    assert.equal(modelId, 'openai/gpt-5.6-luna');
    return {
      def: { name: 'Fixture Responses' },
      secret: { api_key: 'fixture-key' },
      modelId,
      baseUrl: 'https://fixture.invalid/v1',
      wireApi: 'responses',
    };
  },
};
const request = { id: 'approval-1', tool: 'write_file', summary: 'large local write', argsPreview: '{"path":"src/a.ts"}', danger: false, delegable: true };
try {
  let callCount = 0;
  const allowed = await reviewer.reviewToolApproval({
    providerStore: responsesProvider,
    cqrRoot: temp,
    sessionId: 'fixture-session',
    userMessage: 'update src/a.ts',
    request,
    complete: async ({ messages }) => {
      callCount += 1;
      const sent = JSON.stringify(messages);
      assert.match(sent, /update src\/a\.ts/);
      assert.doesNotMatch(sent, /fixture-key/);
      return { content: '{"decision":"allow","confidence":0.97,"reason":"intent and local path match"}' };
    },
  });
  assert.equal(callCount, 1);
  assert.equal(allowed.decision, 'allow');

  const unavailable = await reviewer.reviewToolApproval({
    providerStore: {
      resolveProvider: (providerId, modelId) => ({
        ...responsesProvider.resolveProvider(providerId, modelId),
        wireApi: 'messages',
      }),
    },
    cqrRoot: temp,
    userMessage: 'update src/a.ts',
    request,
    complete: async () => { throw new Error('must not call'); },
  });
  assert.equal(unavailable.decision, 'ask_user');

  const failed = await reviewer.reviewToolApproval({
    providerStore: responsesProvider,
    cqrRoot: temp,
    userMessage: 'update src/a.ts',
    request,
    complete: async () => { throw new Error('timeout'); },
  });
  assert.equal(failed.decision, 'ask_user');
  assert.match(failed.reason, /timeout/);

  const ledger = path.join(temp, 'data/audit/agent-ledger.jsonl');
  assert.equal(existsSync(ledger), true);
  const events = readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.every((event) => event.type === 'approval_review'), true);
  assert.equal(events.some((event) => event.ok === true), true);
  assert.equal(events.some((event) => event.ok === false), true);

  const ui = readFileSync(path.join(root, 'ui/workspace/src/components/SettingsModal.tsx'), 'utf8');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/cqrClient.ts'), 'utf8');
  const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
  const orchestrator = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  const stepLoop = readFileSync(path.join(root, 'core/src/agent/agent-run-step-loop.ts'), 'utf8');
  assert.match(ui, /data-testid="settings-approval-delegation-mode"/);
  assert.match(ui, /<option value="auto_review">나 대신 승인 — Luna 위험 검토<\/option>/);
  assert.match(ui, /작업에 필요한 외부 읽기와 안전한 터미널 실행은 대신 승인/);
  assert.match(ui, /data-testid="settings-delegate-preset"/);
  assert.match(ui, /setAgentExecutionPreset\(\)/);
  assert.match(client, /approval_delegation: mode/);
  assert.match(client, /\/config\/agent-execution-preset/);
  assert.match(dispatch, /body\.preset !== 'delegate'/);
  assert.match(dispatch, /agent_autopilot: true, approval_delegation: 'auto_review'/);
  assert.match(orchestrator, /review\.decision === 'allow'/);
  assert.doesNotMatch(orchestrator, /providerId: resolved\.route\.providerId/);
  assert.match(orchestrator, /const wait = waitForToolApproval/);
  assert.match(orchestrator, /access: approvalReq\.access/);
  assert.match(client, /워크스페이스 외부 읽기/);
  assert.match(client, /return confirmDialog\(\{/);
  assert.doesNotMatch(client, /승인 확인|거절 확인|거절 확정|다시 선택/);
  const approvalExecutionIndex = stepLoop.indexOf('const hitl = needsHumanApproval(execCall.function.name');
  const checkpointExecutionIndex = stepLoop.indexOf(
    'if (isMutatingAgentTool(execCall.function.name) && !state.autoCheckpointTaken)',
  );
  assert.ok(approvalExecutionIndex >= 0 && checkpointExecutionIndex >= 0);
  assert.ok(
    approvalExecutionIndex < checkpointExecutionIndex,
    'approval classification must happen before checkpoint touches target paths',
  );
  console.log('Responses approval auto-review contract: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
