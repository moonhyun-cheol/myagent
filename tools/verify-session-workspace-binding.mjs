#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../core/dist/projects/project-store.js';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import {
  resolveMemoryProjectId,
  resolveRequestedModelForSession,
  resolveSessionContextScope,
  resolveWorkspaceRootForSession,
  resolveWorkspaceRootsForSession,
} from '../core/dist/chat/session-context.js';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';

const root = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-session-workspace-'));

try {
  const sessionsDir = path.join(temp, 'sessions');
  const projectsDir = path.join(temp, 'projects');
  const workspaceDir = path.join(temp, 'workspace-a');
  const extraDir = path.join(temp, 'workspace-extra');
  const outsideDir = path.join(temp, 'outside');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(extraDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const projects = new ProjectStore(projectsDir, temp);
  const sessions = new SessionStore(sessionsDir, temp);
  const general = projects.create({ title: 'General project', kind: 'project' });
  const workspace = projects.upsertWorkspaceRoot(workspaceDir);
  sessions.ensure('chat-a', { project_id: general.id });

  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);
  assert.equal(resolveSessionContextScope(sessions, projects, 'chat-a'), 'general_project');
  sessions.setWorkspaceProject('chat-a', workspace.id);
  // project_id remains the active peer scope; workspace_project_id is only a
  // dormant binding until this conversation is moved to the workspace scope.
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);
  assert.equal(resolveSessionContextScope(sessions, projects, 'chat-a'), 'general_project');
  assert.equal(sessions.load('chat-a')?.workspace_project_id, workspace.id);
  assert.equal(sessions.list()[0]?.workspace_project_id, workspace.id);

  // Workspace roots and top-level projects are peer scopes. A session resolves
  // exactly one of them; workspace binding is not an extra preference layer.
  projects.setScopeSettings(general.id, { preferred_model: 'openai/project-model' });
  projects.setScopeSettings(workspace.id, {
    preferred_model: 'openai/workspace-model',
    allowed_paths: [workspaceDir, extraDir],
  });
  assert.equal(resolveMemoryProjectId(sessions, 'chat-a'), general.id);
  assert.equal(resolveRequestedModelForSession(sessions, projects, 'chat-a', 'auto'), 'openai/project-model');
  sessions.setProject('chat-a', null);
  assert.equal(resolveSessionContextScope(sessions, projects, 'chat-a'), 'workspace_tree');
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), path.resolve(workspaceDir));
  assert.equal(resolveMemoryProjectId(sessions, 'chat-a'), workspace.id);
  assert.equal(resolveRequestedModelForSession(sessions, projects, 'chat-a', 'auto'), 'openai/workspace-model');
  assert.deepEqual(resolveWorkspaceRootsForSession(sessions, projects, 'chat-a'), [
    path.resolve(workspaceDir),
    path.resolve(extraDir),
  ]);

  // Every configured root participates in the real approval boundary. The
  // first root is only the relative-path base, not the sole effective grant.
  const roots = resolveWorkspaceRootsForSession(sessions, projects, 'chat-a');
  assert.equal(needsHumanApproval('write_file', { path: path.join(extraDir, 'ok.txt') }, {}, {
    workspaceRoot: roots[0],
    allowedWriteRoots: roots,
  }).needed, false);
  const externalWrite = needsHumanApproval('write_file', { path: path.join(outsideDir, 'blocked.txt') }, {}, {
    workspaceRoot: roots[0],
    allowedWriteRoots: roots,
  });
  assert.equal(externalWrite.needed, true);
  assert.equal(externalWrite.access, 'external_write');

  // Conversation settings override its one parent scope, including all paths.
  sessions.setScopeSettings('chat-a', {
    preferred_model: 'anthropic/conversation-model',
    allowed_paths: [extraDir, workspaceDir],
  });
  assert.equal(resolveRequestedModelForSession(sessions, projects, 'chat-a', 'auto'), 'anthropic/conversation-model');
  assert.deepEqual(resolveWorkspaceRootsForSession(sessions, projects, 'chat-a'), [
    path.resolve(extraDir),
    path.resolve(workspaceDir),
  ]);
  sessions.setScopeSettings('chat-a', { preferred_model: null, allowed_paths: [] });
  sessions.setWorkspaceProject('chat-a', null);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);

  // Public SSE thought deltas are normalized onto the matching assistant
  // response, survive disk reload, and stay separate from model-facing content.
  sessions.beginAssistantThought('chat-a');
  sessions.appendAssistantThought('chat-a', '도구 확인\n');
  sessions.appendAssistantThought('chat-a', '수정 및 검증');
  sessions.append('chat-a', {
    role: 'assistant',
    content: '작업 완료',
    at: new Date().toISOString(),
    mode: 'web_dev',
    model: 'openai/gpt-response-unit',
  });
  const persistedReasoning = new SessionStore(sessionsDir, temp).load('chat-a')?.messages.at(-1);
  assert.deepEqual(persistedReasoning?.reasoning, {
    version: 1,
    format: 'public_summary',
    content: '도구 확인\n수정 및 검증',
    model: 'openai/gpt-response-unit',
  });
  assert.equal(persistedReasoning?.thought, undefined);
  assert.equal(persistedReasoning?.content, '작업 완료');

  const ui = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
  const store = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/myAgentClient.ts'), 'utf8');
  const projectsTree = readFileSync(path.join(root, 'ui/workspace/src/components/ProjectsTree.tsx'), 'utf8');
  const app = readFileSync(path.join(root, 'ui/workspace/src/App.tsx'), 'utf8');
  const orchestrator = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');

  // Binding lives on tree / workspace-access dialog — not the chat policy popover.
  assert.doesNotMatch(ui, /data-testid="chat-workspace-binding"/);
  assert.doesNotMatch(ui, /이 채팅의 임시 작업폴더/);
  assert.match(ui, /data-testid="chat-workspace-button"/);
  assert.match(ui, /data-testid="workspace-access-dialog"/);
  assert.match(ui, /작업폴더 없이 대화/);
  assert.match(ui, /이 채팅에 작업폴더를 연결할까요/);
  assert.match(client, /X-CQR-Session/);
  assert.ok(dispatch.includes("url.pathname.match(/^\\/sessions\\/([^/]+)\\/workspace$/)"));
  assert.match(dispatch, /workspaceRootForRequest/);
  assert.match(orchestrator, /type: 'tool_complete'/);
  assert.match(orchestrator, /this\.sessionStore\.beginAssistantThought\(sessionId\)/);
  assert.match(orchestrator, /this\.sessionStore\.appendAssistantThought\(sessionId, text\)/);
  assert.match(client, /reasoning\?: \{/);
  assert.match(store, /m\.reasoning\?\.model \?\? m\.model/);
  assert.match(store, /m\.reasoning\?\.content/);
  assert.match(store, /event\.tool === 'run_terminal'/);
  assert.match(store, /finishedJob\?\.terminalUsed/);
  assert.doesNotMatch(store, /Blink bottom terminal chrome so completion/);

  // Session pins remain independent from node pins and are applied only to the
  // already-selected conversations inside each project/workspace container.
  assert.ok(projectsTree.includes("const PINNED_NODES_KEY = 'my-agent-workspace-pinned-nodes'"));
  assert.ok(projectsTree.includes('getPinnedSessionIds()'));
  assert.ok(projectsTree.includes('pinnedFirst((node.sessions ?? []).filter(matchSession), pinnedSessionIds)'));
  assert.ok(projectsTree.includes('pinnedFirst(sessions.filter(matchSession), pinnedSessionIds)'));
  assert.ok(projectsTree.includes('onToggleSessionPin'));
  assert.ok(projectsTree.includes('이 묶음에 대화 고정'));

  // The native browser/WebView context menu is disabled globally. Preventing
  // only the default action keeps the application-defined React handlers live.
  assert.match(app, /document\.addEventListener\('contextmenu', blockNativeContextMenu, true\)/);
  assert.match(app, /document\.removeEventListener\('contextmenu', blockNativeContextMenu, true\)/);
  assert.match(app, /const blockNativeContextMenu = \(event: MouseEvent\) => \{\s*event\.preventDefault\(\);\s*\}/);

  // Chat open scroll contract (absorbed from the retired one-off
  // tools/verify-chat-open-scroll.mjs): a conversation reopens at the position
  // last viewed on this PC, falling back to its latest turn on first open.
  assert.match(ui, /useLayoutEffect\(\(\) => \{/);
  assert.match(ui, /openedSessionRef\.current === activeSessionId/);
  assert.match(ui, /readChatScrollPosition\(activeSessionId\)/);
  assert.match(ui, /scroller\.scrollTop = savedPosition \?\? scroller\.scrollHeight/);
  assert.match(ui, /writeChatScrollPosition\(sessionId, scroller\.scrollTop\)/);
  assert.match(ui, /\[activeSessionId, chat\.length\]/);
  assert.doesNotMatch(ui, /\[activeSessionId, chat\]/);

  console.log('session workspace binding + peer scope settings + multi-root approval + normalized response reasoning + scoped session pinning + native context-menu blocking + terminal attention + chat open scroll: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
