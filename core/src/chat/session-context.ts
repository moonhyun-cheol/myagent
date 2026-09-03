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

/** data dir derived from user-overrides.json path (data/config/user-overrides.json). */
function dataDirFromConfigPath(configPath: string): string {
  return path.dirname(path.dirname(configPath));
}

/**
 * Resolve the one active non-conversation scope.
 * Top-level workspace roots and projects are peers: a session belongs to one or
 * the other. `workspace_project_id` is only the filesystem binding when a
 * nested workspace node is selected through `project_id`.
 */
export function resolveSessionScopeProjectId(
  sessionStore: SessionStore,
  sessionId: string,
): string | null {
  const session = sessionStore.load(sessionId);
  return session?.project_id ?? session?.workspace_project_id ?? null;
}

/** Project id whose memory applies to this session (workspace node or general project). */
export function resolveMemoryProjectId(
  sessionStore: SessionStore,
  sessionId: string,
): string | null {
  return resolveSessionScopeProjectId(sessionStore, sessionId);
}

/** Explicit request wins; otherwise inherit conversation → project/workspace → global auto. */
export function resolveRequestedModelForSession(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
  requestedModel?: string | null,
): string {
  const requested = requestedModel?.trim();
  if (requested && requested !== 'auto') return requested;
  const session = sessionStore.load(sessionId);
  if (session?.preferred_model?.trim()) return session.preferred_model.trim();
  const projectId = resolveSessionScopeProjectId(sessionStore, sessionId);
  if (projectId) {
    const inherited = projectStore.resolvePreferredModelForProject(projectId);
    if (inherited) return inherited;
  }
  return requested || 'auto';
}

/** User memory (알잘딱) block: global, project, and conversation-scope fragments. */
export function buildUserMemoryContext(
  configPath: string,
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): string {
  try {
    const store = getUserMemoryStore(dataDirFromConfigPath(configPath));
    const projectId = resolveMemoryProjectId(sessionStore, sessionId);
    const title = projectId ? projectStore.get(projectId)?.title ?? null : null;
    const sessionTitle = sessionStore.load(sessionId)?.title ?? null;
    return store.formatForPrompt(projectId, title, sessionId, sessionTitle);
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
  const session = sessionStore.load(sessionId);
  // project_id is the active peer scope when present. A retained
  // workspace_project_id is only a dormant filesystem binding in that case.
  if (session?.project_id) {
    const project = projectStore.get(session.project_id);
    if (!project) return 'standalone';
    const kind = projectStore.resolveKind(project);
    return kind === 'project' ? 'general_project' : 'workspace_tree';
  }
  if (session?.workspace_project_id) return 'workspace_tree';
  return 'standalone';
}

export function resolveWorkspaceRootsForSession(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): string[] {
  const session = sessionStore.load(sessionId);
  const explicitRoots = session?.allowed_paths ?? [];
  if (explicitRoots.some((candidate) => candidate.trim())) {
    return [...new Set(explicitRoots.map((candidate) => candidate.trim()).filter(Boolean))];
  }
  const projectId = resolveSessionScopeProjectId(sessionStore, sessionId);
  if (!projectId) return [];
  return projectStore.resolveAllowedPathsForProject(projectId);
}

export function resolveWorkspaceRootForSession(
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
): string | null {
  return resolveWorkspaceRootsForSession(sessionStore, projectStore, sessionId)[0] ?? null;
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
  const session = sessionStore.load(sessionId);
  const contextProjectId = session?.project_id ?? session?.workspace_project_id;
  if (!contextProjectId) return '';
  const project = projectStore.get(contextProjectId);
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
  const session = sessionStore.load(sessionId);
  const contextProjectId = session?.project_id ?? session?.workspace_project_id;
  if (!contextProjectId) return '';
  const project = projectStore.get(contextProjectId);
  if (!project) return '';
  const kind = projectStore.resolveKind(project);
  if (kind !== 'workspace_root' && kind !== 'folder') return '';

  const root = projectStore.resolveWorkspaceRootForProject(contextProjectId);
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
  const location =
    kind === 'workspace_root'
      ? `작업 폴더「${project.title}」루트 아래 대화입니다.`
      : `작업 폴더 트리의「${project.title}」폴더 아래 대화입니다.`;
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

  if (shouldAttachDevWorkspaceTree(configPath, sessionStore, projectStore, sessionId, mode)) {
    const root = loadUserOverrides(configPath).dev_workspace_root;
    const base = buildDevWorkspaceContext(root, {}, {
      tier: 'agent',
      includeRepoMap: true,
      repoMapMaxChars: 6_000,
      focusMessage,
    });
    if (base.trim()) parts.push(base);
  }

  return parts.join('\n\n');
}
