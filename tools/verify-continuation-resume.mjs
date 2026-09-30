#!/usr/bin/env node
// 「이어서 진행」 resume contract: fresh per-run budget, chain cap, clear on completion,
// host retry resumes regardless of wording, Autopilot not tied to continuation.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  looksLikeSessionContinue,
  shouldUseSessionContinuity,
  resolveContinuationResume,
  maxContinuationResumes,
  DEFAULT_MAX_CONTINUATION_RESUMES,
} = await import('../core/dist/agent/agent-session-continuity.js');
const {
  loadAgentRunMeta,
  recordSessionContinuationSnapshot,
  clearSessionContinuationState,
  appendSessionReadPaths,
} = await import('../core/dist/agent/agent-run-meta.js');
const { buildAgentContinuationSnapshot } = await import(
  '../core/dist/agent/agent-continuation-snapshot.js'
);

// Single recognizer (whole-message).
for (const t of ['이어서', '이어서 진행', '계속 진행해', '마저 작업해']) {
  assert.equal(looksLikeSessionContinue(t), true, t);
}
for (const t of ['이어서 진행하고 테스트도', '새 기능 만들어줘']) {
  assert.equal(looksLikeSessionContinue(t), false, t);
}

// 3) Host retry resumes regardless of wording, but only when state exists.
assert.equal(
  shouldUseSessionContinuity({ userMessage: '로그인 버그 고쳐줘', readPaths: ['a.ts'], mutatedPaths: [], force: true }),
  true,
  'retry resumes regardless of wording',
);
assert.equal(
  shouldUseSessionContinuity({ userMessage: '로그인 버그 고쳐줘', readPaths: ['a.ts'], mutatedPaths: [] }),
  false,
  'fresh wording without force stays fresh',
);
assert.equal(
  shouldUseSessionContinuity({ userMessage: 'x', readPaths: [], mutatedPaths: [], force: true }),
  false,
  'nothing to resume',
);

// 1) Resume accounting: user resumes count, host retries do not; cap enforced.
assert.equal(DEFAULT_MAX_CONTINUATION_RESUMES, 5);
assert.equal(maxContinuationResumes({}), 5);
assert.equal(maxContinuationResumes({ MY_AGENT_MAX_CONTINUATION_RESUMES: '2' }), 2);
assert.deepEqual(
  resolveContinuationResume({ hasSnapshot: true, snapshotResumeCount: 0, retry: false, max: 5 }),
  { resumeCount: 1, exhausted: false, max: 5 },
);
assert.deepEqual(
  resolveContinuationResume({ hasSnapshot: true, snapshotResumeCount: 3, retry: true, max: 5 }),
  { resumeCount: 3, exhausted: false, max: 5 },
  'retry does not spend a resume',
);
assert.equal(
  resolveContinuationResume({ hasSnapshot: true, snapshotResumeCount: 5, retry: false, max: 5 }).exhausted,
  true,
  '6th user resume is refused',
);
assert.equal(
  resolveContinuationResume({ hasSnapshot: false, retry: false, max: 5 }).resumeCount,
  0,
  'fresh run starts a new chain',
);

// Static wiring: per-run budget no longer uses the cumulative count.
const stepLoop = readFileSync(new URL('../core/src/agent/agent-run-step-loop.ts', import.meta.url), 'utf8');
assert.match(stepLoop, /while \(state\.steps < MAX_AGENT_STEPS\)/, 'fresh per-run budget');
assert.doesNotMatch(stepLoop, /while \(cumulativeSteps\(\) < MAX_AGENT_STEPS\)/);
const runLoop = readFileSync(new URL('../core/src/agent/agent-run-loop.ts', import.meta.url), 'utf8');
assert.doesNotMatch(runLoop, /shouldOrInContinuityAutopilot/, '4) continuation must not OR-in Autopilot');
assert.doesNotMatch(runLoop, /autopilot = true;/);
assert.match(runLoop, /force: opts\.continuationRetry === true/);
const orch = readFileSync(new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url), 'utf8');
assert.match(orch, /continuationRetry: attempt > 1/);

// 2) Snapshot persistence + clear.
const root = mkdtempSync(path.join(os.tmpdir(), 'cqr-resume-'));
try {
  appendSessionReadPaths(root, 's1', ['src/a.ts']);
  const snap = buildAgentContinuationSnapshot({
    step: 100,
    elapsedMs: 1,
    payloadChars: 1,
    evidenceRefs: [],
    readPaths: ['src/a.ts'],
    mutatedPaths: [],
    resumeCount: 2,
  });
  assert.equal(snap.resumeCount, 2);
  recordSessionContinuationSnapshot(root, 's1', snap);
  const loaded = loadAgentRunMeta(root, 's1');
  assert.equal(loaded.continuationSnapshot?.resumeCount, 2, 'resumeCount survives normalize');
  assert.equal(loaded.continuationSnapshot?.step, 100);
  clearSessionContinuationState(root, 's1');
  const cleared = loadAgentRunMeta(root, 's1');
  assert.equal(cleared.continuationSnapshot, undefined, 'snapshot cleared');
  assert.equal(cleared.lastProgressCheckpoint, undefined);
  assert.ok(cleared.readPaths?.includes('src/a.ts'), 'session read paths kept');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('verify-continuation-resume OK');
