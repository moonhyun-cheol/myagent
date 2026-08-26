#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../core/dist/projects/project-store.js';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { resolveWorkspaceRootForSession } from '../core/dist/chat/session-context.js';

const root = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-session-workspace-'));

try {
  const sessionsDir = path.join(temp, 'sessions');
  const projectsDir = path.join(temp, 'projects');
  const workspaceDir = path.join(temp, 'workspace-a');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const projects = new ProjectStore(projectsDir, temp);
  const sessions = new SessionStore(sessionsDir, temp);
  const general = projects.create({ title: 'General project', kind: 'project' });
  const workspace = projects.upsertWorkspaceRoot(workspaceDir);
  sessions.ensure('chat-a', { project_id: general.id });

  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);
  sessions.setWorkspaceProject('chat-a', workspace.id);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), path.resolve(workspaceDir));
  assert.equal(sessions.load('chat-a')?.workspace_project_id, workspace.id);
  assert.equal(sessions.list()[0]?.workspace_project_id, workspace.id);
  sessions.setWorkspaceProject('chat-a', null);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);

  const ui = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
  const store = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/cqrClient.ts'), 'utf8');
  const orchestrator = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');

  assert.match(ui, /data-testid="chat-workspace-binding"/);
  assert.match(ui, /data-testid="chat-workspace-button"/);
  assert.match(ui, /data-testid="workspace-access-dialog"/);
  assert.match(ui, /작업폴더 없이 대화/);
  assert.match(ui, /이 채팅에만 적용됩니다/);
  assert.match(client, /X-CQR-Session/);
  assert.ok(dispatch.includes("url.pathname.match(/^\\/sessions\\/([^/]+)\\/workspace$/)"));
  assert.match(dispatch, /workspaceRootForRequest/);
  assert.match(orchestrator, /type: 'tool_complete'/);
  assert.match(store, /event\.tool === 'run_terminal'/);
  assert.match(store, /finishedJob\?\.terminalUsed/);
  assert.doesNotMatch(store, /Blink bottom terminal chrome so completion/);

  console.log('session workspace binding + terminal attention: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
