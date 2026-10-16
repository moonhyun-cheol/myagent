#!/usr/bin/env node
// update 66: the sidebar location is the only scope source (files, knowledge, location note),
// and deleting a folder lifts its chats and knowledge one level up instead of losing them.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../core/dist/projects/project-store.js';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { UserMemoryStore } from '../core/dist/memory/user-memory-store.js';
import {
  resolveSessionContextScope,
  resolveSessionScopeProjectId,
  resolveWorkspaceRootForSession,
} from '../core/dist/chat/session-context.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-location-scope-'));
try {
  const sessionsDir = path.join(temp, 'sessions');
  const projectsDir = path.join(temp, 'projects');
  const wsDir = path.join(temp, 'ws');
  for (const d of [sessionsDir, projectsDir, wsDir]) mkdirSync(d, { recursive: true });
  const projects = new ProjectStore(projectsDir, temp);
  const sessions = new SessionStore(sessionsDir, temp);
  const memory = new UserMemoryStore(path.join(temp, 'memory'));

  const ws = projects.upsertWorkspaceRoot(wsDir);
  const a = projects.create({ title: 'A', kind: 'folder', parent_id: ws.id });
  const b = projects.create({ title: 'B', kind: 'folder', parent_id: a.id });

  // Breadcrumb + chain, nearest first.
  assert.deepEqual(projects.ancestorChain(b.id).map((p) => p.id), [b.id, a.id, ws.id]);
  assert.equal(projects.pathLabel(b.id), `${ws.title} › A › B`);

  // Chat in a nested folder sees the workspace files.
  sessions.ensure('c-b', { project_id: b.id });
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'c-b'), path.resolve(wsDir));
  assert.equal(resolveSessionContextScope(sessions, projects, 'c-b'), 'workspace_tree');

  // 개인 작업 chat with a leftover (non-explicit) folder link sees nothing.
  sessions.ensure('c-solo', { project_id: null });
  const solo = sessions.load('c-solo');
  solo.workspace_project_id = ws.id;
  sessions.save(solo);
  assert.equal(resolveSessionScopeProjectId(sessions, 'c-solo'), null);
  assert.equal(resolveSessionContextScope(sessions, projects, 'c-solo'), 'standalone');
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'c-solo'), null);

  // Knowledge inheritance: nearest scope wins the budget, global cannot crowd it out.
  for (let i = 0; i < 20; i++) memory.add({ scope: 'global', text: `global filler ${i} ${'x'.repeat(150)}` });
  memory.add({ scope: 'project', project_id: b.id, text: 'B-only knowledge' });
  memory.add({ scope: 'project', project_id: ws.id, text: 'root knowledge' });
  const scopes = projects.ancestorChain(b.id).map((p) => ({ id: p.id, title: projects.pathLabel(p.id) }));
  const block = memory.formatForPrompt(scopes, 'c-b', 'chat');
  assert.match(block, /B-only knowledge/);
  assert.match(block, /root knowledge/);
  assert.match(block, /상위 위치 메모리/);
  assert.match(block, /분량 제한으로 \d+개 생략/);
  assert.ok(block.length <= 3_300, `prompt block too long: ${block.length}`);
  // Legacy string call still works.
  assert.match(memory.formatForPrompt(b.id), /B-only knowledge/);

  // Delete B (lift): chats and knowledge move to A, folder link cleared.
  const idsB = [b.id, ...projects.collectDescendantIds(b.id)];
  assert.equal(sessions.countInProjects(idsB), 1);
  assert.equal(memory.countByProject(idsB), 1);
  assert.equal(sessions.moveAllInProject(b.id, a.id), 1);
  assert.equal(memory.reassignProject(idsB, a.id), 1);
  memory.removeByProject(idsB);
  assert.ok(projects.delete(b.id));
  assert.equal(sessions.load('c-b').project_id, a.id);
  assert.equal(memory.countByProject([a.id]), 1);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'c-b'), path.resolve(wsDir));

  // Duplicate knowledge collapses on lift.
  memory.add({ scope: 'project', project_id: ws.id, text: 'dup' });
  memory.add({ scope: 'project', project_id: a.id, text: 'dup' });
  memory.reassignProject([a.id], ws.id);
  memory.removeByProject([a.id]);
  assert.equal(memory.countByProject([ws.id]), 3); // root knowledge + B-only + dup

  // Delete workspace root (lift to 개인 작업): chat stops seeing the folder.
  sessions.setWorkspaceProject('c-b', ws.id);
  sessions.moveAllInProject(a.id, null);
  assert.equal(sessions.load('c-b').project_id, null);
  assert.equal(sessions.load('c-b').workspace_project_id, null);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'c-b'), null);

  // Move (setProject) re-derives scope and drops per-chat path grants.
  sessions.setScopeSettings('c-b', { allowed_paths: [wsDir] });
  sessions.setProject('c-b', ws.id);
  assert.deepEqual(sessions.load('c-b').allowed_paths ?? [], []);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'c-b'), path.resolve(wsDir));

  // UI contracts: single location argument; no legacy unlink flag; export carries reasoning, not local ids.
  const ui = (p) => readFileSync(path.join(process.cwd(), 'ui/workspace/src', p), 'utf8');
  const client = ui('api/myAgentClient.ts');
  assert.doesNotMatch(client, /legacyWorkspaceProjectId/);
  assert.doesNotMatch(client, /\?unlink=1/);
  assert.match(client, /delete-preview/);
  const tree = ui('components/ProjectsTree.tsx');
  assert.match(tree, /fetchProjectDeletePreview/);
  assert.doesNotMatch(tree, /startNewChat\([^)]*,/);
  const pane = ui('components/ChatPane.tsx');
  assert.doesNotMatch(pane, /workspace_project_id: session\.workspace_project_id/);
  assert.match(pane, /reasoning: message\.reasoning/);
  assert.doesNotMatch(ui('components/GeminiNavSidebar.tsx'), /startNewChat\([^)]*,/);

  console.log('verify-location-scope: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
