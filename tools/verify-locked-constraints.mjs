#!/usr/bin/env node
/**
 * Locked constraints: direction-reversal false positives + code-chip sticky clear.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  looksLikeDirectionReversal,
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

assert.equal(looksLikeDirectionReversal('아니지'), true);
assert.equal(looksLikeDirectionReversal('그게 아니라'), true);
assert.equal(
  looksLikeDirectionReversal(
    '기존 3파일을 교체한다. React 없음. 키가 없으면 mock으로 동작하고 키를 넣으면 실데이터.',
  ),
  false,
  'long mutate brief must not trip',
);
assert.equal(
  looksLikeDirectionReversal('파일 수정이 아니라 검색만'),
  false,
  'mid-sentence 아니라 must not trip',
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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-locked-constraints: ok');
