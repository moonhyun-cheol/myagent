#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  flushLiveSessionProgress,
  persistInterruptedAgentProgress,
  shouldUseSessionContinuity,
} = await import('../core/dist/agent/agent-session-continuity.js');
const {
  loadAgentRunMeta,
  recordSessionContinuationSnapshot,
  recordSessionProgressCheckpoint,
} = await import('../core/dist/agent/agent-run-meta.js');
const { formatSessionContinuitySystemNote } = await import(
  '../core/dist/agent/agent-session-continuity.js'
);

assert.equal(
  shouldUseSessionContinuity({
    userMessage: '이어서',
    readPaths: ['src/app.ts'],
    mutatedPaths: [],
  }),
  true,
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '이어서',
    readPaths: [],
    mutatedPaths: [],
    hasProgressCheckpoint: true,
  }),
  true,
  'a durable checkpoint alone is enough to resume',
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '새 기능을 만들어줘',
    readPaths: ['src/app.ts'],
    mutatedPaths: ['src/app.ts'],
  }),
  false,
  'stored metadata must not hijack a fresh request',
);

const root = mkdtempSync(path.join(os.tmpdir(), 'cqr-continuity-'));
try {
  flushLiveSessionProgress({
    cqrRoot: root,
    sessionId: 's1',
    mutatedPaths: ['src/app.ts'],
    readPaths: ['src/lib.ts'],
  });
  const interrupted = persistInterruptedAgentProgress({
    cqrRoot: root,
    sessionId: 's1',
    mutatedPaths: ['src/app.ts'],
    readPaths: ['src/lib.ts'],
    userMessage: '작업 중',
  });
  assert.ok(interrupted.mutatedPaths.includes('src/app.ts'));
  assert.ok(interrupted.readPaths?.includes('src/lib.ts'));
  assert.equal('openGate' in interrupted, false);
  assert.equal('openGate' in loadAgentRunMeta(root, 's1'), false);

  recordSessionProgressCheckpoint(root, 's1', {
    version: 1,
    at: '2026-01-01T00:00:00.000Z',
    reason: 'three_failures',
    step: 13,
    stage: 2,
    maxStages: 5,
    failureCount: 3,
    completed: ['조회 확인: src/lib.ts'],
    remaining: ['실패 복구: edit_file'],
    resumeFrom: 'src/app.ts 수정 재시도',
    modelOutput: '원래 모델이 남긴 작업 결과',
    runtime: {
      model: 'OpenAI/gpt-test',
      elapsedMs: 125_000,
      payloadChars: 32_768,
    },
    recentActivity: ['read_file: ok (step 12)', 'edit_file: failed (step 13)'],
  });
  const resumed = loadAgentRunMeta(root, 's1').lastProgressCheckpoint;
  assert.equal(resumed?.reason, 'three_failures');
  assert.equal(resumed?.modelOutput, '원래 모델이 남긴 작업 결과');
  assert.equal(resumed?.runtime?.model, 'OpenAI/gpt-test');
  assert.equal(resumed?.runtime?.elapsedMs, 125_000);
  assert.equal(resumed?.runtime?.payloadChars, 32_768);
  assert.deepEqual(resumed?.recentActivity, [
    'read_file: ok (step 12)',
    'edit_file: failed (step 13)',
  ]);
  const note = formatSessionContinuitySystemNote({
    readPaths: ['src/lib.ts'],
    mutatedPaths: ['src/app.ts'],
    progressCheckpoint: resumed,
  });
  assert.match(note, /Persisted progress checkpoint/);
  assert.match(note, /src\/app\.ts 수정 재시도/);
  assert.match(note, /원래 모델이 남긴 작업 결과/);
  assert.match(note, /OpenAI\/gpt-test/);
  const continuation = {
    version: 1,
    at: '2026-01-01T00:10:00.000Z',
    step: 21,
    elapsedMs: 180_000,
    payloadChars: 48_000,
    model: 'OpenAI/gpt-test-next',
    todoLedger: {
      version: 1,
      todos: [{
        id: 'T2',
        text: 'Continuation Snapshot 기반 재개',
        status: 'doing',
        acceptance: 'TODO와 Evidence 참조가 재개 입력에 남음',
        evidenceRefs: ['ev_resume_1'],
        nextAction: '연속성 검증 실행',
      }],
      retainEvidence: [{ evidenceId: 'ev_resume_1', todoId: 'T2', form: 'exact' }],
      workingNotes: [{ todoId: 'T2', text: '구 체크포인트보다 Snapshot을 우선한다.', supports: ['ev_resume_1'] }],
      updatedAt: '2026-01-01T00:10:00.000Z',
    },
    evidenceRefs: ['ev_resume_1'],
    readPaths: ['src/context.ts'],
    mutatedPaths: ['src/app.ts'],
    unresolvedFailures: ['run_tests: exit 1'],
    lastModelOutput: 'Snapshot에 보존된 마지막 모델 출력',
  };
  recordSessionContinuationSnapshot(root, 's1', continuation);
  const loadedSnapshot = loadAgentRunMeta(root, 's1').continuationSnapshot;
  assert.equal(loadedSnapshot?.step, 21);
  assert.equal(loadedSnapshot?.todoLedger?.todos[0]?.id, 'T2');
  assert.deepEqual(loadedSnapshot?.evidenceRefs, ['ev_resume_1']);

  const continuationNote = formatSessionContinuitySystemNote({
    readPaths: ['src/context.ts'],
    mutatedPaths: ['src/app.ts'],
    continuationSnapshot: loadedSnapshot,
    progressCheckpoint: resumed,
  });
  assert.match(continuationNote, /Continuation Snapshot/);
  assert.match(continuationNote, /T2: Continuation Snapshot 기반 재개/);
  assert.match(continuationNote, /ev_resume_1/);
  assert.doesNotMatch(
    continuationNote,
    /Persisted progress checkpoint/,
    'new Continuation Snapshot must take precedence over the legacy checkpoint',
  );
  assert.equal(
    shouldUseSessionContinuity({
      userMessage: '계속 작업하자',
      readPaths: [],
      mutatedPaths: [],
      hasContinuationSnapshot: true,
    }),
    true,
    'a Continuation Snapshot alone is enough to resume',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('verify-session-continuity: ok');
