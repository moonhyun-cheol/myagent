#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Auto-resume at run start is host-owned only; user wording is never classified.
assert.equal(
  shouldUseSessionContinuity({ readPaths: ['src/app.ts'], mutatedPaths: [] }),
  false,
  'a user turn never auto-resumes',
);
assert.equal(
  shouldUseSessionContinuity({ readPaths: [], mutatedPaths: [], hasProgressCheckpoint: true, force: true }),
  true,
  'host retry resumes from a durable checkpoint',
);
assert.equal(
  shouldUseSessionContinuity({ readPaths: [], mutatedPaths: [], force: true }),
  false,
  'host retry with no stored state has nothing to resume',
);
{
  const mod = await import('../core/dist/agent/agent-session-continuity.js');
  assert.equal('SESSION_CONTINUE_RE' in mod, false, 'continue regex removed');
  assert.equal('looksLikeSessionContinue' in mod, false, 'continue regex helper removed');
}

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
      readPaths: [],
      mutatedPaths: [],
      hasContinuationSnapshot: true,
      force: true,
    }),
    true,
    'a Continuation Snapshot alone is enough for a host retry',
  );
  // Pending run: kept across turns (TTL), announced to the model, resumed only by the model.
  const {
    selectPendingContinuation,
    formatPendingContinuationTurnNote,
    isContinuationExpired,
  } = await import('../core/dist/agent/agent-session-continuity.js');
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const pending = selectPendingContinuation({ continuationSnapshot: loadedSnapshot }, now, 24 * 3_600_000);
  assert.equal(pending?.snapshot?.step, 21, 'unexpired snapshot stays pending');
  assert.equal(
    selectPendingContinuation({ continuationSnapshot: loadedSnapshot }, now + 48 * 3_600_000, 24 * 3_600_000),
    null,
    'expired snapshot is not pending',
  );
  assert.equal(isContinuationExpired(undefined), false);
  const pendingNote = formatPendingContinuationTurnNote(pending, 5);
  assert.match(pendingNote, /Unfinished previous run/);
  assert.match(pendingNote, /resume_run/);
  assert.match(pendingNote, /discard_run/);
  assert.match(pendingNote, /T2: Continuation Snapshot 기반 재개/);
  const toolDefsSrc = readFileSync(path.resolve('core/src/agent/agent-tool-definitions.ts'), 'utf8');
  assert.match(toolDefsSrc, /'resume_run', 'discard_run'/, 'active_task exposes resume_run/discard_run');
  const stepLoopSrc = readFileSync(path.resolve('core/src/agent/agent-run-step-loop.ts'), 'utf8');
  assert.match(stepLoopSrc, /if \(ownsContinuation\(\)\) \{\s*recordSessionContinuationSnapshot/, 'side run does not overwrite a pending snapshot');
  assert.match(stepLoopSrc, /if \(ownsContinuation\(\)\) \{\s*try \{\s*clearSessionContinuationState/, 'side run does not clear a pending snapshot');
  // Stale-read guard: only paths unchanged on disk since the snapshot are seeded.
  const { fingerprintWorkspacePaths, partitionPathsByFingerprint } = await import(
    '../core/dist/agent/agent-continuation-snapshot.js'
  );
  const ws = path.join(root, 'ws');
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  writeFileSync(path.join(ws, 'src/a.ts'), 'a');
  writeFileSync(path.join(ws, 'src/b.ts'), 'b');
  const fps = fingerprintWorkspacePaths(ws, ['src/a.ts', 'src/b.ts', 'src/missing.ts']);
  assert.deepEqual(Object.keys(fps).sort(), ['src/a.ts', 'src/b.ts'], 'missing files are not fingerprinted');
  writeFileSync(path.join(ws, 'src/b.ts'), 'b changed by user');
  const split = partitionPathsByFingerprint(ws, ['src/a.ts', 'src/b.ts', 'src/c.ts'], fps);
  assert.deepEqual(split.unchanged, ['src/a.ts'], 'unchanged file stays seeded');
  assert.deepEqual(split.changed.sort(), ['src/b.ts', 'src/c.ts'], 'edited / unfingerprinted files need re-read');
  assert.deepEqual(
    partitionPathsByFingerprint(ws, ['src/a.ts'], undefined).unchanged,
    [],
    'legacy snapshot without fingerprints seeds nothing',
  );

  recordSessionContinuationSnapshot(root, 's1', { ...continuation, pathFingerprints: fps, resumeCount: 5 });
  const fpLoaded = loadAgentRunMeta(root, 's1').continuationSnapshot;
  assert.deepEqual(fpLoaded?.pathFingerprints, fps, 'fingerprints survive meta round-trip');

  const seededNote = formatSessionContinuitySystemNote({
    readPaths: ['src/a.ts', 'src/b.ts', 'src/other.ts'],
    mutatedPaths: [],
    continuationSnapshot: fpLoaded,
    seededPaths: split.unchanged,
    stalePaths: split.changed,
  });
  assert.match(seededNote, /Known paths \(unchanged on disk; read_before_write already satisfied\): src\/a\.ts\n/);
  assert.match(seededNote, /read_file again before mutating\): src\/b\.ts/);
  assert.doesNotMatch(seededNote, /Known paths[^\n]*src\/other\.ts/, 'session-wide paths are not announced as known');

  // Resume cap: exhausted state is kept so a repeated 「이어서」 stays exhausted.
  const { resolveContinuationResume } = await import('../core/dist/agent/agent-session-continuity.js');
  const {
    shouldKeepStoredContinuationOnTextComplete,
    carriedResumeCountOnReplace,
    CONTINUATION_UNSAVED_NOTICE,
  } = await import('../core/dist/agent/agent-session-continuity.js');
  assert.equal(
    shouldKeepStoredContinuationOnTextComplete({ toolNames: [], hadStoredContinuationAtStart: true }),
    true,
    'text-only turn keeps a stored run',
  );
  assert.equal(
    shouldKeepStoredContinuationOnTextComplete({ toolNames: ['active_task'], hadStoredContinuationAtStart: true }),
    true,
    'resume/discard alone is not work',
  );
  assert.equal(
    shouldKeepStoredContinuationOnTextComplete({ toolNames: ['read_file'], hadStoredContinuationAtStart: true }),
    false,
    'a work tool may complete the chain',
  );
  assert.equal(
    shouldKeepStoredContinuationOnTextComplete({ toolNames: [], hadStoredContinuationAtStart: false }),
    false,
    'no stored run means a text answer does not invent one',
  );
  assert.equal(carriedResumeCountOnReplace(0, 3), 3, 'replace without resume_run keeps the stored count');
  assert.equal(carriedResumeCountOnReplace(4, 3), 4, 'a higher in-run count is not lowered');
  assert.match(CONTINUATION_UNSAVED_NOTICE, /저장하지 못했습니다/);
  assert.match(stepLoopSrc, /shouldKeepStoredContinuationOnTextComplete/, 'text complete consults the keep rule');
  assert.match(stepLoopSrc, /carriedResumeCountOnReplace/, 'mutation replace carries resumeCount');
  assert.match(stepLoopSrc, /return finishKeptRun\(`Agent stopped: \$\{beforeModel\.reason\}`/, 'beforeModel hook stop saves resume state');
  assert.match(stepLoopSrc, /return finishKeptRun\(loopHardStop/, 'consecutive failure stop saves resume state');

  assert.equal(resolveContinuationResume({ hasSnapshot: true, snapshotResumeCount: 5, retry: false, max: 5 }).exhausted, true);
  assert.equal(
    resolveContinuationResume({ hasSnapshot: true, snapshotResumeCount: 5, retry: true, max: 5 }).exhausted,
    false,
    'host retry does not consume a resume',
  );
  const loopSrc = readFileSync(path.resolve('core/src/agent/agent-run-loop.ts'), 'utf8');
  const exhaustedBlock = loopSrc.slice(
    loopSrc.indexOf('if (continuationResume.exhausted)'),
    loopSrc.indexOf("reportStatus(`이어가기 한도 도달"),
  );
  assert.ok(exhaustedBlock.length > 0, 'exhausted branch present');
  assert.doesNotMatch(exhaustedBlock, /clearSessionContinuationState\(/, 'exhaustion must not reset the resume counter');
  assert.match(loopSrc, /modelId: ollama\.modelId,[\s\S]{0,200}continuationRetry: true/, 'host retry path sets continuationRetry');
  assert.match(loopSrc, /carriedResumeCountOnReplace/, 'host limit replace carries resumeCount');
  assert.match(loopSrc, /CONTINUATION_UNSAVED_NOTICE/, 'host limit does not claim a save it skipped');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('verify-session-continuity: ok');
