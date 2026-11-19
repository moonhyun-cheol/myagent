#!/usr/bin/env node
/**
 * Locked constraints: labelled PLAN fields only, history never parsed, code-chip sticky clear.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  resolveLockedConstraintsForTurn,
  invalidateLockedConstraints,
  saveLockedConstraints,
  loadLockedConstraints,
  clearStickyInvalidation,
  extractLockedConstraintsFromText,
} = await import('../core/dist/agent/agent-locked-constraints.js');

assert.equal(
  extractLockedConstraintsFromText('Discord 봇을 새 프로젝트로 만들어줘'),
  null,
  'free-form prose must not create persistent constraints',
);
const structured = extractLockedConstraintsFromText([
  'PLAN:',
  '신규/기존: 기존 수정',
  'artifactKind: cli_tool',
  'runtimeSurface: local_node',
].join('\n'));
assert.equal(structured?.mode, 'modify_existing');
assert.equal(structured?.artifactKind, 'cli_tool');

// Labelled P0 field values are parsed; free prose inside the value is not mode-inferred.
assert.equal(
  extractLockedConstraintsFromText('PLAN:\n신규/기존: 그 파일 고쳐줘')?.mode,
  'unknown',
);
assert.deepEqual(
  extractLockedConstraintsFromText('PLAN:\n목표: x\n본문 중간에 손대지 말 것: core/ 이라고 썼다')?.doNotTouch ?? [],
  [],
  'mid-sentence do-not-touch mention is not a field',
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cqr-lock-'));
const sessionId = 'test-code-chip';
try {
  const invalidated = invalidateLockedConstraints(null, 'test');
  saveLockedConstraints(tmp, sessionId, invalidated);
  assert.equal(loadLockedConstraints(tmp, sessionId)?.invalidated, true);

  const cleared = resolveLockedConstraintsForTurn({
    cqrRoot: tmp,
    sessionId,
    userMessage: 'index.html app.js 수정해줘 즉시 mutate',
    agentMutateTurn: true,
  });
  assert.equal(cleared?.invalidated, false, 'code-chip AGENT clears sticky invalidation');
  assert.equal(loadLockedConstraints(tmp, sessionId)?.invalidated, false);

  const still = clearStickyInvalidation(invalidateLockedConstraints(null, 'x'));
  assert.equal(still?.invalidated, false);

  // No saved PLAN lock → earlier assistant prose is never parsed into constraints.
  assert.equal(
    resolveLockedConstraintsForTurn({
      cqrRoot: tmp,
      sessionId: 'no-lock',
      userMessage: 'x',
      history: [{ role: 'assistant', content: 'PLAN:\nP0: 기존 수정 | 손대지 말 것: core/' }],
    }),
    null,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-locked-constraints: ok');
