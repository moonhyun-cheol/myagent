import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { getUserMemoryStore } from '../core/dist/memory/user-memory-store.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'memory-proposal-scope-'));
try {
  const store = getUserMemoryStore(path.join(root, 'data'));
  store.propose({
    scope: 'project',
    project_id: 'legacy-guessed-id',
    text: 'legacy misplaced candidate',
    reason: 'legacy regression fixture',
    source_session_id: 'session-a',
  });

  const call = (text, projectId) => executeAgentTool(root, {
    id: `memory-${text}`,
    type: 'function',
    function: {
      name: 'memory_propose',
      arguments: JSON.stringify({
        scope: 'project',
        project_id: 'model-guessed-id',
        text,
        reason: 'scope regression test',
      }),
    },
  }, {}, {
    cqrRoot: root,
    sessionId: 'session-a',
    memoryProjectId: projectId,
  });

  const saved = JSON.parse((await call('authoritative project candidate', 'actual-project-id')).output);
  assert.equal(saved.ok, true);
  assert.equal(saved.project_id, 'actual-project-id');

  assert.equal(store.list('actual-project-id', 'session-a').project.length, 2);
  assert.equal(store.list('legacy-guessed-id', 'session-a').project.length, 0);
  assert.equal(store.list('model-guessed-id', 'session-a').project.length, 0);

  const missing = JSON.parse((await call('must not use guessed project id', null)).output);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'PROJECT_REQUIRED');
  assert.equal(store.list('model-guessed-id', 'session-a').project.length, 0);

  console.log('PASS memory proposal scope: session-authoritative project id wins; legacy misplaced proposals recover; guessed ids are never persisted');
} finally {
  rmSync(root, { recursive: true, force: true });
}
