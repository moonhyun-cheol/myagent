#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../core/dist/sessions/session-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'myagent-session-model-'));

try {
  const store = new SessionStore(temp, temp);
  store.ensure('chat-a');
  store.ensure('chat-b');

  assert.equal(store.setPreferredModel('chat-a', 'anthropic/claude-fable-5')?.preferred_model, 'anthropic/claude-fable-5');
  assert.equal(store.setPreferredModel('chat-b', 'openai/gpt-5.6')?.preferred_model, 'openai/gpt-5.6');
  assert.equal(store.load('chat-a')?.preferred_model, 'anthropic/claude-fable-5');
  assert.equal(store.load('chat-b')?.preferred_model, 'openai/gpt-5.6');
  assert.equal(store.publicRecord(store.load('chat-a')).preferred_model, 'anthropic/claude-fable-5');
  assert.equal(store.publicRecord(store.load('chat-b')).preferred_model, 'openai/gpt-5.6');
  assert.equal(store.setPreferredModel('chat-a', '   '), null);
  assert.equal(store.load('chat-a')?.preferred_model, 'anthropic/claude-fable-5');

  const workspace = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/myAgentClient.ts'), 'utf8');
  const chatPane = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
  const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');

  assert.match(client, /setSessionPreferredModel\(/);
  assert.match(dispatch, /\/preferred-model\$\/\)/);
  assert.match(workspace, /selectedModel: rec\.preferred_model \?\?/);
  assert.match(workspace, /await setSessionPreferredModel\(sessionId, selectedModel\)/);
  assert.match(workspace, /model: get\(\)\.selectedModel \|\| 'auto'/);
  assert.match(workspace, /sendAiMessage\(next\.text, next\.model\)/);
  assert.doesNotMatch(chatPane, /localStorage\.setItem\(MODEL_PREF_KEY/);

  console.log('session preferred model: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
