/** MY Agent API client — Vite proxies these to :10200 */

import { confirmDialog } from '../lib/confirmDialog';
import { dismissUserNotification, showUserNotification } from '../lib/userNotifications';

const SESSION_KEY = 'my-agent-workspace-session';
const LEGACY_SESSION_KEY = 'cqr-workspace-session';
const PINNED_KEY = 'my-agent-workspace-pinned-sessions';
const LEGACY_PINNED_KEY = 'cqr-workspace-pinned-sessions';
// 서버 프로토콜이 전환될 때까지 유지하는 유일한 레거시 제품명 경계입니다.
const SESSION_HEADER = 'X-CQR-Session';

/** Sticky, single-step tool approval — no backdrop/Esc/Enter shortcuts. */
type ToolApprovalAccess = 'operation' | 'external_read' | 'external_write' | 'network';

async function askToolApprovalDecision(
  summary: string,
  danger: boolean,
  details?: { access?: ToolApprovalAccess; targets?: string[]; expires?: 'once' | 'run' },
): Promise<boolean> {
  const sticky = {
    allowBackdropDismiss: false,
    allowEscapeDismiss: false,
    allowEnterConfirm: false,
    autoFocusConfirm: false,
  } as const;

  const accessLabel = details?.access === 'external_read'
    ? '워크스페이스 외부 읽기'
    : details?.access === 'external_write'
      ? '워크스페이스 외부 쓰기'
      : details?.access === 'network'
        ? '외부 네트워크 접근'
        : '도구 실행';
  const targetText = details?.targets?.length
    ? `\n\n대상:\n${details.targets.slice(0, 5).map((target) => `• ${target}`).join('\n')}`
    : '';
  const expiryText = details?.expires === 'run'
    ? '\n\n허용 범위: 현재 작업이 끝날 때까지 해당 위치의 읽기만 허용'
    : '\n\n허용 범위: 이번 실행 1회';
  const approvalMessage = `${accessLabel}\n\n${summary}${targetText}${expiryText}`;
  const notificationId = showUserNotification({
    kind: 'approval',
    title: danger ? '위험 작업 승인이 필요합니다' : '승인이 필요합니다',
    message: summary,
    persistent: true,
    actionLabel: '검토하기',
    system: 'always',
  });
  try {
    return await confirmDialog({
      title: danger ? '위험 작업 승인' : '접근 승인',
      message: `${danger ? '[위험] ' : ''}${approvalMessage}`,
      danger,
      confirmLabel: '승인',
      cancelLabel: '거절',
      presentation: 'approval',
      ...sticky,
    });
  } finally {
    dismissUserNotification(notificationId);
  }
}

export type ChatApiMode =
  | 'chat'
  | 'web_dev'
  | 'image_gen'
  | 'deep_research'
  | string;

export interface SessionSummary {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
  project_id?: string | null;
  workspace_project_id?: string | null;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  model?: string;
  mode?: string;
  image_urls?: string[];
  workspace_behavior?: WorkspaceBehavior;
  plan_constraints_locked?: boolean;
}

export interface SessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: SessionMessage[];
  project_id?: string | null;
  workspace_project_id?: string | null;
  preferred_model?: string;
  execution_policy?: ExecutionPolicy;
}

export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high';
export type AgentAutopilotMode = 'auto' | 'on' | 'off';
export type ApprovalLevel = 'ask' | 'delegate' | 'autopilot';
export type WorkspaceBehavior = 'agent' | 'plan' | 'ask';
export interface ExecutionPolicy {
  reasoning: ReasoningLevel;
  autopilot: AgentAutopilotMode;
  approval: ApprovalLevel;
  workspace_behavior?: WorkspaceBehavior;
}
export interface EffectiveExecutionPolicy {
  reasoning: string | null;
  autopilot: boolean;
  approval: ApprovalLevel;
}

export interface SkillListItem {
  id: string;
  label: string;
  mode: string;
  source: 'bundled' | 'user' | 'organization';
  editable: boolean;
  removable?: boolean;
  install_kind?: 'prompt' | 'package';
  description?: string;
  file_count?: number;
  feature?: string;
  prompt?: string;
  anchors_ko?: string[];
  anchors_en?: string[];
}

export interface ProviderPublic {
  id: string;
  name: string;
  kind?: string;
  configured: boolean;
  key_hint?: string;
  wire_api: 'responses' | 'messages' | 'chat_completions';
  wire_api_confirmed: boolean;
  tool_protocol: 'native' | 'text';
  tool_protocol_confirmed: boolean;
  secret_storage: 'local_encrypted';
  secret_backend?: 'windows-dpapi' | 'macos-keychain' | 'memory-test';
  base_url?: string;
  model_id?: string;
  default_model?: string;
  custom?: boolean;
  user_defined?: boolean;
  compatibility?: 'openai' | 'anthropic';
  is_default?: boolean;
  note?: string;
}

export interface AutomationTaskTrigger {
  type: 'time' | 'sequence' | 'on_action' | 'condition' | 'manual';
  config: Record<string, unknown>;
}

export interface AutomationTask {
  id: string;
  name: string;
  description: string;
  instruction: string;
  triggers: AutomationTaskTrigger[];
  enabled: boolean;
  next_run_at: string | null;
  misfire_policy: 'skip' | 'run_once';
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

export type AutomationTaskInput = Pick<AutomationTask, 'name' | 'description' | 'instruction' | 'triggers' | 'enabled' | 'misfire_policy'>;

export async function listAutomationTasks(): Promise<AutomationTask[]> {
  const res = await fetch('/automations/tasks', { cache: 'no-store' });
  if (!res.ok) throw new Error(`자동화 작업을 불러오지 못했습니다. (${res.status})`);
  const payload = await res.json() as { tasks?: AutomationTask[] };
  return Array.isArray(payload.tasks) ? payload.tasks : [];
}

export async function saveAutomationTask(input: AutomationTaskInput, id?: string): Promise<AutomationTask> {
  const res = await fetch(id ? `/automations/tasks/${encodeURIComponent(id)}` : '/automations/tasks', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`자동화 작업을 저장하지 못했습니다. (${res.status})`);
  return res.json() as Promise<AutomationTask>;
}

export async function setAutomationTaskEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
  const res = await fetch(`/automations/tasks/${encodeURIComponent(id)}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`자동화 작업 상태를 변경하지 못했습니다. (${res.status})`);
  return res.json() as Promise<AutomationTask>;
}

export async function runAutomationTask(id: string): Promise<void> {
  const res = await fetch(`/automations/tasks/${encodeURIComponent(id)}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`자동화 작업을 실행하지 못했습니다. (${res.status})`);
}

export interface AutomationFeedAttachment {
  name: string;
  path?: string;
  mime?: string;
  size?: number;
}

export interface AutomationFeedItem {
  id: string;
  kind: 'result' | 'error' | 'status';
  title: string;
  message: string;
  attachments: AutomationFeedAttachment[];
  created_at: string;
  read_at: string | null;
}

export async function listAutomationFeed(limit = 30): Promise<AutomationFeedItem[]> {
  const res = await fetch(`/automations/feed?limit=${encodeURIComponent(String(limit))}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`자동화 자료를 불러오지 못했습니다. (${res.status})`);
  const payload = await res.json() as { items?: AutomationFeedItem[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

export function getStoredSessionId(): string | null {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) return stored;
  const legacy = localStorage.getItem(LEGACY_SESSION_KEY);
  if (legacy) localStorage.setItem(SESSION_KEY, legacy);
  return legacy;
}

export function setStoredSessionId(id: string): void {
  localStorage.setItem(SESSION_KEY, id);
  localStorage.removeItem(LEGACY_SESSION_KEY);
}

export function clearStoredSessionId(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(LEGACY_SESSION_KEY);
}

export function getPinnedSessionIds(): string[] {
  try {
    const stored = localStorage.getItem(PINNED_KEY);
    const legacy = stored === null ? localStorage.getItem(LEGACY_PINNED_KEY) : null;
    if (legacy !== null) localStorage.setItem(PINNED_KEY, legacy);
    const raw = JSON.parse(stored ?? legacy ?? '[]');
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

export function setPinnedSessionIds(ids: string[]): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  localStorage.removeItem(LEGACY_PINNED_KEY);
}

export interface StreamHandlers {
  onStatus?: (text: string) => void;
  onToken?: (text: string) => void;
  onContentReplace?: (text: string) => void;
  onImage?: (url: string) => void;
  onCode?: (label: string, text: string) => void;
  /** Workspace disk mutate paths from code agent (Preview「코드」auto-open). */
  onWorkspaceMutate?: (paths: string[]) => void;
  onThought?: (text: string) => void;
  onToolComplete?: (event: { tool: string; ok: boolean; durationMs: number }) => void;
  onExecutionPolicy?: (policy: {
    requested: ExecutionPolicy;
    effective: EffectiveExecutionPolicy;
  }) => void;
  /** Context budget snapshot from history compress (ChatPane gauge). */
  onContextBudget?: (snap: {
    usedChars?: number;
    budgetChars?: number;
    contextLength?: number;
    effectiveContextLength?: number;
    compressed?: boolean;
    fallback128k?: boolean;
    modelId?: string | null;
    foldedTurns?: number;
  }) => void;
  onDone?: (info: {
    model?: string;
    mode?: string;
    mutatedPaths?: string[];
    checkpointId?: string;
    planConstraintsLocked?: boolean;
    lastProcessedTokens?: number;
  }) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface PickerModel {
  id: string;
  label: string;
  access_mode?: 'auto' | 'managed' | 'byok' | 'local';
  provider_id?: string;
}

export async function fetchModelPicker(refreshRemote = false): Promise<{
  models: PickerModel[];
  default_id?: string;
  remote_errors?: Record<string, string>;
}> {
  const res = await fetch(`/models/picker${refreshRemote ? '?refresh=1' : ''}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`모델 목록 실패 (${res.status})`);
  const data = await res.json();
  const raw = Array.isArray(data.options)
    ? data.options
    : Array.isArray(data.models)
      ? data.models
      : Array.isArray(data.items)
        ? data.items
        : [];
  const models: PickerModel[] = raw
    .map(
      (m: {
        id?: string;
        value?: string;
        label?: string;
        name?: string;
        access_mode?: 'auto' | 'managed' | 'byok' | 'local';
        provider_id?: string;
      }) => ({
        id: String(m.value ?? m.id ?? ''),
        label: String(m.label ?? m.name ?? m.value ?? m.id ?? ''),
        access_mode: m.access_mode,
        provider_id: m.provider_id,
      }),
    )
    .filter((m: PickerModel) => m.id);
  const hintDefault =
    data.mode_hints?.chat?.value ??
    data.mode_hints?.web_dev?.value ??
    models.find((m) => m.id !== 'auto')?.id;
  return {
    models,
    default_id: data.default_id ?? data.default ?? hintDefault,
    remote_errors: data.remote_model_errors,
  };
}

export async function fetchLicense(): Promise<{ mode: string; features: string[] }> {
  const res = await fetch('/license/status');
  if (!res.ok) throw new Error(`라이선스 확인 실패 (${res.status})`);
  const data = await res.json();
  return {
    mode: data.mode ?? 'unknown',
    features: data.features ?? [],
  };
}

export interface SetupStatusPayload {
  needs_license: boolean;
  license_mode: string;
  org_id?: string;
  activation_mode: 'central' | 'none';
  activation_server_url?: string | null;
  activation_error?: string | null;
}

export async function fetchSetupStatus(): Promise<SetupStatusPayload> {
  const res = await fetch('/setup/status');
  if (!res.ok) throw new Error(`설정 상태 확인 실패 (${res.status})`);
  return (await res.json()) as SetupStatusPayload;
}

export interface OptionalRuntimeCatalogFeature {
  id: string;
  label: string;
  summary: string;
  detail?: string;
}

export interface OptionalRuntimeStatusItem {
  id: string;
  label: string;
  summary: string;
  detail?: string;
  size_hint?: string;
  selected: boolean;
  installed: boolean;
  missing_markers: string[];
}

export interface OptionalRuntimesPayload {
  catalog: {
    core_features: OptionalRuntimeCatalogFeature[];
    license_features: OptionalRuntimeCatalogFeature[];
    later_streams: OptionalRuntimeCatalogFeature[];
    optional_runtimes: OptionalRuntimeCatalogFeature[];
  };
  selection: { selected: string[]; skipped: string[] };
  optionals: OptionalRuntimeStatusItem[];
}

export async function fetchOptionalRuntimes(): Promise<OptionalRuntimesPayload> {
  const res = await fetch('/setup/optional-runtimes');
  if (!res.ok) throw new Error(`기능 목록 실패 (${res.status})`);
  return (await res.json()) as OptionalRuntimesPayload;
}

export async function installOptionalRuntimes(ids: string[]): Promise<{
  ok: boolean;
  installed: string[];
  log: string;
}> {
  const res = await fetch('/setup/optional-runtimes/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `기능 설치 실패 (${res.status})`);
  return data as { ok: boolean; installed: string[]; log: string };
}

export async function ensureSession(): Promise<string> {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) {
    const check = await fetch(`/sessions/${encodeURIComponent(existing)}`);
    if (check.ok) return existing;
    localStorage.removeItem(SESSION_KEY);
  }
  return createSession();
}

export async function createSession(projectId: string | null = null): Promise<string> {
  const res = await fetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(data.message || data.error || '세션 실패 · API 확인');
  }
  localStorage.setItem(SESSION_KEY, data.id);
  return data.id as string;
}

export type ProjectKind = 'workspace_root' | 'folder' | 'project';
export type ProjectColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'pink';

export interface WorkspaceNode {
  id: string;
  title: string;
  kind: ProjectKind;
  parent_id?: string | null;
  folder_path?: string | null;
  color?: ProjectColor | null;
  sessions: SessionSummary[];
  children: WorkspaceNode[];
  session_count: number;
}

export interface WorkspaceTreePayload {
  dev_workspace_root: string | null;
  active_workspace_project_id: string | null;
  workspace_trees: WorkspaceNode[];
  projects: Array<{
    id: string;
    title: string;
    kind?: ProjectKind;
    color?: ProjectColor | null;
    sessions: SessionSummary[];
    session_count: number;
  }>;
  standalone_sessions: SessionSummary[];
}

export interface FsBrowseResult {
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

export async function fetchWorkspaceTree(): Promise<WorkspaceTreePayload> {
  const res = await fetch(`/workspace?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`워크스페이스 로드 실패 (${res.status})`);
  return (await res.json()) as WorkspaceTreePayload;
}

export async function createProject(body: {
  title: string;
  kind?: 'folder' | 'project';
  parent_id?: string | null;
}): Promise<{ id: string; title: string; kind?: ProjectKind }> {
  const res = await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로젝트 생성 실패 (${res.status})`);
  return data;
}

export async function updateProject(id: string, body: { title?: string; color?: ProjectColor | null }): Promise<void> {
  const res = await fetch(`/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로젝트 수정 실패 (${res.status})`);
}

export async function updateProjectColor(id: string, color: ProjectColor | null): Promise<void> {
  return updateProject(id, { color });
}

export async function deleteProject(id: string, unlink = false): Promise<void> {
  const q = unlink ? '?unlink=1' : '';
  const res = await fetch(`/projects/${encodeURIComponent(id)}${q}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `삭제 실패 (${res.status})`);
}

export type UserMemoryScope = 'global' | 'project';

export interface UserMemoryEntry {
  id: string;
  scope: UserMemoryScope;
  project_id?: string | null;
  text: string;
  source: 'user' | 'auto';
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function listUserMemory(
  projectId?: string | null,
): Promise<{ global: UserMemoryEntry[]; project: UserMemoryEntry[] }> {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const res = await fetch(`/memory${q}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `메모리 로드 실패 (${res.status})`);
  return data as { global: UserMemoryEntry[]; project: UserMemoryEntry[] };
}

export async function addUserMemory(body: {
  scope: UserMemoryScope;
  project_id?: string | null;
  text: string;
}): Promise<UserMemoryEntry> {
  const res = await fetch('/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `메모리 추가 실패 (${res.status})`);
  return data as UserMemoryEntry;
}

export async function updateUserMemory(
  id: string,
  patch: { text?: string; enabled?: boolean },
): Promise<void> {
  const res = await fetch(`/memory/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `메모리 수정 실패 (${res.status})`);
}

export async function deleteUserMemory(id: string): Promise<void> {
  const res = await fetch(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `메모리 삭제 실패 (${res.status})`);
}

export async function setDevWorkspace(root: string): Promise<{
  ok?: boolean;
  active_workspace_project_id?: string;
  message?: string;
}> {
  const res = await fetch('/config/dev-workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dev_workspace_root: root }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `작업 폴더 저장 실패 (${res.status})`);
  return data;
}

export async function browseFs(path?: string): Promise<FsBrowseResult> {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fetch(`/fs/browse${q}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `폴더 탐색 실패 (${res.status})`);
  return data as FsBrowseResult;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/sessions');
  if (!res.ok) throw new Error(`세션 목록 실패 (${res.status})`);
  const data = await res.json();
  return (data.sessions ?? []) as SessionSummary[];
}

export async function fetchSession(id: string): Promise<SessionRecord> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`세션 로드 실패 (${res.status})`);
  return (await res.json()) as SessionRecord;
}

export async function setSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<SessionRecord> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로젝트 이동 실패 (${res.status})`);
  return data as SessionRecord;
}

export async function setSessionPreferredModel(
  sessionId: string,
  model: string,
): Promise<SessionRecord> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/preferred-model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `선호 모델 저장 실패 (${res.status})`);
  return data as SessionRecord;
}

export async function summarizeSession(
  sessionId: string,
  options: { createSession?: boolean; model?: string } = {},
): Promise<{ summary: string; session_id: string | null }> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      create_session: options.createSession === true,
      model: options.model || 'auto',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `대화 요약 실패 (${res.status})`);
  return {
    summary: String(data.summary ?? ''),
    session_id: typeof data.session_id === 'string' ? data.session_id : null,
  };
}

export async function renameSession(id: string, title: string): Promise<SessionRecord> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `세션 이름 변경 실패 (${res.status})`);
  return data as SessionRecord;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`세션 삭제 실패 (${res.status})`);
  if (localStorage.getItem(SESSION_KEY) === id) localStorage.removeItem(SESSION_KEY);
}

export async function undoSessionTurn(id: string): Promise<{ userText?: string; removed: number }> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/undo`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Undo 실패 (${res.status})`);
  }
  return {
    userText: typeof data.userText === 'string' ? data.userText : undefined,
    removed: Number(data.removed ?? 0),
  };
}

export interface LocalModelInfo {
  id: string;
  kind: 'llm' | 'image' | string;
  filename: string;
  size_bytes?: number;
  verified_ok?: boolean | null;
}

export interface ModelsDoc {
  models: LocalModelInfo[];
  default_llm_id?: string | null;
  default_image_id?: string | null;
  llama_binary?: { found?: boolean; path?: string };
}

export async function listLocalModels(): Promise<ModelsDoc> {
  const res = await fetch('/models');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `모델 목록 실패 (${res.status})`);
  return data as ModelsDoc;
}

export async function scanLocalModels(): Promise<ModelsDoc> {
  const res = await fetch('/models/scan', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `스캔 실패 (${res.status})`);
  return data as ModelsDoc;
}

export async function setLocalModelDefault(kind: 'llm' | 'image', id: string | null): Promise<ModelsDoc> {
  const res = await fetch('/models/default', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `기본 모델 설정 실패 (${res.status})`);
  return data as ModelsDoc;
}

export async function verifyLocalModel(id: string): Promise<{ ok?: boolean; message?: string }> {
  const res = await fetch(`/models/${encodeURIComponent(id)}/verify`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `검증 실패 (${res.status})`);
  return data;
}

export async function uploadLocalModels(files: FileList | File[]): Promise<unknown> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append('files', f);
  const res = await fetch('/models/upload', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `업로드 실패 (${res.status})`);
  return data;
}

export async function testProvider(id: string): Promise<{
  ok?: boolean;
  message?: string;
  note?: string;
  latency_ms?: number;
  wire_api?: ProviderPublic['wire_api'];
  tool_protocol?: ProviderPublic['tool_protocol'];
  native_tools_ok?: boolean;
}> {
  const res = await fetch(`/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.note || data.error || `연결 테스트 실패 (${res.status})`);
  return data;
}

export async function fetchLlmRuntimeStatus(): Promise<Record<string, unknown>> {
  const res = await fetch('/runtime/llm-status?fresh=1');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `런타임 상태 실패 (${res.status})`);
  return data as Record<string, unknown>;
}

export async function fetchAppConfig(): Promise<{
  local_only?: boolean;
  dev_workspace_root?: string;
  agent_autopilot?: boolean | null;
  agent_reasoning?: ReasoningLevel;
  approval_delegation?: 'off' | 'safe_local' | 'auto_review';
}> {
  const res = await fetch('/config');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `설정 로드 실패 (${res.status})`);
  return data;
}

export interface CompanyModelSettings {
  source: 'default' | 'personalized';
  selected: string[];
  defaults: string[];
  available: string[];
  featured: string[];
  recent: string[];
}

export async function fetchCompanyModelSettings(refreshRemote = false): Promise<CompanyModelSettings> {
  const res = await fetch(`/models/picker${refreshRemote ? '?refresh=1' : ''}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `MY 모델 목록 실패 (${res.status})`);
  if (!data.company_models) throw new Error('MY OpenRouter 연결을 먼저 설정하세요.');
  return data.company_models as CompanyModelSettings;
}

export async function saveCompanyModelSelection(modelIds: string[] | null): Promise<void> {
  const res = await fetch('/models/company-selection', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(modelIds === null ? { reset: true } : { model_ids: modelIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `MY 모델 저장 실패 (${res.status})`);
}

export interface WorkspaceCapabilities {
  root?: string;
  mode: 'read_write' | 'read_only' | 'restricted';
  readable: boolean;
  create_delete: boolean;
  tools?: { powershell: boolean; pwsh: boolean; git: boolean };
  office?: { files_present: number; lock_files: string[]; mutation_mode: 'versioned_copy' | 'read_only' };
  issues: Array<{ code: string; message: string }>;
}

export async function fetchWorkspaceCapabilities(): Promise<WorkspaceCapabilities> {
  const res = await fetch('/config/workspace-capabilities');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `작업환경 진단 실패 (${res.status})`);
  return data as WorkspaceCapabilities;
}

export async function setApprovalDelegation(mode: 'off' | 'safe_local' | 'auto_review'): Promise<unknown> {
  const res = await fetch('/config/approval-delegation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approval_delegation: mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `승인 위임 설정 실패 (${res.status})`);
  return data;
}

export const AGENT_AUTOPILOT_CHANGED_EVENT = 'my-agent:agent-autopilot-changed';

export function agentAutopilotModeFromConfig(value: boolean | null | undefined): AgentAutopilotMode {
  return value === true ? 'on' : value === false ? 'off' : 'auto';
}

export async function setAgentAutopilot(mode: AgentAutopilotMode): Promise<unknown> {
  const value = mode === 'on' ? true : mode === 'off' ? false : null;
  const res = await fetch('/config/agent-autopilot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_autopilot: value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Autopilot 설정 실패 (${res.status})`);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AGENT_AUTOPILOT_CHANGED_EVENT, { detail: { mode } }));
  }
  return data;
}

export async function setAgentExecutionPreset(): Promise<unknown> {
  const res = await fetch('/config/agent-execution-preset', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: 'delegate' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `나 대신 진행 설정 실패 (${res.status})`);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AGENT_AUTOPILOT_CHANGED_EVENT, { detail: { mode: 'on' } }));
  }
  return data;
}

export async function setAgentReasoning(reasoning: ReasoningLevel): Promise<unknown> {
  const res = await fetch('/config/agent-reasoning', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_reasoning: reasoning }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `추론 기본값 저장 실패 (${res.status})`);
  return data;
}

export async function setSessionExecutionPolicy(
  sessionId: string,
  policy: ExecutionPolicy,
): Promise<SessionRecord> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/execution-policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policy),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `채팅 실행 정책 저장 실패 (${res.status})`);
  return data as SessionRecord;
}

export async function setSessionWorkspaceProject(
  sessionId: string,
  workspaceProjectId: string | null,
): Promise<SessionRecord> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_project_id: workspaceProjectId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `채팅 작업 폴더 저장 실패 (${res.status})`);
  return data as SessionRecord;
}

export async function setLocalOnly(localOnly: boolean): Promise<unknown> {
  const res = await fetch('/config/local-only', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ local_only: localOnly }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `로컬 전용 설정 실패 (${res.status})`);
  return data;
}

export interface WorkspaceFsTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: WorkspaceFsTreeNode[];
}

export async function fetchWorkspaceFsTree(depth = 3): Promise<{
  root: string | null;
  tree: WorkspaceFsTreeNode[];
  message?: string;
}> {
  const sessionId = getStoredSessionId();
  const res = await fetch(`/fs/workspace-tree?depth=${depth}&_=${Date.now()}`, {
    cache: 'no-store',
    headers: sessionId ? { [SESSION_HEADER]: sessionId } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `파일 트리 실패 (${res.status})`);
  return data as { root: string | null; tree: WorkspaceFsTreeNode[]; message?: string };
}

export async function openWorkspaceRootInExplorer(): Promise<{ ok: true; root: string }> {
  const sessionId = getStoredSessionId();
  const res = await fetch('/fs/open-workspace-root', {
    method: 'POST',
    headers: sessionId ? { [SESSION_HEADER]: sessionId } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `탐색기 실행 실패 (${res.status})`);
  return data as { ok: true; root: string };
}

export async function openWorkspacePathInExplorer(relPath: string): Promise<{ ok: true; path: string }> {
  const sessionId = getStoredSessionId();
  const res = await fetch('/fs/open-workspace-path', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify({ path: relPath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `경로 열기 실패 (${res.status})`);
  return data as { ok: true; path: string };
}

export async function readWorkspaceFsFile(relPath: string): Promise<{ path: string; content: string }> {
  const sessionId = getStoredSessionId();
  const res = await fetch(`/fs/workspace-file?path=${encodeURIComponent(relPath)}`, {
    headers: sessionId ? { [SESSION_HEADER]: sessionId } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `파일 읽기 실패 (${res.status})`);
  return data as { path: string; content: string };
}

export async function writeWorkspaceFsFile(relPath: string, content: string): Promise<{ ok: true; path: string }> {
  const sessionId = getStoredSessionId();
  const res = await fetch('/fs/workspace-file', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify({ path: relPath, content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `파일 저장 실패 (${res.status})`);
  return data as { ok: true; path: string };
}

export async function renameWorkspaceFsFile(
  relPath: string,
  name: string,
): Promise<{ ok: true; path: string }> {
  const sessionId = getStoredSessionId();
  const res = await fetch('/fs/workspace-file/rename', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify({ path: relPath, name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `이름 변경 실패 (${res.status})`);
  return data as { ok: true; path: string };
}

export interface RunTerminalPayload {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  command: string;
  cwd: string;
  cancelled?: boolean;
  job_id?: string;
}

export async function runWorkspaceTerminal(
  command: string,
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    async?: boolean;
    jobId?: string;
  },
): Promise<RunTerminalPayload> {
  const sessionId = getStoredSessionId();
  const res = await fetch('/fs/run-terminal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify({
      command,
      timeout_ms: opts?.timeoutMs ?? 180_000,
      async: opts?.async !== false,
      job_id: opts?.jobId,
    }),
    signal: opts?.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `터미널 실행 실패 (${res.status})`);
  }
  return data as RunTerminalPayload;
}

export async function listSkills(): Promise<SkillListItem[]> {
  const res = await fetch('/skills');
  if (!res.ok) throw new Error(`스킬 목록 실패 (${res.status})`);
  const data = await res.json();
  return (data.skills ?? []) as SkillListItem[];
}

export interface OrganizationModuleStatus {
  installed: {
    id: string;
    version: string;
    update_sequence: number;
    required_core_api: string;
    update_feed_url?: string;
    capabilities: string[];
    components: OrganizationModuleComponent[];
    root: string;
  } | null;
  /** Bootstrap or installed feed; null if remote check unavailable. */
  feed_url?: string | null;
  can_check_remote?: boolean;
}

export interface OrganizationModuleComponent {
  id: string;
  version: string;
}

export interface OrganizationModuleUpdate {
  sequence: number;
  version: string;
  channel: string;
  assetName: string;
  feedUrl: string;
  first_install?: boolean;
}

export async function fetchOrganizationModule(): Promise<OrganizationModuleStatus> {
  const res = await fetch('/organization-module');
  if (!res.ok) throw new Error(`조직 모듈 상태 실패 (${res.status})`);
  return (await res.json()) as OrganizationModuleStatus;
}

export async function checkOrganizationModule(): Promise<OrganizationModuleUpdate | null> {
  const res = await fetch('/organization-module/check', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `조직 모듈 확인 실패 (${res.status})`);
  return (data.update ?? null) as OrganizationModuleUpdate | null;
}

export async function applyOrganizationModule(): Promise<void> {
  const res = await fetch('/organization-module/apply', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `조직 모듈 업데이트 실패 (${res.status})`);
}

export async function installOrganizationModule(zipPath: string): Promise<OrganizationModuleStatus['installed']> {
  const res = await fetch('/organization-module/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zip_path: zipPath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `회사 팩 설치 실패 (${res.status})`);
  return (data.installed ?? null) as OrganizationModuleStatus['installed'];
}

export async function fetchSkill(id: string): Promise<SkillListItem> {
  const res = await fetch(`/skills/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`스킬 로드 실패 (${res.status})`);
  return (await res.json()) as SkillListItem;
}

export async function createSkill(body: {
  id: string;
  label: string;
  prompt: string;
  anchors_ko?: string[];
  anchors_en?: string[];
}): Promise<SkillListItem> {
  const res = await fetch('/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `스킬 생성 실패 (${res.status})`);
  return data as SkillListItem;
}

export async function updateSkill(
  id: string,
  body: { label?: string; prompt?: string; anchors_ko?: string[]; anchors_en?: string[] },
): Promise<SkillListItem> {
  const res = await fetch(`/skills/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `스킬 수정 실패 (${res.status})`);
  return data as SkillListItem;
}

export async function deleteSkill(id: string): Promise<void> {
  const res = await fetch(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `스킬 삭제 실패 (${res.status})`);
}

/** Local agent plugin (tools under data/agent-plugins — not prompt skills). */
export interface AgentPluginListItem {
  id: string;
  name: string;
  enabled: boolean;
  risk: string;
  description?: string;
  runner?: string;
  lab_smoke?: boolean;
}

export interface AgentPluginTemplateItem {
  id: string;
  name: string;
  description: string;
  risk: string;
}

export async function listAgentPlugins(): Promise<{
  plugins: AgentPluginListItem[];
  templates: AgentPluginTemplateItem[];
  lab_smoke_count?: number;
}> {
  const res = await fetch('/agent-plugins');
  if (!res.ok) throw new Error(`플러그인 목록 실패 (${res.status})`);
  const data = await res.json();
  return {
    plugins: (data.plugins ?? []) as AgentPluginListItem[],
    templates: (data.templates ?? []) as AgentPluginTemplateItem[],
    lab_smoke_count: typeof data.lab_smoke_count === 'number' ? data.lab_smoke_count : undefined,
  };
}

export async function listAgentPluginTemplates(): Promise<AgentPluginTemplateItem[]> {
  const res = await fetch('/agent-plugins/templates');
  if (!res.ok) throw new Error(`플러그인 템플릿 목록 실패 (${res.status})`);
  const data = await res.json();
  return (data.templates ?? []) as AgentPluginTemplateItem[];
}

/** Install from tools/plugin-templates/{template_id}. Requires confirm=true. */
export async function installAgentPluginFromTemplate(body: {
  template_id: string;
  id?: string;
  confirm: true;
}): Promise<{ ok: boolean; id?: string; name?: string; error?: string }> {
  const res = await fetch('/agent-plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error || data.message || `플러그인 설치 실패 (${res.status})`,
    );
  }
  return data as { ok: boolean; id?: string; name?: string; error?: string };
}

export async function setAgentPluginEnabled(
  id: string,
  body: { enabled: boolean; confirm: true },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/agent-plugins/${encodeURIComponent(id)}/enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error || data.message || `플러그인 켜기/끄기 실패 (${res.status})`,
    );
  }
  return data as { ok: boolean; error?: string };
}

export async function uninstallAgentPlugin(
  id: string,
  body: { confirm: true } = { confirm: true },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/agent-plugins/${encodeURIComponent(id)}?confirm=1`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `플러그인 삭제 실패 (${res.status})`);
  }
  return data as { ok: boolean; error?: string };
}

export async function purgeLabSmokePlugins(): Promise<{
  ok: boolean;
  removed?: string[];
  count?: number;
  error?: string;
}> {
  const res = await fetch('/agent-plugins/purge-lab-smoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `랩 스모크 정리 실패 (${res.status})`);
  }
  return data as { ok: boolean; removed?: string[]; count?: number; error?: string };
}

export async function listProviders(): Promise<ProviderPublic[]> {
  const res = await fetch('/providers');
  if (!res.ok) throw new Error(`프로바이더 목록 실패 (${res.status})`);
  const data = await res.json();
  return (data.providers ?? []) as ProviderPublic[];
}

export async function saveProviderKey(
  id: string,
  body: {
    api_key: string;
    base_url?: string;
    model_id?: string;
    name?: string;
  },
): Promise<ProviderPublic[]> {
  const res = await fetch(`/providers/${encodeURIComponent(id)}/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `키 저장 실패 (${res.status})`);
  return (data.providers ?? []) as ProviderPublic[];
}

export async function createUserProvider(body: {
  name: string;
  base_url: string;
  model_id: string;
  api_key: string;
  compatibility: 'openai' | 'anthropic';
}): Promise<ProviderPublic[]> {
  const res = await fetch('/providers/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `개인 API 추가 실패 (${res.status})`);
  return (data.providers ?? []) as ProviderPublic[];
}

export async function deleteUserProvider(id: string): Promise<ProviderPublic[]> {
  const res = await fetch(`/providers/user/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `개인 API 삭제 실패 (${res.status})`);
  return (data.providers ?? []) as ProviderPublic[];
}

export async function deleteProviderKey(id: string): Promise<ProviderPublic[]> {
  const res = await fetch(`/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `키 삭제 실패 (${res.status})`);
  return (data.providers ?? []) as ProviderPublic[];
}

export async function setDefaultProvider(id: string | null): Promise<ProviderPublic[]> {
  const res = await fetch('/providers/default', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `기본 프로바이더 설정 실패 (${res.status})`);
  return (data.providers ?? []) as ProviderPublic[];
}

export async function fetchErrorReportStatus(): Promise<{
  configured: boolean;
  enabled: boolean;
  storage?: 'local_jsonl';
  log_path?: string;
}> {
  const res = await fetch('/error-report/status');
  if (!res.ok) throw new Error(`오류 보고 상태 실패 (${res.status})`);
  const data = await res.json();
  return {
    configured: data.configured === true,
    enabled: data.enabled === true,
    storage: data.storage,
    log_path: data.log_path,
  };
}

export async function sendErrorReport(note?: string): Promise<{ ok: boolean; message?: string; report_id?: string; log_path?: string }> {
  const res = await fetch('/error-report/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note ?? '' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, message: data.message || data.error || `전송 실패 (${res.status})` };
  }
  return { ok: true, message: data.message ?? '로컬 기록이 저장되었습니다.', report_id: data.report_id, log_path: data.log_path };
}

function parseSseBlocks(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: unknown[] = [];
  for (const block of parts) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* skip */
    }
  }
  return { events, rest };
}

export interface UploadedAttachment {
  id: string;
  name: string;
  mime?: string;
}

export async function uploadAttachments(files: File[]): Promise<UploadedAttachment[]> {
  if (!files.length) return [];
  const sessionId = await ensureSession();
  const form = new FormData();
  for (const file of files) form.append('file', file, file.name);
  const res = await fetch('/attachments', {
    method: 'POST',
    headers: { [SESSION_HEADER]: sessionId },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message ?? `업로드 실패 (${data.error ?? res.status})`);
  }
  return (data.attachments ?? []).map((item: { id?: string; name?: string; mime?: string }) => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? 'image'),
    mime: item.mime,
  })).filter((a: UploadedAttachment) => a.id);
}

export async function deleteAttachment(id: string): Promise<void> {
  const sessionId = await ensureSession();
  await fetch(`/attachments/${encodeURIComponent(id)}?session=${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  }).catch(() => {});
}

export async function streamChat(
  opts: {
    message: string;
    mode?: ChatApiMode;
    model?: string;
    execution_policy?: ExecutionPolicy;
    attachments?: string[];
    editor_context?: {
      path: string;
      selection?: string;
      error_snippet?: string;
      paths?: string[];
    };
    /** Explicit session (queue jobs must not use the viewed session). */
    sessionId?: string;
  },
  handlers: StreamHandlers,
): Promise<void> {
  const sessionId = opts.sessionId ?? (await ensureSession());
  const body: Record<string, unknown> = {
    message: opts.message,
    model: opts.model ?? 'auto',
    attachments: opts.attachments ?? [],
  };
  if (opts.execution_policy) body.execution_policy = opts.execution_policy;
  if (opts.mode && opts.mode !== 'chat') body.mode = opts.mode;
  if (opts.editor_context) body.editor_context = opts.editor_context;

  const res = await fetch('/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_HEADER]: sessionId,
    },
    signal: handlers.signal,
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? '권한 없음');
  }
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`채팅 실패 (HTTP ${res.status}) ${errText.slice(0, 120)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBlocks(buffer);
    buffer = parsed.rest;
    for (const raw of parsed.events) {
      const evt = raw as Record<string, unknown>;
      const type = evt.type as string;
      if (type === 'status' && typeof evt.text === 'string') handlers.onStatus?.(evt.text);
      else if (type === 'token' && typeof evt.text === 'string') handlers.onToken?.(evt.text);
      else if (type === 'content_replace' && typeof evt.text === 'string') {
        handlers.onContentReplace?.(evt.text);
      } else if (type === 'thought' && typeof evt.text === 'string') handlers.onThought?.(evt.text);
      else if (type === 'execution_policy' && evt.requested && evt.effective) {
        handlers.onExecutionPolicy?.({
          requested: evt.requested as unknown as ExecutionPolicy,
          effective: evt.effective as unknown as EffectiveExecutionPolicy,
        });
      }
      else if (type === 'context_budget') {
        const snap = (evt.contextBudget ?? evt) as Record<string, unknown>;
        handlers.onContextBudget?.({
          usedChars: typeof snap.usedChars === 'number' ? snap.usedChars : undefined,
          budgetChars: typeof snap.budgetChars === 'number' ? snap.budgetChars : undefined,
          compressed: Boolean(snap.compressed),
          fallback128k: Boolean(snap.fallback128k),
          modelId: typeof snap.modelId === 'string' ? snap.modelId : null,
          foldedTurns: typeof snap.foldedTurns === 'number' ? snap.foldedTurns : undefined,
        });
      } else if (type === 'code' && typeof evt.text === 'string') {
        handlers.onCode?.(String(evt.label ?? 'code'), evt.text);
      } else if (type === 'workspace_mutate') {
        const raw = Array.isArray(evt.paths) ? evt.paths : [];
        const paths = raw
          .map((p) => String(p ?? '').replace(/\\/g, '/').trim())
          .filter(Boolean);
        if (paths.length) handlers.onWorkspaceMutate?.(paths);
      } else if (type === 'tool_complete' && typeof evt.tool === 'string') {
        handlers.onToolComplete?.({
          tool: evt.tool,
          ok: Boolean(evt.ok),
          durationMs: typeof evt.durationMs === 'number' ? evt.durationMs : 0,
        });
      } else if (type === 'image') {
        const img = evt.image as { url?: string } | undefined;
        if (img?.url) handlers.onImage?.(img.url);
      } else if (type === 'done') {
        const raw = Array.isArray(evt.mutatedPaths) ? evt.mutatedPaths : [];
        const mutatedPaths = raw
          .map((p) => String(p ?? '').replace(/\\/g, '/').trim())
          .filter(Boolean);
        if (mutatedPaths.length) handlers.onWorkspaceMutate?.(mutatedPaths);
        const checkpointId =
          typeof evt.checkpointId === 'string' && evt.checkpointId.trim()
            ? evt.checkpointId.trim()
            : undefined;
        handlers.onDone?.({
          model: evt.model as string | undefined,
          mode: evt.mode as string | undefined,
          mutatedPaths: mutatedPaths.length ? mutatedPaths : undefined,
          checkpointId,
          planConstraintsLocked:
            typeof evt.planConstraintsLocked === 'boolean' ? evt.planConstraintsLocked : undefined,
          lastProcessedTokens:
            typeof evt.lastProcessedTokens === 'number' ? evt.lastProcessedTokens : undefined,
        });
      } else if (type === 'error') {
        handlers.onError?.(String(evt.message ?? '오류'));
      } else if (type === 'tool_approval' && typeof evt.id === 'string') {
        const summary = String(evt.summary ?? evt.tool ?? '도구 실행');
        const danger = Boolean(evt.danger);
        const access = ['operation', 'external_read', 'external_write', 'network'].includes(String(evt.access))
          ? String(evt.access) as ToolApprovalAccess
          : undefined;
        const targets = Array.isArray(evt.targets)
          ? evt.targets.map((target) => String(target ?? '').trim()).filter(Boolean)
          : undefined;
        const expires = evt.expires === 'run' || evt.expires === 'once' ? evt.expires : undefined;
        const approved = await askToolApprovalDecision(summary, danger, { access, targets, expires });
        await fetch('/chat/tool-approval', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: evt.id, approved }),
        }).catch(() => {});
        handlers.onStatus?.(approved ? '승인됨 · 계속…' : '거절됨');
      } else if (type === 'stopped') {
        handlers.onDone?.({ model: '중지됨' });
      }
    }
  }
}

/** Discard agent mutations by restoring auto-checkpoint taken before first mutate. */
export async function rollbackWorkspaceCheckpoint(opts: {
  checkpointId: string;
  sessionId?: string;
  confirm?: boolean;
  /** Partial reject — restore only these paths (or delete if not in snapshot). */
  paths?: string[];
}): Promise<{
  ok: boolean;
  restored?: number;
  deleted?: number;
  deleted_paths?: string[];
  partial?: boolean;
  error?: string;
  message?: string;
}> {
  const sessionId = opts.sessionId ?? (await ensureSession());
  const res = await fetch('/workspace/checkpoint/rollback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_HEADER]: sessionId,
    },
    body: JSON.stringify({
      checkpoint_id: opts.checkpointId,
      session_id: sessionId,
      confirm: opts.confirm !== false,
      ...(opts.paths?.length ? { paths: opts.paths } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    restored?: number;
    deleted?: number;
    deleted_paths?: string[];
    partial?: boolean;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      error: data.error || `HTTP_${res.status}`,
      message: data.message,
    };
  }
  return {
    ok: data.ok !== false,
    restored: data.restored,
    deleted: data.deleted,
    deleted_paths: data.deleted_paths,
    partial: data.partial,
    error: data.error,
    message: data.message,
  };
}

/** Checkpoint snapshot vs current disk (truncate preview for mutate review). */
export async function fetchCheckpointPreview(opts: {
  checkpointId: string;
  path: string;
  sessionId?: string;
}): Promise<{
  ok: boolean;
  path?: string;
  before?: string | null;
  after?: string | null;
  before_bytes?: number;
  after_bytes?: number;
  changed?: boolean;
  in_checkpoint?: boolean;
  is_new?: boolean;
  diff_lines?: string[];
  diff_added?: number;
  diff_removed?: number;
  diff_truncated?: boolean;
  error?: string;
}> {
  const sessionId = opts.sessionId ?? (await ensureSession());
  const q = new URLSearchParams({
    checkpoint_id: opts.checkpointId,
    path: opts.path,
    session_id: sessionId,
  });
  const res = await fetch(`/workspace/checkpoint/preview?${q}`, {
    headers: { [SESSION_HEADER]: sessionId },
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      error: String(data.message || data.error || `HTTP_${res.status}`),
    };
  }
  return data as {
    ok: boolean;
    path?: string;
    before?: string | null;
    after?: string | null;
    before_bytes?: number;
    after_bytes?: number;
    changed?: boolean;
    in_checkpoint?: boolean;
    is_new?: boolean;
    diff_lines?: string[];
    diff_added?: number;
    diff_removed?: number;
    diff_truncated?: boolean;
  };
}

export type ActiveTerminalJob = {
  id: string;
  command: string;
  started_at: number;
  age_ms: number;
  kind: 'agent' | 'ui' | 'other';
};

export async function listActiveRunTerminalJobs(): Promise<{
  ok: boolean;
  jobs: ActiveTerminalJob[];
}> {
  const res = await fetch('/fs/run-terminal/jobs', { cache: 'no-store' });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    jobs?: ActiveTerminalJob[];
  };
  if (!res.ok) return { ok: false, jobs: [] };
  return { ok: data.ok !== false, jobs: Array.isArray(data.jobs) ? data.jobs : [] };
}

/** Cancel long-running shell job (UI async terminal or agent_* session job). */
export async function cancelRunTerminalJob(opts: {
  jobId?: string;
  sessionId?: string;
}): Promise<{ ok: boolean; cancelled: boolean }> {
  const res = await fetch('/fs/run-terminal/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: opts.jobId,
      session_id: opts.sessionId,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; cancelled?: boolean };
  return { ok: res.ok && data.ok !== false, cancelled: Boolean(data.cancelled) };
}

/** User MCP servers (remote Streamable HTTP — data/config/user-mcp-servers.json). */
export interface UserMcpServerItem {
  id: string;
  url: string;
  authToken?: string;
  authConfigured?: boolean;
  enabled?: boolean;
}

export async function listUserMcpServers(): Promise<{
  ok: boolean;
  path?: string;
  servers: UserMcpServerItem[];
  note?: string;
}> {
  const res = await fetch('/mcp/servers', { cache: 'no-store' });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    path?: string;
    servers?: UserMcpServerItem[];
    note?: string;
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.message || data.error || `MCP 목록 실패 (${res.status})`);
  }
  return {
    ok: data.ok !== false,
    path: data.path,
    servers: Array.isArray(data.servers) ? data.servers : [],
    note: data.note,
  };
}

export async function saveUserMcpServers(
  servers: UserMcpServerItem[],
): Promise<{ ok: boolean; after?: number }> {
  const res = await fetch('/mcp/servers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servers }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    after?: number;
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.message || data.error || `MCP 저장 실패 (${res.status})`);
  }
  return { ok: data.ok !== false, after: data.after };
}

export async function testUserMcpServer(
  id: string,
): Promise<{ ok: boolean; tool_count?: number; tools?: string[]; error?: string }> {
  const res = await fetch('/mcp/servers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    tool_count?: number;
    tools?: string[];
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      error: data.error || data.message || `HTTP_${res.status}`,
    };
  }
  return {
    ok: data.ok !== false,
    tool_count: data.tool_count,
    tools: data.tools,
    error: data.error,
  };
}

export async function importSkillPackage(zipPath: string): Promise<SkillListItem> {
  const res = await fetch('/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zip_path: zipPath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `스킬 설치 실패 (${res.status})`);
  return data as SkillListItem;
}

/** Brand work kits (locker/bundled) + local overlay presets — not org module zip. */
export interface AgentProfile {
  id: string;
  label: string;
  description?: string;
  version: 2;
  ui: { default_skill_mode?: string; pinned_skill_ids: string[] };
  plugins: { enable: Record<string, boolean> };
  tools?: { preferred_plugin_ids: string[] };
  created_at: string;
  updated_at: string;
}

export type ShelfInstallStatus =
  | 'available'
  | 'installed'
  | 'update_available'
  | 'missing_asset';

export interface WorkKitShelf {
  schema_version: 1;
  id: string;
  group: string;
  label: string;
  description?: string;
  pull: Array<'agent-plugins' | 'skills'>;
  plugins: { enable: Record<string, boolean> };
  ui: { default_skill_mode?: string; pinned_skill_ids: string[] };
  hints?: { needs_organization_module?: boolean };
  origin: 'locker' | 'bundled' | 'catalog';
  install_status?: ShelfInstallStatus;
  feed_asset_sequence?: number;
}

export interface WorkKitCatalogGroup {
  id: string;
  label: string;
  order: number;
  shelves: WorkKitShelf[];
}

export interface AgentProfileApplied {
  profile_id: string;
  group?: string;
  kit_id?: string;
  origin?: 'locker' | 'bundled' | 'overlay';
  ui: AgentProfile['ui'];
  applied_at: string;
}

export interface ProfileApplyResult {
  ok: boolean;
  profile_id: string;
  group?: string;
  kit_id?: string;
  toggled: Array<{ id: string; enabled: boolean }>;
  pulled_plugins?: string[];
  pulled_skills?: string[];
  warnings: string[];
}

export interface AppliedWorkKitSummary {
  label: string | null;
  group: string | null;
  kit_id: string | null;
  install_status: ShelfInstallStatus | null;
}

export interface WorkKitCatalogCheckResult {
  feed_url: string | null;
  feed_sequence: number | null;
  cached_sequence: number | null;
  update_available: boolean;
  feed_host?: string | null;
  asset_url_mode?: 'kit_template' | 'update_template' | 'github_default';
}

export interface WorkKitCatalogConfig {
  feed_url: string | null;
  feed_configured: boolean;
  feed_host: string | null;
  asset_url_mode: 'kit_template' | 'update_template' | 'github_default';
  migration_hint: string;
}

export async function fetchProfiles(): Promise<{
  locker_root: string;
  feed_sequence: number | null;
  groups: WorkKitCatalogGroup[];
  overlays: AgentProfile[];
  /** @deprecated use overlays */
  profiles: AgentProfile[];
  applied: AgentProfileApplied | null;
  applied_work_kit?: AppliedWorkKitSummary | null;
  can_restore: boolean;
}> {
  const res = await fetch('/profiles');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로필 조회 실패 (${res.status})`);
  const overlays = Array.isArray(data.overlays)
    ? data.overlays
    : Array.isArray(data.profiles)
      ? data.profiles
      : [];
  return {
    locker_root: typeof data.locker_root === 'string' ? data.locker_root : '',
    feed_sequence: typeof data.feed_sequence === 'number' ? data.feed_sequence : null,
    groups: Array.isArray(data.groups) ? data.groups : [],
    overlays,
    profiles: overlays,
    applied: data.applied ?? null,
    applied_work_kit: data.applied_work_kit ?? null,
    can_restore: data.can_restore === true,
  };
}

export async function checkWorkKitCatalog(): Promise<WorkKitCatalogCheckResult> {
  const res = await fetch('/profiles/catalog/check');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `카탈로그 확인 실패 (${res.status})`);
  return data as WorkKitCatalogCheckResult;
}

export async function fetchWorkKitCatalogConfig(): Promise<WorkKitCatalogConfig> {
  const res = await fetch('/profiles/catalog/config');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `카탈로그 설정 조회 실패 (${res.status})`);
  return data as WorkKitCatalogConfig;
}

export async function refreshWorkKitCatalog(feedPath?: string): Promise<{ ok: boolean; sequence: number }> {
  const res = await fetch('/profiles/catalog/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedPath ? { feed_path: feedPath } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `카탈로그 동기화 실패 (${res.status})`);
  return { ok: data.ok === true, sequence: Number(data.sequence) || 0 };
}

export async function installWorkKitShelf(group: string, id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/profiles/shelves/${encodeURIComponent(group)}/${encodeURIComponent(id)}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `키트 받기 실패 (${res.status})`);
  return { ok: data.ok === true };
}

export async function uninstallWorkKitShelf(group: string, id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/profiles/shelves/${encodeURIComponent(group)}/${encodeURIComponent(id)}/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `키트 제거 실패 (${res.status})`);
  return { ok: data.ok === true };
}

export async function saveProfile(
  profile: Partial<AgentProfile> & { id: string },
): Promise<AgentProfile> {
  const res = await fetch('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로필 저장 실패 (${res.status})`);
  return data as AgentProfile;
}

export async function applyWorkKitProfile(group: string, id: string): Promise<ProfileApplyResult> {
  const res = await fetch('/profiles/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group, id, confirm: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로필 적용 실패 (${res.status})`);
  return data as ProfileApplyResult;
}

export async function applyProfile(id: string): Promise<ProfileApplyResult> {
  const res = await fetch(`/profiles/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로필 적용 실패 (${res.status})`);
  return data as ProfileApplyResult;
}

export async function restoreProfileLastState(): Promise<ProfileApplyResult> {
  const res = await fetch('/profiles/restore-last', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `되돌리기 실패 (${res.status})`);
  return data as ProfileApplyResult;
}

export async function deleteProfile(id: string): Promise<void> {
  const res = await fetch(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `프로필 삭제 실패 (${res.status})`);
}

