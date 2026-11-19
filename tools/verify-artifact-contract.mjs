#!/usr/bin/env node
/**
 * Artifact contract goldens — normalize/merge, system note, and lock persistence.
 * Message-text inference was retired: contracts come only from labelled PLAN fields.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyArtifactContract,
  formatArtifactContractSystemNote,
  mergeArtifactContracts,
  normalizeArtifactContract,
} from '../core/dist/agent/agent-artifact-contract.js';
import {
  extractLockedConstraintsFromText,
  loadLockedConstraints,
  resolveLockedConstraintsForTurn,
  saveLockedConstraints,
} from '../core/dist/agent/agent-locked-constraints.js';

// --- normalize rejects unknown enum values ---
{
  const c = normalizeArtifactContract({ artifactKind: 'react', runtimeSurface: 'mars' });
  assert.equal(c.artifactKind, 'unknown');
  assert.equal(c.runtimeSurface, 'unknown');
  assert.equal(formatArtifactContractSystemNote(c), '');
}

// --- merge prefers locked kind ---
{
  const locked = emptyArtifactContract({ artifactKind: 'discord_bot', runtimeSurface: 'local_node' });
  const soft = emptyArtifactContract({ artifactKind: 'web_spa', runtimeSurface: 'browser' });
  const m = mergeArtifactContracts(locked, soft);
  assert.equal(m.artifactKind, 'discord_bot');
  assert.equal(m.runtimeSurface, 'local_node');
  assert.match(formatArtifactContractSystemNote(m), /FORBIDDEN: suggest or call OpenClaw/);
}

// --- labelled PLAN fields only ---
{
  const c = extractLockedConstraintsFromText([
    'PLAN:',
    '- P0: 신규 분리 | artifactKind: discord_bot | runtimeSurface: local_node | 필수 env: DISCORD_WEBHOOK_URL',
  ].join('\n'));
  assert.equal(c?.mode, 'new_separate');
  assert.equal(c?.artifactKind, 'discord_bot');
  assert.ok(c?.artifact?.requiredSecrets.includes('DISCORD_WEBHOOK_URL'));
  // Bare words in a P0 cell are not guessed into an artifactKind.
  const bare = extractLockedConstraintsFromText('PLAN:\n- P0: 기존 수정 | react | ui_shell');
  assert.equal(bare?.artifactKind, 'unknown');
}

// --- saved lock survives a contradicting user message (no prose re-judging) ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cqr-art-'));
const sessionId = 'artifact-contract';
try {
  const locked = extractLockedConstraintsFromText('PLAN:\n- P0: 신규 분리 | artifactKind: web_spa');
  saveLockedConstraints(tmp, sessionId, locked);
  const resolved = resolveLockedConstraintsForTurn({
    cqrRoot: tmp,
    sessionId,
    userMessage: '그게 아니라 웹앱이 아니다. Discord Bot Token 기반 일간 매크로.',
  });
  assert.ok(resolved, 'saved lock survives a contradicting message');
  assert.equal(resolved?.artifactKind, 'web_spa');
  assert.equal(loadLockedConstraints(tmp, sessionId)?.artifactKind, 'web_spa');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-artifact-contract: ok');
