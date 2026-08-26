#!/usr/bin/env node
/**
 * Session continuity — readGate seed + continue-turn heuristics (no live LLM).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  appendSessionReadPaths,
  appendSessionMutatedPaths,
  formatActiveTaskSystemNote,
  loadAgentRunMeta,
  setSessionActiveTask,
} = await import('../core/dist/agent/agent-run-meta.js');
const { executeAgentTool } = await import('../core/dist/agent/agent-tool-execute.js');
const {
  shouldUseSessionContinuity,
  formatSessionContinuitySystemNote,
  seedReadGateFromSession,
  persistInterruptedAgentProgress,
  buildInterruptResumeOpenGate,
  flushLiveSessionProgress,
  isInterruptOpenGate,
} = await import('../core/dist/agent/agent-session-continuity.js');
const { WorkspaceReadGate } = await import('../core/dist/agent/tool-read-gate.js');
const { unreadPathsFromReadBeforeWriteError } = await import(
  '../core/dist/agent/tool-read-gate.js'
);
const { openGateBlocksDoneClaim } = await import('../core/dist/agent/agent-open-gate.js');

assert.equal(
  shouldUseSessionContinuity({
    userMessage: '추가해',
    openGate: null,
    readPaths: ['app.js'],
    mutatedPaths: [],
  }),
  false,
  'mutate verbs alone must not force continuity',
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '진행',
    openGate: null,
    readPaths: ['app.js'],
    mutatedPaths: ['app.js'],
  }),
  false,
  'PLAN 승인 + prior paths must not force continuity',
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '이어서 진행',
    openGate: null,
    readPaths: [],
    mutatedPaths: [],
  }),
  false,
  'bare continue with empty meta has nothing to resume',
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '이어서 진행',
    openGate: null,
    readPaths: ['app.js'],
    mutatedPaths: [],
  }),
  false,
  'natural-language wording must not toggle continuity',
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '새 기능 설계만 해줘',
    openGate: null,
    readPaths: ['app.js'],
    mutatedPaths: [],
  }),
  false,
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage: '아무거나',
    openGate: {
      updatedAt: new Date().toISOString(),
      status: 'open',
      gate: 'EURKRW 심볼 추가',
      source: 'manual',
    },
    readPaths: [],
    mutatedPaths: [],
  }),
  true,
);

const interruptGate = buildInterruptResumeOpenGate({
  mutatedPaths: ['app.js'],
  readPaths: [],
  userMessage: 'web_dev AGENT. 빈 워크스페이스에 구독형 도시락 앱을 만들어.',
});
assert.equal(isInterruptOpenGate(interruptGate), true);
assert.ok(interruptGate.gate.length <= 120, 'interrupt gate must stay short');

assert.equal(
  shouldUseSessionContinuity({
    userMessage: '권한 문제는?',
    openGate: interruptGate,
    readPaths: ['app.js'],
    mutatedPaths: ['app.js'],
  }),
  true,
  'structured openGate state owns continuity, not wording',
);
assert.equal(
  shouldUseSessionContinuity({
    userMessage:
      'web_dev AGENT. 빈 폴더에 부동산 분양 랜딩 + MARKET_REPORT + data.json을 한꺼번에 만들어.',
    openGate: interruptGate,
    readPaths: ['app.js'],
    mutatedPaths: ['app.js'],
  }),
  true,
  'structured openGate state remains authoritative',
);

const note = formatSessionContinuitySystemNote({
  readPaths: ['app.js', 'index.html'],
  mutatedPaths: ['app.js'],
  openGate: null,
});
assert.match(note, /Session continuity/);
assert.match(note, /app\.js/);

const interruptNote = formatSessionContinuitySystemNote({
  readPaths: ['a.ts'],
  mutatedPaths: ['a.ts'],
  openGate: buildInterruptResumeOpenGate({
    mutatedPaths: ['a.ts'],
    readPaths: [],
    userMessage: 'PiP 드래그',
  }),
});
assert.match(interruptNote, /interrupted|중단/i);

const gate = new WorkspaceReadGate();
seedReadGateFromSession(gate, ['app.js', 'styles.css']);
assert.equal(
  gate.assertCanMutate('edit_file', { path: 'app.js', old_text: 'a', new_text: 'b' }),
  null,
  'seeded path must pass read_before_write',
);
assert.ok(
  gate.assertCanMutate('edit_file', { path: 'never-read.js', old_text: 'a', new_text: 'b' }),
  'unknown path still blocked',
);
assert.deepEqual(
  unreadPathsFromReadBeforeWriteError(
    'ERROR: read_before_write\npath: src/app.js\nCall read_file…',
  ),
  ['src/app.js'],
);
assert.deepEqual(
  unreadPathsFromReadBeforeWriteError(
    'ERROR: read_before_write\nunread_paths: a.ts, b.ts\nCall read_file…',
  ),
  ['a.ts', 'b.ts'],
);

const tmp = mkdtempSync(path.join(tmpdir(), 'cqr-sess-cont-'));
try {
  appendSessionReadPaths(tmp, 's1', ['app.js']);
  appendSessionMutatedPaths(tmp, 's1', ['server.py']);
  const meta = loadAgentRunMeta(tmp, 's1');
  assert.ok(meta.readPaths?.includes('app.js'));
  assert.ok(meta.readPaths?.includes('server.py'), 'mutate also seeds readPaths');
  assert.ok(meta.mutatedPaths.includes('server.py'));

  flushLiveSessionProgress({
    cqrRoot: tmp,
    sessionId: 's2',
    mutatedPaths: ['ui/x.tsx'],
    readPaths: ['ui/x.tsx'],
  });
  const flushed = loadAgentRunMeta(tmp, 's2');
  assert.ok(flushed.mutatedPaths.includes('ui/x.tsx'));

  const interrupted = persistInterruptedAgentProgress({
    cqrRoot: tmp,
    sessionId: 's3',
    mutatedPaths: ['core/a.ts'],
    readPaths: ['core/a.ts'],
    userMessage: '타이틀바 고쳐',
  });
  assert.ok(interrupted.mutatedPaths.includes('core/a.ts'));
  assert.ok(openGateBlocksDoneClaim(interrupted.openGate));
  assert.match(interrupted.openGate.gate, /중단 복구|타이틀바/);

  // Second interrupt must not clobber an existing open gate.
  const again = persistInterruptedAgentProgress({
    cqrRoot: tmp,
    sessionId: 's3',
    mutatedPaths: ['other.ts'],
    readPaths: [],
    userMessage: '다른 작업',
  });
  assert.match(again.openGate.gate, /중단 복구|타이틀바/);
  assert.ok(again.mutatedPaths.includes('other.ts'));

  const emptyInterrupt = persistInterruptedAgentProgress({
    cqrRoot: tmp,
    sessionId: 's-empty',
    mutatedPaths: [],
    readPaths: [],
    userMessage: '큰 요청이지만 아직 mutate 없음',
  });
  assert.equal(
    openGateBlocksDoneClaim(emptyInterrupt.openGate),
    false,
    'empty breadcrumbs must not open interrupt gate',
  );

  const sticky = persistInterruptedAgentProgress({
    cqrRoot: tmp,
    sessionId: 's-sticky',
    mutatedPaths: ['old.js'],
    readPaths: [],
    userMessage: '이전 도시락 앱',
  });
  assert.ok(openGateBlocksDoneClaim(sticky.openGate));

  setSessionActiveTask(tmp, 's-task', {
    updatedAt: new Date().toISOString(),
    status: 'blocked',
    objective: '파일 트리 기본 열기 매핑 수정',
    acceptance: 'UI 진단과 빌드 성공',
    blocker: 'workspace root unavailable',
    relatedPaths: ['ui/workspace/src/components/AssetExplorer.tsx'],
  });
  const pending = loadAgentRunMeta(tmp, 's-task').activeTask;
  assert.equal(pending?.status, 'blocked');
  assert.match(formatActiveTaskSystemNote(pending), /silently forget/i);

  const rejected = await executeAgentTool(tmp, {
    id: 'task-reject',
    type: 'function',
    function: { name: 'active_task', arguments: JSON.stringify({ action: 'complete' }) },
  }, {}, {
    cqrRoot: tmp,
    sessionId: 's-task',
    getRunEvidence: () => ({ mutatedPaths: [], acceptanceOk: true }),
  });
  assert.match(rejected.output, /COMPLETION_REQUIRES_MUTATE_AND_EXPLICIT_ACCEPTANCE/);
  assert.equal(loadAgentRunMeta(tmp, 's-task').activeTask?.status, 'blocked');

  const diagnosticsOnly = await executeAgentTool(tmp, {
    id: 'task-diagnostics-only',
    type: 'function',
    function: { name: 'active_task', arguments: JSON.stringify({ action: 'complete' }) },
  }, {}, {
    cqrRoot: tmp,
    sessionId: 's-task',
    getRunEvidence: () => ({
      mutatedPaths: ['ui/workspace/src/components/AssetExplorer.tsx'],
      acceptanceOk: false,
    }),
  });
  assert.match(
    diagnosticsOnly.output,
    /COMPLETION_REQUIRES_MUTATE_AND_EXPLICIT_ACCEPTANCE/,
    'automatic diagnostics alone must not complete an active task',
  );
  assert.equal(loadAgentRunMeta(tmp, 's-task').activeTask?.status, 'blocked');

  const completed = await executeAgentTool(tmp, {
    id: 'task-complete',
    type: 'function',
    function: { name: 'active_task', arguments: JSON.stringify({ action: 'complete' }) },
  }, {}, {
    cqrRoot: tmp,
    sessionId: 's-task',
    getRunEvidence: () => ({
      mutatedPaths: ['ui/workspace/src/components/AssetExplorer.tsx'],
      acceptanceOk: true,
    }),
  });
  assert.match(completed.output, /\"status\":\"done\"/);
  assert.equal(loadAgentRunMeta(tmp, 's-task').activeTask?.status, 'done');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-session-continuity: ok');
