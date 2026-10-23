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
// Workspace deletes are snapshotted before model approval -> delegable; moves/outside stay manual.
assert.equal(approval.canDelegateToolApproval('apply_patch', { files: [{ path: 'a.ts', action: 'delete' }] }, workspace), true);
assert.equal(approval.canDelegateToolApproval('apply_patch', { patch: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' }, workspace), true);
assert.equal(approval.canDelegateToolApproval('apply_patch', { files: [{ path: 'a.ts', action: 'move', new_path: 'b.ts' }] }, workspace), false);
assert.equal(approval.canDelegateToolApproval('delete_file', { path: 'old.txt' }, workspace), true);
assert.equal(approval.canDelegateToolApproval('delete_file', { path: path.join(os.tmpdir(), 'elsewhere.txt') }, workspace), false);
assert.equal(approval.canDelegateToolApproval('delete_file', { path: '\\\\nas\\x\\a.md' }, workspace), false);
assert.equal(approval.canDelegateToolApproval('workspace_rollback', { checkpoint_id: 'x' }, workspace), false);
assert.doesNotMatch(safeContext, /destructive|excluded_operations/);
assert.doesNotMatch(reviewer.buildApprovalReviewSystemPrompt('delegate'), /Never allow deletion/);
assert.match(reviewer.buildApprovalReviewSystemPrompt('delegate'), /explicitly commanded/);

// Decision answers -> allow/ask (delegate: ask only when severe AND not explicit).
const ans = (sev, sp, exp, ep) => ({ severity: { choice: sev, probabilities: { [sev]: sp } }, explicit: { choice: exp, probabilities: { [exp]: ep } } });
assert.equal(reviewer.decideFromAnswers(ans('normal', 0.99, 'no', 0.9), 'delegate').decision, 'allow');
assert.equal(reviewer.decideFromAnswers(ans('severe', 0.98, 'no', 0.9), 'delegate').decision, 'ask_user');
assert.equal(reviewer.decideFromAnswers(ans('severe', 0.98, 'yes', 0.9), 'delegate').decision, 'allow');
assert.equal(reviewer.decideFromAnswers({}, 'delegate').decision, 'ask_user');
assert.equal(reviewer.decideFromAnswers(ans('normal', 0.5, 'no', 0.99), 'delegate').decision, 'ask_user', 'coin-flip severity asks');
assert.equal(reviewer.decideFromAnswers(ans('normal', 0.5, 'yes', 0.99), 'delegate').decision, 'allow', 'explicit command still runs');
assert.equal(reviewer.decideFromAnswers(ans('normal', 0.95, 'no', 0.9), 'triage').decision, 'allow');
assert.equal(reviewer.decideFromAnswers(ans('normal', 0.7, 'no', 0.9), 'triage').decision, 'ask_user');
assert.equal(reviewer.decideFromAnswers(ans('severe', 0.98, 'yes', 0.9), 'triage').decision, 'ask_user');
assert.equal(reviewer.decisionsEndpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/alpha/decisions');
assert.equal(reviewer.decisionsEndpoint('https://api.openai.com/v1'), null);
assert.equal(reviewer.isDecisionModelId('microsoft/microsoft-decision-1'), true);
assert.equal(reviewer.isDecisionModelId('~typesafe/jev-latest'), true);
assert.equal(reviewer.APPROVAL_DECISION_LATEST_MODEL_ID, '~typesafe/jev-latest');
assert.ok(reviewer.APPROVAL_REVIEWER_CANDIDATES.some((c) => c.value === 'provider:custom@' + encodeURIComponent('~typesafe/jev-latest')));
assert.ok(!reviewer.APPROVAL_REVIEWER_CANDIDATES.some((c) => /jev-1\.\d+/.test(decodeURIComponent(c.value))), 'no pinned Jev version');
assert.deepEqual(reviewer.buildDecisionPayload({ a: 1 }, []), { a: 1 });
assert.deepEqual(reviewer.buildDecisionPayload({ a: 1 }, ['data:image/png;base64,x']), [
  { type: 'text', text: '{"a":1}' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
]);
assert.equal(reviewer.isDecisionModelId('openai/gpt-5.6-luna'), false);
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
    assert.ok(['openai/gpt-5.6-luna', '~microsoft/microsoft-decision-latest', '~typesafe/jev-latest'].includes(modelId));
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
  // Non-OpenRouter provider: decision default cannot run -> general reviewer answered.
  assert.equal(allowed.fallback, true);

  // Local latest alias: next major / next minor candidates; resolver passes other ids through.
  assert.deepEqual(reviewer.nextMicrosoftDecisionCandidates('microsoft/microsoft-decision-1'), ['microsoft/microsoft-decision-2', 'microsoft/microsoft-decision-1.1']);
  assert.deepEqual(reviewer.nextMicrosoftDecisionCandidates('microsoft/microsoft-decision-2.3'), ['microsoft/microsoft-decision-3', 'microsoft/microsoft-decision-2.4']);
  assert.equal(await reviewer.resolveDecisionModel({ endpoint: 'https://x.invalid', apiKey: 'k', modelId: '~typesafe/jev-latest' }), '~typesafe/jev-latest');
  assert.deepEqual(reviewer.parseApprovalReviewerPreference('provider:custom@' + encodeURIComponent('microsoft/microsoft-decision-1')), { providerId: 'custom', modelId: '~microsoft/microsoft-decision-latest' });
  reviewer.primeDecisionModelLatest('https://openrouter.ai/api/alpha/decisions', 'microsoft/microsoft-decision-1');
  // Default reviewer = latest microsoft-decision on the OpenRouter decisions endpoint.
  const openRouter = {
    resolveProvider: (providerId, modelId) => ({ def: { name: 'OpenRouter' }, secret: { api_key: 'or-key' }, modelId, baseUrl: 'https://openrouter.ai/api/v1', wireApi: 'responses' }),
  };
  const decideSeen = [];
  const severeAsk = await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: '빌드 캐시 정리해줘',
    request: { id: 'd1', tool: 'delete_file', summary: '파일 삭제: data/sessions/sessions.sqlite', argsPreview: '{"path":"data/sessions/sessions.sqlite"}', danger: true, delegable: true },
    complete: async () => { throw new Error('chat reviewer must not run'); },
    decide: async ({ endpoint, model, state, questions, apiKey }) => {
      decideSeen.push(`${endpoint}|${model}`);
      assert.equal(apiKey, 'or-key');
      assert.equal(state.user_request, '빌드 캐시 정리해줘');
      assert.equal(state.facts.approve_on_my_behalf, true);
      assert.doesNotMatch(JSON.stringify(state), /destructive/);
      assert.ok(questions.severity && questions.explicit);
      return { answers: ans('severe', 0.99, 'no', 0.97) };
    },
  });
  assert.deepEqual(decideSeen, ['https://openrouter.ai/api/alpha/decisions|microsoft/microsoft-decision-1']);
  assert.equal(severeAsk.decision, 'ask_user');
  assert.equal(severeAsk.reviewer, 'OpenRouter/~microsoft/microsoft-decision-latest → microsoft/microsoft-decision-1');
  // A newer release resolved by the alias is what gets called.
  const newerSeen = [];
  await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: 'npm test', request,
    resolveModel: async ({ modelId }) => (modelId.startsWith('~microsoft/') ? 'microsoft/microsoft-decision-2' : modelId),
    decide: async ({ model }) => { newerSeen.push(model); return { answers: ans('normal', 0.98, 'no', 0.9) }; },
  });
  assert.deepEqual(newerSeen, ['microsoft/microsoft-decision-2']);
  const explicitRun = await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: 'sessions.sqlite 삭제해서 DB 초기화해줘', request,
    decide: async () => ({ answers: ans('severe', 0.99, 'yes', 0.95) }),
  });
  assert.equal(explicitRun.decision, 'allow');
  assert.equal(explicitRun.fallback, undefined);
  // microsoft-decision-1 fails -> auto-updating Jev answers (reports the concrete build).
  const jevSeen = [];
  const viaJev = await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: 'npm test', request,
    decide: async ({ model }) => {
      jevSeen.push(model);
      if (model.startsWith('microsoft/')) throw new Error('decisions HTTP 503');
      return { answers: ans('normal', 0.98, 'no', 0.9), model: 'typesafe/jev-1.14-20261014' };
    },
    complete: async () => { throw new Error('chat reviewer must not run'); },
  });
  assert.deepEqual(jevSeen, ['microsoft/microsoft-decision-1', '~typesafe/jev-latest']);
  assert.equal(viaJev.decision, 'allow');
  assert.equal(viaJev.fallback, true);
  assert.equal(viaJev.escalated, undefined);
  assert.equal(viaJev.reviewer, 'OpenRouter/~typesafe/jev-latest → typesafe/jev-1.14-20261014');
  // Image attached -> skip text-only microsoft model, send image parts to Jev.
  jevSeen.length = 0;
  const img = 'data:image/png;base64,AAAA';
  const viaImage = await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: '이 화면처럼 고쳐줘', request, imageDataUrls: [img, 'https://not-a-data-url'],
    decide: async ({ model, state }) => {
      jevSeen.push(model);
      assert.ok(Array.isArray(state));
      assert.equal(state.length, 2);
      assert.deepEqual(state[1], { type: 'image_url', image_url: { url: img } });
      assert.match(state[0].text, /이 화면처럼 고쳐줘/);
      return { answers: ans('normal', 0.97, 'no', 0.9) };
    },
  });
  assert.deepEqual(jevSeen, ['~typesafe/jev-latest']);
  assert.equal(viaImage.escalated, 'image');
  assert.equal(viaImage.fallback, undefined);
  // >32k tokens -> skip microsoft, Jev answers.
  jevSeen.length = 0;
  const viaLarge = await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: '로그 확인 '.repeat(8000), request,
    decide: async ({ model }) => { jevSeen.push(model); return { answers: ans('normal', 0.97, 'no', 0.9) }; },
  });
  assert.deepEqual(jevSeen, ['~typesafe/jev-latest']);
  assert.equal(viaLarge.escalated, 'large_context');
  assert.ok(reviewer.estimateDecisionTokens('로그 확인 '.repeat(8000)) > reviewer.PRIMARY_DECISION_MAX_TOKENS);
  assert.ok(reviewer.estimateDecisionTokens('npm test') < 10);
  // Both decision models down -> general chat reviewer (Luna) answers.
  const chatSeen = [];
  const decisionDown = await reviewer.reviewToolApproval({
    providerStore: openRouter, cqrRoot: temp, userMessage: 'npm test', request,
    decide: async () => { throw new Error('decisions HTTP 503'); },
    complete: async ({ model }) => { chatSeen.push(model); return { content: '{"decision":"allow","confidence":0.9,"reason":"ok"}' }; },
  });
  assert.deepEqual(chatSeen, ['openai/gpt-5.6-luna']);
  assert.equal(decisionDown.decision, 'allow');
  assert.equal(decisionDown.fallback, true);

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

  // Selected decision model: used first; product default answers when it fails.
  const safeguard = 'provider:custom@' + encodeURIComponent('openai/gpt-oss-safeguard-20b');
  assert.ok(reviewer.APPROVAL_REVIEWER_CANDIDATES.some((c) => c.value === safeguard));
  assert.deepEqual(reviewer.parseApprovalReviewerPreference(safeguard), { providerId: 'custom', modelId: 'openai/gpt-oss-safeguard-20b' });
  assert.equal(reviewer.parseApprovalReviewerPreference('gpt-4o'), null);
  const anyProvider = (wireApi = 'responses') => ({
    resolveProvider: (providerId, modelId) => ({ def: { name: 'Fixture' }, secret: { api_key: 'k' }, modelId, baseUrl: 'https://fixture.invalid/v1', wireApi }),
  });
  const seen = [];
  const viaSelected = await reviewer.reviewToolApproval({
    providerStore: anyProvider('chat_completions'), cqrRoot: temp, userMessage: 'update src/a.ts', request,
    reviewerPreference: safeguard,
    complete: async ({ model, wireApi }) => { seen.push(`${model}:${wireApi}`); return { content: '{"decision":"allow","confidence":0.9,"reason":"ok"}' }; },
  });
  assert.equal(viaSelected.decision, 'allow');
  assert.equal(viaSelected.fallback, undefined);
  assert.deepEqual(seen, ['openai/gpt-oss-safeguard-20b:chat_completions']);
  seen.length = 0;
  const viaFallback = await reviewer.reviewToolApproval({
    providerStore: anyProvider(), cqrRoot: temp, userMessage: 'update src/a.ts', request,
    reviewerPreference: safeguard,
    complete: async ({ model }) => {
      seen.push(model);
      if (model.includes('safeguard')) throw new Error('json_schema unsupported');
      return { content: '{"decision":"allow","confidence":0.8,"reason":"ok"}' };
    },
  });
  assert.deepEqual(seen, ['openai/gpt-oss-safeguard-20b', 'openai/gpt-5.6-luna']);
  assert.equal(viaFallback.decision, 'allow');
  assert.equal(viaFallback.fallback, true);
  seen.length = 0;
  const testOnly = await reviewer.reviewToolApproval({
    providerStore: anyProvider(), cqrRoot: temp, userMessage: 'x', request,
    providerId: 'custom', modelId: 'openai/gpt-oss-safeguard-20b', noFallback: true,
    complete: async ({ model }) => { seen.push(model); throw new Error('down'); },
  });
  assert.deepEqual(seen, ['openai/gpt-oss-safeguard-20b']);
  assert.equal(testOnly.decision, 'ask_user');
  assert.equal(testOnly.reviewer, 'unavailable');

  // Triage (매번 승인 + 카드 선별) uses its own stricter prompt.
  let triageSystem = '';
  await reviewer.reviewToolApproval({
    providerStore: anyProvider(), cqrRoot: temp, userMessage: 'x', request, mode: 'triage',
    complete: async ({ messages }) => { triageSystem = messages[0].content; return { content: '{"decision":"ask_user","confidence":0.4,"reason":"unclear"}' }; },
  });
  assert.match(triageSystem, /did NOT delegate/);
  assert.match(triageSystem, /NAS or network-share writes/);
  assert.match(reviewer.buildApprovalReviewSystemPrompt('delegate'), /user-delegated authority/);

  // NAS / network share: never delegable for writes or terminal; reads stay delegable.
  const nasRoot = '\\\\nas3\\share\\project';
  assert.equal(approval.canDelegateToolApproval('write_file', { path: 'a.md', content: 'x' }, nasRoot), false);
  assert.equal(approval.canDelegateToolApproval('apply_patch', { files: [{ path: 'a.md', action: 'update', edits: [] }] }, nasRoot), false);
  assert.equal(approval.canDelegateToolApproval('run_terminal', { command: 'npm test' }, nasRoot), false);
  assert.equal(approval.canDelegateToolApproval('read_file', { path: 'a.md' }, nasRoot), true);
  assert.equal(approval.canDelegateToolApproval('write_file', { path: '\\\\nas\\x\\a.md', content: 'x' }, workspace), false);
  assert.equal(approval.canDelegateToolApproval('run_terminal', { command: 'copy a.md \\\\nas\\x\\a.md' }, workspace), false);
  assert.deepEqual(approval.normalizeToolApprovalOutcome(true), { approved: true, by: 'user' });

  const ledger = path.join(temp, 'data/audit/agent-ledger.jsonl');
  assert.equal(existsSync(ledger), true);
  const events = readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.every((event) => event.type === 'approval_review'), true);
  assert.equal(events.some((event) => event.ok === true), true);
  assert.equal(events.some((event) => event.ok === false), true);

  const ui = [
    'ui/workspace/src/components/SettingsModal.tsx',
    'ui/workspace/src/components/SettingsAgentPage.tsx',
  ].map((file) => readFileSync(path.join(root, file), 'utf8')).join('\n');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/myAgentClient.ts'), 'utf8');
  const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
  const orchestrator = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  const stepLoop = readFileSync(path.join(root, 'core/src/agent/agent-run-step-loop.ts'), 'utf8');
  assert.match(ui, /data-testid="settings-approval-delegation-mode"/);
  assert.match(ui, /<option value="auto_review">나 대신 승인 — 판단 모델 검토<\/option>/);
  assert.match(ui, /data-testid="settings-approval-reviewer-model"/);
  assert.match(ui, /data-testid="settings-approval-card-triage"/);
  assert.match(ui, /data-testid="settings-approval-reviewer-reset"/);
  assert.match(client, /\/config\/approval-reviewer\/test/);
  assert.match(dispatch, /url\.pathname === '\/config\/approval-reviewer'/);
  assert.match(orchestrator, /approval_card_triage === true \? 'triage'/);
  assert.match(orchestrator, /by: 'reviewer'/);
  assert.match(stepLoop, /before-model-approval:/);
  assert.match(ui, /작업에 필요한 외부 읽기와 안전한 터미널 실행은 대신 승인/);
  assert.match(ui, /data-testid="settings-delegate-preset"/);
  assert.match(ui, /setAgentExecutionPreset\(\)/);
  assert.match(client, /approval_delegation: mode/);
  assert.match(client, /\/config\/agent-execution-preset/);
  assert.match(dispatch, /body\.preset !== 'delegate'/);
  assert.match(dispatch, /agent_autopilot: true, approval_delegation: 'auto_review'/);
  assert.match(orchestrator, /review\.decision === 'allow'/);
  assert.match(orchestrator, /approvalPolicy === 'delegate' && approvalReq\.delegable === true && approvalReq\.access === 'external_read'/);
  assert.doesNotMatch(orchestrator, /providerId: resolved\.route\.providerId/);
  assert.match(orchestrator, /const wait = waitForToolApproval/);
  assert.match(orchestrator, /access: approvalReq\.access/);
  assert.match(client, /워크스페이스 외부 읽기/);
  assert.match(client, /return (?:await )?confirmDialog\(\{/);
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
