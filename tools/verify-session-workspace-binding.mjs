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

  // Public SSE thought deltas are attached to the matching assistant message,
  // survive a disk reload, and remain separate from the model-facing content.
  sessions.beginAssistantThought('chat-a');
  sessions.appendAssistantThought('chat-a', '도구 확인\n');
  sessions.appendAssistantThought('chat-a', '수정 및 검증');
  sessions.append('chat-a', {
    role: 'assistant',
    content: '작업 완료',
    at: new Date().toISOString(),
    mode: 'web_dev',
  });
  const persistedThought = new SessionStore(sessionsDir, temp).load('chat-a')?.messages.at(-1);
  assert.equal(persistedThought?.thought, '도구 확인\n수정 및 검증');
  assert.equal(persistedThought?.content, '작업 완료');

  const ui = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
  const store = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/myAgentClient.ts'), 'utf8');
  const projectsTree = readFileSync(path.join(root, 'ui/workspace/src/components/ProjectsTree.tsx'), 'utf8');
  const app = readFileSync(path.join(root, 'ui/workspace/src/App.tsx'), 'utf8');
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
  assert.match(orchestrator, /this\.sessionStore\.beginAssistantThought\(sessionId\)/);
  assert.match(orchestrator, /this\.sessionStore\.appendAssistantThought\(sessionId, text\)/);
  assert.match(client, /thought\?: string/);
  assert.match(store, /thought: m\.role === 'assistant'.*m\.thought/s);
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
  assert.ok(projectsTree.includes('event.stopPropagation();'));
  assert.match(projectsTree, /onImportSession\(node\.id, workspaceRoot\.id\)/);
  assert.doesNotMatch(projectsTree, /onImportSession\(node\.kind === 'project' \? node\.id : null/);

  const imported = sessions.importPortable(
    {
      format: 'cqr-pa-conversation-session',
      conversation: {
        title: 'Imported workspace chat',
        messages: [{ role: 'user', content: 'hello', at: new Date().toISOString() }],
      },
    },
    workspace.id,
    workspace.id,
  );
  assert.equal(imported.project_id, workspace.id);
  assert.equal(imported.workspace_project_id, workspace.id);
  const tree = projects.buildNodeTree(workspace.id, sessions.list());
  assert.ok(tree?.sessions.some((session) => session.id === imported.id));

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

  console.log('session workspace binding + persisted model work log + scoped session pinning + native context-menu blocking + terminal attention + chat open scroll: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
