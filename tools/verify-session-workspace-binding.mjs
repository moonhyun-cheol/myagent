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
  resolveWorkspaceRootForMediaRequest,
  resolveWorkspaceRootForSession,
  resolveWorkspaceRootsForSession,
} from '../core/dist/chat/session-context.js';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';
import { validateScopeAllowedPaths } from '../core/dist/sessions/scope-path-validation.js';

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
  const originalUpdatedAt = sessions.load('chat-a').updated_at;
  sessions.setWorkspaceProject('chat-a', workspace.id);
  // Binding changes execution only, not ownership, model/memory, or ordering.
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), path.resolve(workspaceDir));
  assert.equal(sessions.load('chat-a').project_id, general.id);
  assert.equal(sessions.load('chat-a').updated_at, originalUpdatedAt);
  assert.equal(resolveSessionContextScope(sessions, projects, 'chat-a'), 'general_project');
  assert.equal(sessions.load('chat-a')?.workspace_project_id, workspace.id);
  assert.equal(sessions.list()[0]?.workspace_project_id, workspace.id);

  // Model and memory inherit from conversation ownership, not the execution binding.
  projects.setScopeSettings(general.id, { preferred_model: 'openai/project-model' });
  projects.setScopeSettings(workspace.id, {
    preferred_model: 'openai/workspace-model',
    allowed_paths: [workspaceDir, extraDir],
  });
  assert.equal(resolveMemoryProjectId(sessions, 'chat-a'), general.id);
  assert.equal(resolveRequestedModelForSession(sessions, projects, 'chat-a', 'auto'), 'openai/project-model');
  sessions.setProject('chat-a', null);
  assert.equal(resolveSessionContextScope(sessions, projects, 'chat-a'), 'standalone');
  // update 66: moving re-derives scope from the new sidebar location; the old
  // per-chat folder link does not follow the chat into 개인 작업.
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);
  assert.equal(sessions.load('chat-a')?.workspace_project_id, null);
  sessions.setWorkspaceProject('chat-a', workspace.id);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), path.resolve(workspaceDir));
  assert.equal(resolveMemoryProjectId(sessions, 'chat-a'), null);
  assert.equal(resolveRequestedModelForSession(sessions, projects, 'chat-a', 'auto'), 'auto');
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
  // Moving into a workspace re-derives the root; an explicit disconnect made
  // afterwards survives reload even when ownership itself has a root.
  sessions.setProject('chat-a', workspace.id);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), path.resolve(workspaceDir));
  sessions.setWorkspaceProject('chat-a', null);
  assert.equal(resolveWorkspaceRootForSession(new SessionStore(sessionsDir, temp), projects, 'chat-a'), null);
  assert.equal(resolveMemoryProjectId(sessions, 'chat-a'), workspace.id);
  sessions.setScopeSettings('chat-a', { allowed_paths: [extraDir] });
  sessions.setWorkspaceProject('chat-a', null);
  assert.deepEqual(sessions.load('chat-a').allowed_paths, []);
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'chat-a'), null);
  // Existing records without the explicit marker retain the old inheritance.
  sessions.ensure('legacy', { project_id: workspace.id });
  assert.equal(resolveWorkspaceRootForSession(sessions, projects, 'legacy'), path.resolve(workspaceDir));

  // Media requests that name a conversation read only that conversation's root.
  // A 개인 작업 chat has none, so the PC-wide default must not be substituted.
  sessions.ensure('solo');
  assert.equal(resolveWorkspaceRootForMediaRequest(sessions, projects, 'solo', outsideDir), null);
  assert.equal(resolveWorkspaceRootForMediaRequest(sessions, projects, 'legacy', outsideDir), path.resolve(workspaceDir));
  assert.equal(resolveWorkspaceRootForMediaRequest(sessions, projects, null, outsideDir), outsideDir);
  assert.equal(resolveWorkspaceRootForMediaRequest(sessions, projects, '', null), null);

  // Conversation allowed paths: any absolute folder is accepted, but it must pass the
  // same guard as a folder binding (exists, is a directory, NAS consent).
  const missingDir = path.join(temp, 'missing-dir');
  assert.deepEqual(validateScopeAllowedPaths([extraDir, ` ${extraDir} `, ''], { allowNas: false }), {
    ok: true,
    roots: [extraDir],
  });
  const missing = validateScopeAllowedPaths([extraDir, missingDir], { allowNas: false });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'ALLOWED_PATH_NOT_ALLOWED');
  assert.equal(missing.path, missingDir);
  const relative = validateScopeAllowedPaths(['relative\\dir'], { allowNas: false });
  assert.equal(relative.ok, false);
  assert.equal(relative.error, 'INVALID_ALLOWED_PATH');
  const nas = validateScopeAllowedPaths(['\\\\nas-host\\share\\folder'], { allowNas: false });
  assert.equal(nas.ok, false);
  assert.equal(nas.error, 'ALLOWED_PATH_NOT_ALLOWED');
  assert.equal(validateScopeAllowedPaths('C:\\x', { allowNas: false }).ok, false);
  // An entry already stored on the conversation does not block a later save.
  assert.deepEqual(validateScopeAllowedPaths([missingDir], { allowNas: false, existing: [missingDir] }), {
    ok: true,
    roots: [missingDir],
  });

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
  assert.match(dispatch, /resolveWorkspaceRootForMediaRequest\(/);
  assert.doesNotMatch(dispatch, /workspaceRootForRequest\(\)\s*\|\|/);
  assert.match(dispatch, /validateScopeAllowedPaths\(body\.allowed_paths/);
  assert.doesNotMatch(store, /membershipProjectId \?\? rec\.workspace_project_id/);
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
