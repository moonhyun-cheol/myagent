#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUserOverrides, saveUserOverrides } from '../core/dist/config/user-overrides.js';
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

  // Focused new-chat + global default model contract (absorbed from the retired
  // one-off tools/verify-focused-new-chat-default-model.mjs).
  const configPath = path.join(temp, 'config', 'user-overrides.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  saveUserOverrides(configPath, { default_model: 'openai/gpt-test' }, temp);
  assert.equal(loadUserOverrides(configPath).default_model, 'openai/gpt-test');
  saveUserOverrides(configPath, { default_model: 'auto' }, temp);
  assert.equal(loadUserOverrides(configPath).default_model, 'auto');

  const projectsTree = readFileSync(path.join(root, 'ui/workspace/src/components/ProjectsTree.tsx'), 'utf8');
  const sidebar = readFileSync(path.join(root, 'ui/workspace/src/components/GeminiNavSidebar.tsx'), 'utf8');
  const modelModal = readFileSync(path.join(root, 'ui/workspace/src/components/ModelManagementModal.tsx'), 'utf8');

  // Both workspace-tree nodes and ordinary projects expose a context-menu action.
  assert.ok((projectsTree.match(/<ChatTeardropText size=\{13\} \/>새 대화/g) ?? []).length >= 2);
  assert.match(projectsTree, /const findWorkspaceTarget = \(id: string\)/);
  assert.match(projectsTree, /if \(target\) \{\s*\/\/ Keep project_id on the clicked node so the session renders inside that folder\/workspace\.\s*await startNewChat\(id, target\.root\.id\);/s);

  // The left-most action inherits the currently focused project/workspace binding.
  assert.match(sidebar, /const activeProjectId = useWorkspaceStore/);
  assert.match(sidebar, /const activeWorkspaceProjectId = useWorkspaceStore/);
  assert.match(sidebar, /activeProjectId === activeWorkspaceProjectId \? null : activeProjectId/);
  assert.match(sidebar, /startNewChat\(projectId, activeWorkspaceProjectId\)/);
  assert.match(sidebar, /label="현재 위치에 새 대화"/);

  // Model management edits only the persisted global override.
  assert.match(modelModal, /대화 기본 모델/);
  assert.match(modelModal, /fetchDefaultModelOverride\(\)/);
  assert.match(modelModal, /saveDefaultModelOverride\(value\)/);
  assert.match(client, /fetch\('\/config\/default-model'/);
  assert.match(dispatch, /saveUserOverrides\(userConfigPath, \{ default_model: defaultModel \}, cqrRoot\)/);

  // New conversations resolve session-specific preference before the global fallback.
  assert.match(workspace, /const globalDefaultModel = await fetchDefaultModelOverride\(\)\.catch\(\(\) => 'auto'\)/);
  assert.match(workspace, /selectedModel: rec\.preferred_model \?\? globalDefaultModel/);

  console.log('session preferred model + focused new chat + global default model: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
