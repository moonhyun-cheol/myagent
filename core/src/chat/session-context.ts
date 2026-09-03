import type { ChatMode } from '../router/types.js';
import type { ChatRequest } from '../router/types.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ProjectStore } from '../projects/project-store.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import { buildDevWorkspaceContext } from '../agent/dev-workspace-fs.js';
import { buildEditorContextSnippet } from './editor-context.js';
import { isSkillChatMode } from '../skills/chat-skill-flow.js';
import { isUserSkillMode } from '../skills/user-skill-store.js';
import path from 'node:path';
import { getUserMemoryStore } from '../memory/user-memory-store.js';

export type SessionContextScope = 'standalone' | 'general_project' | 'workspace_tree';

export interface ResolvedSessionContext {
  scope: SessionContextScope;
  projectId: string | null;
  project: ReturnType<ProjectStore['get']>;
  workspaceProjectId: string | null;
  workspaceRoot: string | null;
}

/** Resolve visual membership and filesystem context from the same project tree. */
export function resolveSessionContext(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): ResolvedSessionContext {
  const projectId = sessionStore.load(sessionId)?.project_id ?? null;
  const project = projectId ? projectStore.get(projectId) : null;
  if (!projectId || !project) {
    return {
      scope: 'standalone',
      projectId: null,
      project: null,
      workspaceProjectId: null,
      workspaceRoot: null,
    };
  }

  let cursor: ReturnType<ProjectStore['get']> = project;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (projectStore.resolveKind(cursor) === 'workspace_root') {
      return {
        scope: 'workspace_tree',
        projectId,
        project,
        workspaceProjectId: cursor.id,
        workspaceRoot: cursor.folder_path?.trim() || null,
      };
    }
    cursor = cursor.parent_id ? projectStore.get(cursor.parent_id) : null;
  }

  return {
    scope: 'general_project',
    projectId,
    project,
    workspaceProjectId: null,
    workspaceRoot: null,
  };
}

/** data dir derived from user-overrides.json path (data/config/user-overrides.json). */
function dataDirFromConfigPath(configPath: string): string {
  return path.dirname(path.dirname(configPath));
}

/** Project id whose memory applies to this session (workspace node or general project). */
export function resolveMemoryProjectId(
  sessionStore: SessionStore,
  projectStoreOrSessionId: ProjectStore | string,
  maybeSessionId?: string,
): string | null {
  if (typeof projectStoreOrSessionId === 'string') {
    return sessionStore.load(projectStoreOrSessionId)?.project_id ?? null;
  }
  return resolveSessionContext(sessionStore, projectStoreOrSessionId, maybeSessionId ?? '').projectId;
}

/** User memory (알잘딱) block: global context + project-scope fragments. */
export function buildUserMemoryContext(
  configPath: string,
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): string {
  try {
    const store = getUserMemoryStore(dataDirFromConfigPath(configPath));
    const projectId = resolveMemoryProjectId(sessionStore, projectStore, sessionId);
    const title = projectId ? projectStore.get(projectId)?.title ?? null : null;
    return store.formatForPrompt(projectId, title);
  } catch {
    return ''; // memory must never break context assembly
  }
}

export function hasDevWorkspace(configPath: string): boolean {
  return Boolean(loadUserOverrides(configPath).dev_workspace_root?.trim());
}

export function getDevWorkspaceRoot(configPath: string): string {
  const root = loadUserOverrides(configPath).dev_workspace_root?.trim();
  if (!root) {
    throw new Error(
      'Dev workspace is not configured. Open Manager → set Dev workspace folder first.',
    );
  }
  return root;
}

/** Optional global work folder — does not throw when unset. */
export function tryGetDevWorkspaceRoot(configPath: string): string | null {
  return loadUserOverrides(configPath).dev_workspace_root?.trim() || null;
}

export function resolveSessionContextScope(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): SessionContextScope {
  return resolveSessionContext(sessionStore, projectStore, sessionId).scope;
}

export function resolveWorkspaceRootForSession(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): string | null {
  return resolveSessionContext(sessionStore, projectStore, sessionId).workspaceRoot;
}

export function shouldAttachDevWorkspaceTree(
  _configPath: string,
  _sessionStore: SessionStore,
  _projectStore: ProjectStore,
  _sessionId: string,
  _mode: ChatMode,
): boolean {
  // The PC-wide default may register/select a workspace, but never supplies
  // filesystem context to an unbound personal conversation.
  return false;
}

export function shouldAttachWorkspaceContext(
  _configPath: string,
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
  mode: ChatMode,
): boolean {
  if (
    mode === 'image_gen' ||
    mode === 'deep_research' ||
    mode === 'automaton_direct' ||
    isSkillChatMode(mode) ||
    isUserSkillMode(mode)
  ) {
    return false;
  }
  const scope = resolveSessionContextScope(sessionStore, projectStore, sessionId);
  // Code mode receives a filesystem tree only through explicit tree membership.
  if (mode === 'web_dev') {
    return scope === 'workspace_tree'
      && Boolean(resolveWorkspaceRootForSession(sessionStore, projectStore, sessionId));
  }
  if (mode !== 'chat') return false;
  return scope === 'general_project' || scope === 'workspace_tree';
}

function buildProjectContext(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): string {
  const context = resolveSessionContext(sessionStore, projectStore, sessionId);
  const contextProjectId = context.projectId;
  if (!contextProjectId) return '';
  const project = context.project;
  if (!project || projectStore.resolveKind(project) !== 'project') return '';
  const siblings = sessionStore
    .listByProject(contextProjectId)
    .filter((s) => s.id !== sessionId)
    .slice(0, 5)
    .map((s) => s.title)
    .filter(Boolean);
  const lines = [
    '## 현재 프로젝트',
    `이름: ${project.title}`,
    '이 프로젝트 맥락에 맞게 답변하세요.',
  ];
  if (siblings.length) {
    lines.push(`같은 프로젝트의 다른 대화: ${siblings.join(', ')}`);
  }
  return lines.join('\n');
}

function buildWorkspaceTreeContext(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
  focusMessage?: string,
): string {
  const context = resolveSessionContext(sessionStore, projectStore, sessionId);
  const contextProjectId = context.projectId;
  if (!contextProjectId) return '';
  const project = context.project;
  if (!project || context.scope !== 'workspace_tree') return '';
  const kind = projectStore.resolveKind(project);

  const root = context.workspaceRoot;
  if (!root) return '';

  const siblings = sessionStore
    .listByProject(contextProjectId)
    .filter((s) => s.id !== sessionId)
    .slice(0, 5)
    .map((s) => s.title)
    .filter(Boolean);

  const parts: string[] = [
    buildDevWorkspaceContext(root, {}, {
      tier: 'agent',
      includeRepoMap: true,
      repoMapMaxChars: 6_000,
      focusMessage,
    }),
  ];
  const location = kind === 'workspace_root'
    ? `작업 폴더「${project.title}」루트 아래 대화입니다.`
    : `작업 폴더 트리의「${project.title}」노드 아래 대화입니다.`;
  const meta = ['## 대화 위치', location, '이 작업 폴더 맥락에 맞게 답변하세요.'];
  if (siblings.length) {
    meta.push(`같은 위치의 다른 대화: ${siblings.join(', ')}`);
  }
  parts.push(meta.join('\n'));
  return parts.filter((p) => p.trim()).join('\n\n');
}

export function buildWorkspaceContext(
  configPath: string,
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  req: ChatRequest | undefined,
  sessionId: string,
  mode: ChatMode,
): string {
  const editor = buildEditorContextSnippet(req?.editor_context);
  const parts: string[] = [];
  if (editor) parts.push(editor);
  const focusMessage = typeof req?.message === 'string' ? req.message : undefined;

  // User memory (알잘딱): always attach when present, regardless of workspace scope.
  const memoryCtx = buildUserMemoryContext(configPath, sessionStore, projectStore, sessionId);
  if (memoryCtx) parts.push(memoryCtx);

  if (!shouldAttachWorkspaceContext(configPath, sessionStore, projectStore, sessionId, mode)) {
    return parts.join('\n\n');
  }

  const scope = resolveSessionContextScope(sessionStore, projectStore, sessionId);
  if (scope === 'general_project') {
    const projectCtx = buildProjectContext(sessionStore, projectStore, sessionId);
    if (projectCtx) parts.push(projectCtx);
  }
  if (scope === 'workspace_tree') {
    const wsCtx = buildWorkspaceTreeContext(sessionStore, projectStore, sessionId, focusMessage);
    if (wsCtx) parts.push(wsCtx);
  }

  return parts.join('\n\n');
}
