#!/usr/bin/env node
/**
 * MAR (ADR-005) unit checks:
 * - feature flag default on; MY_AGENT_MULTI_AGENT=0 disables MAR
 * - role planning (planner→coder dual, browser/research append)
 * - system notes / max steps
 * - audit event types include handoff/role_*
 * - run-meta contribution shape
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  isMultiAgentEnabled,
  planMarRoles,
} = await import('../core/dist/agent/agent-mar-runtime.js');
const { isMandatoryCriticEnabled } = await import(
  '../core/dist/agent/agent-mar-types.js',
);
const {
  systemNoteForRole,
  maxStepsForRole,
  formatPlannerSystemNote,
  parseReviewerVerdict,
  parseReviewerNext,
  reviewerBlocksCompletion,
  reviewerNeedsStructuredRetry,
} = await import('../core/dist/agent/agent-mar-roles.js');
const {
  appendRoleContribution,
  loadAgentRunMeta,
  agentRunMetaPath,
  setSessionOpenGate,
  clearSessionOpenGate,
} = await import('../core/dist/agent/agent-run-meta.js');
const {
  parseCriticNext,
  buildOpenGateFromCriticNext,
  formatOpenGateSystemNote,
  openGateBlocksDoneClaim,
} = await import('../core/dist/agent/agent-open-gate.js');
const { appendAgentAuditEvent } = await import('../core/dist/agent/agent-audit-ledger.js');

// --- flag default on; explicit off ---
{
  const prev = process.env.MY_AGENT_MULTI_AGENT;
  delete process.env.MY_AGENT_MULTI_AGENT;
  assert.equal(isMultiAgentEnabled(), true, 'default MAR on');
  process.env.MY_AGENT_MULTI_AGENT = '0';
  assert.equal(isMultiAgentEnabled(), false, '0 → off');
  process.env.MY_AGENT_MULTI_AGENT = 'false';
  assert.equal(isMultiAgentEnabled(), false, 'false → off');
  process.env.MY_AGENT_MULTI_AGENT = '1';
  assert.equal(isMultiAgentEnabled(), true, '1 → on');
  if (prev === undefined) delete process.env.MY_AGENT_MULTI_AGENT;
  else process.env.MY_AGENT_MULTI_AGENT = prev;
}

// --- mandatory critic flag ---
{
  const prev = process.env.MY_AGENT_MANDATORY_CRITIC;
  delete process.env.MY_AGENT_MANDATORY_CRITIC;
  assert.equal(isMandatoryCriticEnabled(), true, 'default critic on');
  process.env.MY_AGENT_MANDATORY_CRITIC = '0';
  assert.equal(isMandatoryCriticEnabled(), false, 'critic 0 → off');
  const planOff = planMarRoles('tools.ts에서 도구 정의 분리해줘', { playwrightAvailable: true });
  assert.equal(planOff.roles.includes('reviewer'), false, 'flag off → no mandatory reviewer');
  process.env.MY_AGENT_MANDATORY_CRITIC = '1';
  assert.equal(isMandatoryCriticEnabled(), true);
  if (prev === undefined) delete process.env.MY_AGENT_MANDATORY_CRITIC;
  else process.env.MY_AGENT_MANDATORY_CRITIC = prev;
}

// --- model-directed role plan: local prose does not classify intent ---
{
  const withBrowserTools = planMarRoles(
    'core/src/agent/tools.ts와 core/src/agent/agent-run-loop.ts 리팩토링 해줘',
    { playwrightAvailable: true },
  );
  assert.deepEqual(withBrowserTools.roles, ['coder']);
  assert.equal(withBrowserTools.reason, 'model_directed_single_agent');
  assert.equal(withBrowserTools.toolPack, 'files+browser');

  const filesOnly = planMarRoles('시장 조사 딥 리서치 해줘', { playwrightAvailable: false });
  assert.deepEqual(filesOnly.roles, ['coder']);
  assert.equal(filesOnly.toolPack, 'files');
}

// --- notes / steps ---
assert.match(formatPlannerSystemNote(), /PLANNER/);
assert.match(systemNoteForRole('coder'), /CODER/);
assert.match(systemNoteForRole('reviewer'), /CRITIC/);
assert.match(systemNoteForRole('reviewer'), /getElementById/);
assert.ok(maxStepsForRole('planner') < maxStepsForRole('coder'));
assert.equal(parseReviewerVerdict('VERDICT: FAIL\n결론: 미충족'), 'FAIL');
assert.equal(parseReviewerVerdict('VERDICT: PASS\n결론: 충족'), 'PASS');
assert.equal(
  parseReviewerVerdict('```json\n{"verdict":"PARTIAL","gaps":["x"],"next":"y"}\n```'),
  'PARTIAL',
);
assert.equal(reviewerNeedsStructuredRetry('그냥 괜찮아 보입니다'), true);
assert.equal(
  reviewerNeedsStructuredRetry('VERDICT: PASS\n결론: 충족\n미충족: 없음\n다음 수정: 없음'),
  false,
);
assert.equal(reviewerBlocksCompletion('VERDICT: FAIL\n미충족: 버튼 미생성'), true);
assert.equal(reviewerBlocksCompletion('VERDICT: PASS\n미충족: 없음'), false);
assert.equal(
  parseReviewerNext('```json\n{"verdict":"PARTIAL","gaps":["x"],"next":"app.js에 ignoreHTTPSErrors 반영"}\n```'),
  'app.js에 ignoreHTTPSErrors 반영',
);
assert.equal(parseCriticNext('다음 수정: playwright.config.js에 타임아웃 추가'), 'playwright.config.js에 타임아웃 추가');
assert.equal(parseCriticNext('다음 수정: 없음'), null);
assert.equal(
  parseCriticNext('{"next":["wire button id","refactor whole app"]}'),
  'wire button id',
);
assert.equal(parseCriticNext('다음 수정: a.js; b.js 전부'), 'a.js');


const { formatWebWiringCriticNote } = await import(
  '../core/dist/agent/agent-runtime-smoke.js'
);
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cqr-mar-wire-'));
  try {
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><div id="ok"></div><script src="app.js"></script>',
    );
    writeFileSync(
      path.join(dir, 'app.js'),
      "document.getElementById('missing');\nfunction init(){}\ndocument.addEventListener('DOMContentLoaded', init);\n",
    );
    const note = formatWebWiringCriticNote(dir, ['app.js']);
    assert.match(note, /Machine wiring smoke \(FAIL/);
    assert.match(note, /dom_id:#missing/);
    assert.equal(formatWebWiringCriticNote(dir, ['README.md']), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- run-meta contribution + openGate ---
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cqr-mar-'));
  try {
    mkdirSync(path.join(tmp, 'data', 'agent-run-meta'), { recursive: true });
    const sessionId = 'mar-test-session';
    appendRoleContribution(tmp, sessionId, {
      agentId: 'a1',
      parentRunId: 'p1',
      role: 'coder',
      mutatedPaths: ['core/src/agent/tools.ts'],
    });
    const meta = loadAgentRunMeta(tmp, sessionId);
    assert.equal(meta.parentRunId, 'p1');
    assert.equal(meta.agentId, 'a1');
    assert.ok(meta.mutatedPaths.some((p) => p.includes('tools.ts')));
    assert.ok(meta.roleContributions?.length);
    const fp = agentRunMetaPath(tmp, sessionId);
    assert.ok(existsSync(fp));
    const raw = JSON.parse(readFileSync(fp, 'utf8'));
    assert.equal(raw.parentRunId, 'p1');

    const gate = buildOpenGateFromCriticNext('tests/compatibility.spec.js에 touch 제스처 추가', {
      source: 'critic',
      parentRunId: 'p1',
      agentId: 'reviewer-1',
    });
    assert.ok(gate);
    setSessionOpenGate(tmp, sessionId, gate);
    const withGate = loadAgentRunMeta(tmp, sessionId);
    assert.ok(openGateBlocksDoneClaim(withGate.openGate));
    assert.match(formatOpenGateSystemNote(withGate.openGate), /Session Exit Gate/);
    assert.ok(withGate.mutatedPaths.some((p) => p.includes('tools.ts')), 'openGate must not drop paths');
    clearSessionOpenGate(tmp, sessionId, 'test');
    assert.equal(loadAgentRunMeta(tmp, sessionId).openGate, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- ledger handoff / role events ---
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cqr-mar-audit-'));
  try {
    appendAgentAuditEvent(tmp, {
      type: 'handoff',
      sessionId: 's1',
      parentRunId: 'p1',
      agentId: 'a2',
      role: 'coder',
      detail: 'planner->coder',
    });
    appendAgentAuditEvent(tmp, {
      type: 'role_start',
      sessionId: 's1',
      parentRunId: 'p1',
      agentId: 'a2',
      role: 'coder',
    });
    appendAgentAuditEvent(tmp, {
      type: 'role_end',
      sessionId: 's1',
      parentRunId: 'p1',
      agentId: 'a2',
      role: 'coder',
      ok: true,
      steps: 3,
    });
    const ledger = path.join(tmp, 'data', 'audit', 'agent-ledger.jsonl');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const types = lines.map((l) => JSON.parse(l).type);
    assert.deepEqual(types, ['handoff', 'role_start', 'role_end']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('verify-multi-agent: ok');
