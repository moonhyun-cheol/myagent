#!/usr/bin/env node
/**
 * Locked constraints: labelled PLAN fields only, history never parsed, retired invalidated records dropped.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  resolveLockedConstraintsForTurn,
  saveLockedConstraints,
  loadLockedConstraints,
  extractLockedConstraintsFromText,
  formatLockedConstraintsSystemNote,
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
  // Records written by the retired direction-reversal path are ignored (no _web_legacy note).
  fs.mkdirSync(path.join(tmp, 'data', 'agent-constraints'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'data', 'agent-constraints', `${sessionId}.json`),
    JSON.stringify({ mode: 'unknown', invalidated: true, invalidateReason: 'old', rawLines: ['INVALIDATED: old'] }),
  );
  assert.equal(loadLockedConstraints(tmp, sessionId), null);
  assert.equal(resolveLockedConstraintsForTurn({ cqrRoot: tmp, sessionId, userMessage: 'x' }), null);

  saveLockedConstraints(tmp, sessionId, structured);
  const live = resolveLockedConstraintsForTurn({ cqrRoot: tmp, sessionId, userMessage: 'x' });
  assert.equal(live?.mode, 'modify_existing');
  const note = formatLockedConstraintsSystemNote(live);
  assert.doesNotMatch(note, /INVALIDATED|_web_legacy/);
  assert.match(note, /mode: modify_existing/);


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
