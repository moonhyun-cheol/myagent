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
const { loadAgentRunMeta } = await import('../core/dist/agent/agent-run-meta.js');

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('verify-session-continuity: ok');
