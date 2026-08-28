import { create } from 'zustand';
import { BROWSER_HISTORY_MAX, validHttpUrl } from '../lib/browserUrl';
import { choiceDialog, confirmDialog } from '../lib/confirmDialog';
import type {
  AiWorkMode,
  ChatTurn,
  FileNode,
  PendingAttachment,
  WorkspaceAsset,
  WorkspaceMode,
} from '../types';
import { isCanvasAsset } from '../types';
import type { Edge, Node } from '@xyflow/react';
import {
  clearStoredSessionId,
  createSession,
  deleteAttachment,
  fetchModelPicker,
  fetchSession,
  fetchWorkspaceFsTree,
  listSkills,
  readWorkspaceFsFile,
  renameWorkspaceFsFile,
  runWorkspaceTerminal,
  setStoredSessionId,
  streamChat,
  setSessionExecutionPolicy,
  setSessionProject as saveSessionProject,
  setSessionWorkspaceProject as saveSessionWorkspaceProject,
  undoSessionTurn,
  uploadAttachments,
  writeWorkspaceFsFile,
  cancelRunTerminalJob,
  type PickerModel,
  type SessionMessage,
  type ExecutionPolicy,
  type EffectiveExecutionPolicy,
  type WorkspaceFsTreeNode,
} from '../api/myAgentClient';

const ASSET_MIME = 'application/x-my-agent-asset';
const MODEL_PREF_KEY = 'my-agent-workspace-model';
const TERMINAL_OPEN_KEY = 'my-agent-workspace-terminal-open';
const PREVIEW_LAYOUT_KEY = 'my-agent-workspace-preview-layout';
const LEGACY_MODEL_PREF_KEY = 'cqr-workspace-model';
const LEGACY_TERMINAL_OPEN_KEY = 'cqr-workspace-terminal-open';
const LEGACY_PREVIEW_LAYOUT_KEY = 'cqr-workspace-preview-layout';
const FALLBACK_MODEL_OPTIONS: PickerModel[] = [{ id: 'auto', label: '기본 (자동)' }];
let executionPolicySessionPromise: Promise<string> | null = null;
const executionPolicySaveRevisions = new Map<string, number>();
const executionPolicySaveQueues = new Map<string, Promise<unknown>>();

export type PreviewDisplayState = 'docked' | 'pip' | 'closed';

export interface PreviewLayout {
  displayState: PreviewDisplayState;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

const DEFAULT_PREVIEW_LAYOUT: PreviewLayout = {
  displayState: 'docked',
  position: { x: 24, y: 24 },
  size: { width: 520, height: 360 },
};

function readStoredPreference(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) localStorage.setItem(key, legacy);
  return legacy;
}

export function readPreviewLayout(): PreviewLayout {
  try {
    const raw = readStoredPreference(PREVIEW_LAYOUT_KEY, LEGACY_PREVIEW_LAYOUT_KEY);
    if (!raw) return DEFAULT_PREVIEW_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PreviewLayout>;
    const x = parsed.position?.x;
    const y = parsed.position?.y;
    const width = parsed.size?.width;
    const height = parsed.size?.height;
    return {
      displayState: parsed.displayState === 'pip' || parsed.displayState === 'closed' ? parsed.displayState : 'docked',
      position: {
        x: typeof x === 'number' && Number.isFinite(x) ? x : DEFAULT_PREVIEW_LAYOUT.position.x,
        y: typeof y === 'number' && Number.isFinite(y) ? y : DEFAULT_PREVIEW_LAYOUT.position.y,
      },
      size: {
        width: typeof width === 'number' && Number.isFinite(width) ? width : DEFAULT_PREVIEW_LAYOUT.size.width,
        height: typeof height === 'number' && Number.isFinite(height) ? height : DEFAULT_PREVIEW_LAYOUT.size.height,
      },
    };
  } catch {
    return DEFAULT_PREVIEW_LAYOUT;
  }
}

export function writePreviewLayout(layout: PreviewLayout): void {
  try {
    localStorage.setItem(PREVIEW_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // localStorage may be unavailable in private or embedded browser contexts.
  }
}

function readTerminalOpenPref(): boolean {
  try {
    return readStoredPreference(TERMINAL_OPEN_KEY, LEGACY_TERMINAL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export type SessionRunPhase = 'running';

export interface EditorTab {
  id: string;
  title: string;
  language: string;
  content: string;
  dirty?: boolean;
}

function inferEditorLanguage(title: string): string {
  const lower = title.toLowerCase();
  if (/\.(ts|tsx)$/.test(lower)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return 'javascript';
  if (/\.css$/.test(lower)) return 'css';
  if (/\.(html|htm)$/.test(lower)) return 'html';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.py$/.test(lower)) return 'python';
  return 'plaintext';
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop()?.trim() || path.trim();
}

function isGenericCodeTitle(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return /^(?:generated )?code(?: \d+)?$/.test(normalized);
}

function codeAssetTitle(label: string, fallbackPath: string): string {
  const pathName = fileNameFromPath(fallbackPath);
  if (pathName && !/^buffer\.(tsx|ts|jsx|js)$/i.test(pathName)) return pathName;
  const labelName = fileNameFromPath(label);
  if (labelName && !isGenericCodeTitle(labelName)) return labelName;
  return 'code.ts';
}

function codeAssetKey(label: string, title: string, fallbackPath: string): string {
  const pathName = fileNameFromPath(fallbackPath);
  if (pathName && !/^buffer\.(tsx|ts|jsx|js)$/i.test(pathName)) return `file:${pathName.toLowerCase()}`;
  const labelName = fileNameFromPath(label);
  return isGenericCodeTitle(labelName)
    ? 'generated-code'
    : `label:${(labelName || title).toLowerCase()}`;
}

function fileIdFromTabId(tabId: string | null): string | null {
  return tabId?.startsWith('file:') ? tabId.slice('file:'.length) : null;
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function assetToCanvasNode(asset: WorkspaceAsset, position: { x: number; y: number }): Node {
  const width = 280;
  const height = asset.kind === 'image' ? 320 : 280;
  return {
    id: `n-${asset.id}-${uid('x')}`,
    type: 'assetCard',
    position,
    style: { width, height },
    data: {
      assetId: asset.id,
      label: asset.title,
      kind: asset.kind,
      prompt: asset.prompt ?? '',
      imageUrl: asset.imageUrl,
      content: asset.content,
      cardWidth: width,
      cardHeight: height,
    },
  };
}

function sessionMessagesToChat(messages: SessionMessage[]): ChatTurn[] {
  return messages.map((m, i) => {
    const urls = Array.isArray(m.image_urls)
      ? m.image_urls.filter((u): u is string => typeof u === 'string' && !!u)
      : [];
    const text = String(m.content ?? '');
    const isPlaceholder =
      urls.length > 0
      && (/이미지를?\s*\d*\s*장?\s*생성했습니다/.test(text) || text.trim() === '');
    return {
      id: `restored-${i}-${m.at}`,
      role: m.role,
      mode: (m.mode === 'image_gen' ? 'image' : m.mode === 'web_dev' ? 'code' : 'text') as AiWorkMode,
      text: isPlaceholder ? '' : text,
      model: m.role === 'assistant' ? m.model : undefined,
      imageUrls: urls.length ? urls : undefined,
      startedAt: m.role === 'assistant' ? messages[i - 1]?.at : undefined,
      completedAt: m.role === 'assistant' ? m.at : undefined,
    };
  });
}

function assetsFromMessages(messages: SessionMessage[]): WorkspaceAsset[] {
  const out: WorkspaceAsset[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const urls = Array.isArray(m.image_urls) ? m.image_urls : [];
    for (const url of urls) {
      if (typeof url !== 'string' || !url) continue;
      out.push({
        id: uid('img'),
        kind: 'image',
        title: '세션 이미지',
        prompt: m.content?.slice(0, 80),
        createdAt: m.at || new Date().toISOString(),
        imageUrl: url,
      });
    }
  }
  return out;
}

function mapFsTree(nodes: WorkspaceFsTreeNode[]): FileNode[] {
  return nodes.map((n) => {
    if (n.is_dir) {
      return {
        id: n.path,
        name: n.name,
        kind: 'folder' as const,
        children: mapFsTree(n.children ?? []),
      };
    }
    const lower = n.name.toLowerCase();
    const language = lower.endsWith('.md')
      ? 'markdown'
      : lower.endsWith('.ts') || lower.endsWith('.tsx')
        ? 'typescript'
        : lower.endsWith('.js') || lower.endsWith('.jsx')
          ? 'javascript'
          : undefined;
    return { id: n.path, name: n.name, kind: 'file' as const, language };
  });
}

interface SessionViewSnapshot {
  activeProjectId: string | null;
  activeWorkspaceProjectId: string | null;
  chat: ChatTurn[];
  activeExecutionPolicy: ExecutionPolicy;
  effectiveExecutionPolicy: EffectiveExecutionPolicy | null;
  canUndo: boolean;
  assets: WorkspaceAsset[];
  canvasNodes: Node[];
  canvasEdges: Edge[];
}

interface LiveJob {
  sessionId: string;
  abort: AbortController;
  userTurn: ChatTurn;
  assistantId: string;
  chat: ChatTurn[];
  statusText: string;
  displayText: string;
  skillMode: string | null;
  model: string;
  executionPolicy: ExecutionPolicy;
  effectiveExecutionPolicy: EffectiveExecutionPolicy | null;
  attachmentIds: string[];
  editorPath: string;
  editorSelection: string;
  /** @ context paths for this turn. */
  contextPaths: string[];
  terminalUsed: boolean;
}

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  attachmentIds: string[];
  attachmentNames: string[];
  contextPaths: string[];
  createdAt: string;
}

interface WorkspaceState {
  mode: WorkspaceMode;
  /** URL shown in the Preview browser address field. */
  browserInputUrl: string;
  /** Last validated HTTP(S) URL loaded into the Preview browser. */
  browserLoadedUrl: string;
  browserHistory: string[];
  browserHistoryIndex: number;
  browserReloadKey: number;
  files: FileNode[];
  filesRoot: string | null;
  filesMessage: string | null;
  assets: WorkspaceAsset[];
  chat: ChatTurn[];
  openTabs: EditorTab[];
  activeTabId: string | null;
  activeFileId: string | null;
  editorContent: string;
  editorSaveStatus: string | null;
  editorSaving: boolean;
  canvasNodes: Node[];
  canvasEdges: Edge[];
  /** Viewed session is currently running. */
  busy: boolean;
  statusText: string;
  /** Sticky single Exit Gate (last OPEN from status); cleared on release/session clear. */
  openGateText: string;
  /** Last SSE context_budget snapshot for ChatPane usage line. */
  contextBudget: {
    usedChars: number;
    budgetChars: number;
    compressed: boolean;
    fallback128k: boolean;
  } | null;
  selectedModel: string;
  activeExecutionPolicy: ExecutionPolicy;
  effectiveExecutionPolicy: EffectiveExecutionPolicy | null;
  modelOptions: PickerModel[];
  apiOnline: boolean | null;
  apiError: string | null;
  previewPaneOpen: boolean;
  /** Collapsible terminal under Preview code pane. */
  terminalOpen: boolean;
  terminalBusy: boolean;
  terminalLog: string;
  /** Active UI async terminal job id (cancel via /fs/run-terminal/cancel). */
  terminalJobId: string | null;
  /** Attention pulse only after an actual terminal command finishes. */
  terminalAttention: boolean;
  imagePreview: { src: string; title: string; prompt: string } | null;
  activeSessionId: string | null;
  activeProjectId: string | null;
  /** Explicit per-chat binding to a registered workspace_root. */
  activeWorkspaceProjectId: string | null;
  skillMode: string | null;
  skillLabel: string | null;
  licenseMode: string | null;
  licenseEnforced: boolean;
  pendingAttachments: PendingAttachment[];
  /** Composer @ chips — workspace relative paths. */
  pendingContextPaths: string[];
  streamAbort: AbortController | null;
  canUndo: boolean;
  /** Per-session run phase for sidebar badges (FIFO global queue). */
  sessionPhases: Record<string, SessionRunPhase>;
  /** User messages waiting for the current turn to finish, in session FIFO order. */
  messageQueue: QueuedMessage[];
  removeQueuedMessage: (id: string) => void;
  setMode: (mode: WorkspaceMode) => void;
  setBrowserInputUrl: (url: string) => void;
  navigateBrowser: (url: string) => void;
  reloadBrowser: () => void;
  goBrowserBack: () => void;
  goBrowserForward: () => void;
  setSelectedModel: (model: string) => void;
  setExecutionPolicy: (policy: Partial<ExecutionPolicy>) => Promise<void>;
  setSessionWorkspaceProject: (workspaceProjectId: string | null) => Promise<void>;
  setSessionProject: (projectId: string | null) => Promise<void>;
  setModelOptions: (models: PickerModel[]) => void;
  /** Reload /models/picker into the chat header dropdown. Returns option count. */
  refreshModelPicker: (refreshRemote?: boolean) => Promise<number>;
  setApiStatus: (online: boolean, error?: string | null) => void;
  setLicenseMode: (mode: string | null) => void;
  setLicenseEnforced: (enforced: boolean) => void;
  setPreviewPaneOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  clearTerminalAttention: () => void;
  clearTerminalLog: () => void;
  runTerminalCommand: (command: string) => Promise<void>;
  cancelTerminalCommand: () => Promise<void>;
  openImagePreview: (payload: { src: string; title: string; prompt: string }) => void;
  closeImagePreview: () => void;
  openFile: (id: string) => Promise<void>;
  openFileOnCanvas: (id: string) => Promise<void>;
  /**
   * After code-agent mutate: open each workspace path in Preview「코드」
   * (create tab or focus + re-read disk). Dirty tabs: confirm once before overwrite.
   */
  openMutatedWorkspaceFiles: (paths: string[]) => Promise<void>;
  refreshExplorer: () => Promise<void>;
  setEditorContent: (value: string) => void;
  saveActiveFile: () => Promise<void>;
  renameWorkspaceFile: (path: string, name: string) => Promise<void>;
  openEditorTab: (tab: EditorTab) => void;
  setActiveTab: (tabId: string) => void;
  closeEditorTab: (tabId: string) => Promise<void>;
  setCanvasNodes: (nodes: Node[]) => void;
  setCanvasEdges: (edges: Edge[]) => void;
  updateCanvasNodeSize: (nodeId: string, width: number, height: number) => void;
  updateAssetPrompt: (assetId: string, prompt: string) => void;
  regenerateAsset: (assetId: string) => void;
  downloadAsset: (assetId: string) => void;
  removeCanvasNode: (nodeId: string) => void;
  placeAssetOnCanvas: (assetId: string, position?: { x: number; y: number }) => void;
  openAssetInEditor: (assetId: string) => void;
  setSkillMode: (mode: string | null, label?: string | null) => void;
  hydrateOrganizationSkillDefault: () => Promise<void>;
  addPendingAttachments: (items: PendingAttachment[]) => void;
  removePendingAttachment: (id: string) => Promise<void>;
  clearPendingAttachments: () => void;
  addContextPath: (path: string) => void;
  removeContextPath: (path: string) => void;
  clearContextPaths: () => void;
  /** Upload any file type into pending attachments (images get preview chips). */
  uploadFiles: (files: File[]) => Promise<void>;
  /** @deprecated Prefer uploadFiles — kept for clipboard paste call sites. */
  uploadClipboardImages: (files: File[]) => Promise<void>;
  startNewChat: (projectId?: string | null) => Promise<void>;
  /** Clear current chat without creating a replacement session (allows zero chats). */
  clearActiveChat: () => void;
  loadChatSession: (sessionId: string) => Promise<void>;
  sendAiMessage: (text: string) => Promise<void>;
  stopAiMessage: () => void;
  undoLastTurn: () => Promise<string | null>;
}

/** In-flight jobs keyed by session. Different sessions may run concurrently. */
const liveJobs = new Map<string, LiveJob>();
const MESSAGE_QUEUE_KEY = 'my-agent-message-queue-v1';
const WORK_OBJECTS_KEY = 'my-agent-work-objects-v1';

function loadSessionAssets(sessionId: string): WorkspaceAsset[] {
  try {
    const all = JSON.parse(localStorage.getItem(WORK_OBJECTS_KEY) ?? '{}') as Record<string, WorkspaceAsset[]>;
    return Array.isArray(all[sessionId]) ? all[sessionId] : [];
  } catch {
    return [];
  }
}

function saveSessionAssets(sessionId: string, assets: WorkspaceAsset[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(WORK_OBJECTS_KEY) ?? '{}') as Record<string, WorkspaceAsset[]>;
    all[sessionId] = assets.filter((asset) => Boolean(asset.sourcePath));
    localStorage.setItem(WORK_OBJECTS_KEY, JSON.stringify(all));
  } catch {
    // Storage failure must not interrupt an active model run.
  }
}

function loadMessageQueue(): QueuedMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(MESSAGE_QUEUE_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveMessageQueue(queue: QueuedMessage[]): void {
  localStorage.setItem(MESSAGE_QUEUE_KEY, JSON.stringify(queue));
}

/** In-memory view snapshots make revisiting a loaded conversation synchronous. */
const sessionViewCache = new Map<string, SessionViewSnapshot>();

function isAbortError(err: unknown) {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || /aborted|BodyStreamBuffer/i.test(String(e.message ?? ''));
}

const MAX_VISIBLE_PROGRESS_STEPS = 6;

const MAR_ROLE_LABELS: Record<string, string> = {
  planner: '작업 계획 수립',
  coder: '코드 작업 시작',
  reviewer: '변경 내용 검토',
  critic: '완료 조건 검토',
  browser: '브라우저 확인',
  researcher: '자료 조사',
};

function formatProgressStep(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('MAR ·')) return trimmed;
  if (/\sskip\s/i.test(trimmed)) return null;

  if (/^MAR · plan\b/i.test(trimmed)) {
    return /model_directed_single_agent/i.test(trimmed)
      ? '작업 방식 결정 · 단일 작업으로 진행'
      : '작업 순서 구성';
  }

  const roleStart = trimmed.match(/^MAR · (planner|coder|reviewer|critic|browser|researcher)(?:\s|$)/i);
  if (roleStart) return MAR_ROLE_LABELS[roleStart[1].toLowerCase()] ?? '작업 시작';

  const handoff = trimmed.match(/^MAR · handoff\s+\w+\s*→\s*(\w+)/i);
  if (handoff) return MAR_ROLE_LABELS[handoff[1].toLowerCase()] ?? '다음 작업 단계로 전환';

  if (/specialist/i.test(trimmed)) {
    if (/browser/i.test(trimmed)) return MAR_ROLE_LABELS.browser;
    if (/researcher/i.test(trimmed)) return MAR_ROLE_LABELS.researcher;
  }

  return '작업 단계 전환';
}

function progressStepKey(text: string): string {
  const call = text.match(/(\d+)번째 호출/);
  if (call) return `call:${call[1]}`;
  return text.replace(/\s*·\s*\d+분\s*\d+초\s*$/, '').trim();
}

function appendProgressStep(steps: string[] | undefined, text: string): string[] {
  const nextText = formatProgressStep(text);
  if (!nextText) return steps ?? [];
  const current = steps ?? [];
  const last = current.at(-1);
  if (last === nextText) return current;
  if (last && progressStepKey(last) === progressStepKey(nextText)) {
    return [...current.slice(0, -1), nextText];
  }
  return [...current, nextText].slice(-MAX_VISIBLE_PROGRESS_STEPS);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const cacheActiveSessionView = () => {
    const state = get();
    const sid = state.activeSessionId;
    if (!sid) return;
    sessionViewCache.set(sid, {
      activeProjectId: state.activeProjectId,
      activeWorkspaceProjectId: state.activeWorkspaceProjectId,
      chat: liveJobs.get(sid)?.chat ?? state.chat,
      activeExecutionPolicy: liveJobs.get(sid)?.executionPolicy ?? state.activeExecutionPolicy,
      effectiveExecutionPolicy: liveJobs.get(sid)?.effectiveExecutionPolicy ?? state.effectiveExecutionPolicy,
      canUndo: state.canUndo,
      assets: state.assets,
      canvasNodes: state.canvasNodes,
      canvasEdges: state.canvasEdges,
    });
  };

  const syncViewBusy = () => {
    const sid = get().activeSessionId;
    const phase = sid ? get().sessionPhases[sid] : undefined;
    const live = sid ? liveJobs.get(sid) : undefined;
    set({
      busy: phase === 'running',
      statusText: live?.statusText ?? '',
      streamAbort: live?.abort ?? null,
    });
  };

  const patchLiveChat = (sid: string, chat: ChatTurn[], statusText?: string) => {
    const job = liveJobs.get(sid);
    if (!job) return;
    job.chat = chat;
    if (statusText !== undefined) job.statusText = statusText;
    const cached = sessionViewCache.get(sid);
    if (cached) sessionViewCache.set(sid, { ...cached, chat });
    if (get().activeSessionId === sid) {
      set({
        chat,
        statusText: job.statusText,
        busy: true,
      });
    }
  };

  const finishJob = (sid: string) => {
    const finishedJob = liveJobs.get(sid);
    if (finishedJob) {
      const completedAt = new Date().toISOString();
      const completedChat = finishedJob.chat.map((turn) =>
        turn.id === finishedJob.assistantId ? { ...turn, completedAt } : turn,
      );
      patchLiveChat(sid, completedChat);
    }
    liveJobs.delete(sid);
    const phases = { ...get().sessionPhases };
    delete phases[sid];
    set({ sessionPhases: phases });
    if (get().activeSessionId === sid) {
      set({
        busy: false,
        statusText: '',
        streamAbort: null,
        canUndo: true,
        ...(finishedJob?.terminalUsed ? { terminalAttention: true } : {}),
      });
      const next = get().messageQueue.find((item) => item.sessionId === sid);
      if (next) {
        const remaining = get().messageQueue.filter((item) => item.id !== next.id);
        saveMessageQueue(remaining);
        set({ messageQueue: remaining });
        queueMicrotask(() => {
          if (get().activeSessionId !== sid || liveJobs.has(sid)) return;
          set({
            pendingAttachments: next.attachmentIds.map((id, index) => ({
              id,
              name: next.attachmentNames[index] ?? '첨부 파일',
            })),
            pendingContextPaths: next.contextPaths,
          });
          void get().sendAiMessage(next.text);
        });
      }
    } else if (finishedJob?.terminalUsed) {
      set({ terminalAttention: true });
    }
  };

  const runJob = async (sid: string) => {
    const job = liveJobs.get(sid);
    if (!job) return;
    set({
      sessionPhases: { ...get().sessionPhases, [sid]: 'running' },
    });
    if (get().activeSessionId === sid) {
      set({ busy: true, statusText: '연결 중…', streamAbort: job.abort, canUndo: false });
    }

    const patchAssistant = (partial: Partial<ChatTurn>) => {
      const next = job.chat.map((t) => (t.id === job.assistantId ? { ...t, ...partial } : t));
      patchLiveChat(sid, next);
    };

    try {
      let content = '';
      const editorPath = job.editorPath?.trim() || '';
      const hasRealEditorFile =
        !!editorPath && !/^buffer\.(tsx|ts|jsx|js)$/i.test(editorPath);
      const contextPaths = (job.contextPaths ?? [])
        .map((p) => String(p || '').replace(/\\/g, '/').trim())
        .filter((p) => p && !/^buffer\.(tsx|ts|jsx|js)$/i.test(p));
      const editor_context =
        hasRealEditorFile || contextPaths.length
          ? {
              path: hasRealEditorFile ? editorPath : contextPaths[0] || '',
              selection: hasRealEditorFile ? job.editorSelection || undefined : undefined,
              paths: contextPaths.length ? contextPaths : undefined,
            }
          : undefined;

      const primaryMode = job.skillMode || 'chat';
      const finalOnly = primaryMode === 'web_dev';
      /** Cap raw model stream so previews cannot bloat the chat state. */
      const STREAM_PREVIEW_MAX = 12_000;
      let streamPreview = '';
      const codeAssetIds = new Map<string, string>();
      // The API may emit a workspace_mutate event and repeat the same paths in done.
      // Collect them for this run, then read the final on-disk version once on completion.
      const mutatedWorkspacePaths = new Set<string>();
      if (finalOnly && !content.trim()) {
        patchAssistant({ text: '작업 중…', streamPreview: undefined });
      }

      const clearPreview = () => {
        streamPreview = '';
      };

      const finishAssistantText = (text: string) => {
        clearPreview();
        patchAssistant({ text, streamPreview: undefined });
      };

      const runStream = (chatMode: string) =>
        streamChat(
          {
            message: job.displayText,
            mode: chatMode === 'chat' ? undefined : chatMode,
            model: job.model,
            execution_policy: job.executionPolicy,
            attachments: job.attachmentIds,
            editor_context,
            sessionId: sid,
          },
          {
            signal: job.abort.signal,
            onStatus: (t) => {
              const text = String(t || '');
              if (/Exit Gate OPEN/i.test(text)) {
                const m = text.match(/Exit Gate OPEN\s*[·:-]\s*(.+)/i);
                const gate = (m?.[1] || text).trim().slice(0, 120);
                set({ openGateText: gate });
              } else if (/Exit Gate.*해제|Critic PASS.*openGate/i.test(text)) {
                set({ openGateText: '' });
              }
              const displayStatus = formatProgressStep(t);
              if (!displayStatus) return;
              const activeTurn = job.chat.find((turn) => turn.id === job.assistantId);
              const nextChat = job.chat.map((turn) =>
                turn.id === job.assistantId
                  ? { ...turn, progressSteps: appendProgressStep(activeTurn?.progressSteps, displayStatus) }
                  : turn,
              );
              patchLiveChat(sid, nextChat, displayStatus);
            },
            onContextBudget: (snap) => {
              const used = Math.max(0, Math.floor(Number(snap.usedChars) || 0));
              const budget = Math.max(0, Math.floor(Number(snap.budgetChars) || 0));
              set({
                contextBudget: {
                  usedChars: used,
                  budgetChars: budget,
                  compressed: Boolean(snap.compressed),
                  fallback128k: Boolean(snap.fallback128k),
                },
              });
            },
            onThought: (t) => patchAssistant({ thought: t }),
            onExecutionPolicy: (policy) => {
              job.executionPolicy = policy.requested;
              job.effectiveExecutionPolicy = policy.effective;
              if (get().activeSessionId === sid) {
                set({
                  activeExecutionPolicy: policy.requested,
                  effectiveExecutionPolicy: policy.effective,
                });
              }
            },
            onToken: (t) => {
              // Code/tool-plane: main bubble stays “작업 중…” until content_replace.
              // Intermediate model tokens go to streamPreview only (P1.1 UI split).
              if (finalOnly) {
                streamPreview = (streamPreview + t).slice(-STREAM_PREVIEW_MAX);
                patchAssistant({
                  text: content.trim() ? content : '작업 중…',
                  streamPreview,
                });
                return;
              }
              content += t;
              patchAssistant({ text: content });
            },
            onContentReplace: (t) => {
              content = t;
              clearPreview();
              // Final (or mid-run replace) answer owns the main bubble — not stream preview.
              patchAssistant({ text: content, streamPreview: undefined });
            },
            onCode: (label, code) => {
              // Tool-plane code events are model response fragments, not completed work objects.
              // Only successful workspace mutation events belong in the work-object list.
              if (finalOnly) return;
              const title = codeAssetTitle(label, editorPath);
              // A code stream may emit the same artifact repeatedly while it is being assembled.
              // Keep a stable key so chunks update the existing tab instead of opening duplicates.
              const assetKey = codeAssetKey(label, title, editorPath);
              const existingId = codeAssetIds.get(assetKey);
              if (existingId) {
                const assets = get().assets.map((item) =>
                  item.id === existingId ? { ...item, title, content: code } : item,
                );
                const openTabs = get().openTabs.map((tab) =>
                  tab.id === `asset:${existingId}` ? { ...tab, title, content: code } : tab,
                );
                set({
                  assets,
                  openTabs,
                  editorContent:
                    get().activeTabId === `asset:${existingId}` ? code : get().editorContent,
                });
                patchAssistant({ assetId: existingId });
                return;
              }
              const asset: WorkspaceAsset = {
                id: uid('code'),
                kind: 'code',
                title,
                prompt: job.displayText,
                createdAt: new Date().toISOString(),
                content: code,
                language: 'typescript',
              };
              codeAssetIds.set(assetKey, asset.id);
              set({
                assets: [asset, ...get().assets],
              });
              patchAssistant({ assetId: asset.id });
            },
            onWorkspaceMutate: (paths) => {
              for (const path of paths) {
                const rel = String(path ?? '').replace(/\\/g, '/').trim();
                if (rel) mutatedWorkspacePaths.add(rel);
              }
            },
            onToolComplete: (event) => {
              if (event.tool === 'run_terminal') job.terminalUsed = true;
            },
            onImage: (url) => {
              const asset: WorkspaceAsset = {
                id: uid('img'),
                kind: 'image',
                title: 'From chat',
                prompt: job.displayText,
                createdAt: new Date().toISOString(),
                imageUrl: url,
              };
              const prev =
                job.chat.find((t) => t.id === job.assistantId)?.imageUrls ?? [];
              patchAssistant({
                assetId: asset.id,
                imageUrls: [...prev, url],
              });
              set({
                assets: [asset, ...get().assets],
                canvasNodes: [
                  ...get().canvasNodes,
                  assetToCanvasNode(asset, { x: 180, y: 160 }),
                ],
              });
            },
            onError: (message) => {
              if (finalOnly) {
                content = message;
                finishAssistantText(content);
                return;
              }
              content += `\n[오류] ${message}`;
              patchAssistant({ text: content });
            },
            onDone: (info) => {
        if (info.model && info.model !== '중지됨') patchAssistant({ model: info.model });
              const resolvedMode: AiWorkMode = info.mode === 'web_dev'
                ? 'code'
                : info.mode === 'image_gen'
                  ? 'image'
                  : 'text';
              patchAssistant({ mode: resolvedMode });
              for (const path of info.mutatedPaths ?? []) {
                const rel = String(path ?? '').replace(/\\/g, '/').trim();
                if (rel) mutatedWorkspacePaths.add(rel);
              }
              if (info.model === '중지됨' && (!content.trim() || content === '작업 중…')) {
                content = '(중지됨)';
                finishAssistantText(content);
              } else if (finalOnly) {
                // Drop live preview once the run ends so only the final bubble remains.
                clearPreview();
                patchAssistant({
                  text: content.trim() ? content : '작업 중…',
                  streamPreview: undefined,
                });
              }
            },
          },
        );

      try {
        await runStream(primaryMode);
      } catch (err) {
        if (isAbortError(err) || job.abort.signal.aborted) {
          if (!content.trim() || content === '작업 중…') finishAssistantText('(중지됨)');
          else finishAssistantText(content);
          finishJob(sid);
          return;
        }
        // ADR-008: never demote tool-plane (code) → tool-less chat — that invents "no tools".
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(msg);
      }

      if (job.abort.signal.aborted) {
        if (!content.trim() || content === '작업 중…') finishAssistantText('(중지됨)');
        else finishAssistantText(content);
        finishJob(sid);
        return;
      }

      if (get().activeSessionId === sid && mutatedWorkspacePaths.size) {
        await get().refreshExplorer();
        const now = new Date().toISOString();
        let nextAssets = [...get().assets];
        for (const sourcePath of mutatedWorkspacePaths) {
          const canonicalPath = sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
          const existingIndex = nextAssets.findIndex(
            (asset) => asset.sourcePath?.toLocaleLowerCase() === canonicalPath.toLocaleLowerCase(),
          );
          if (existingIndex >= 0) {
            const existing = nextAssets[existingIndex];
            nextAssets.splice(existingIndex, 1);
            nextAssets.unshift({
              ...existing,
              title: canonicalPath.split('/').pop() || canonicalPath,
              sourcePath: canonicalPath,
              updatedAt: now,
              modificationCount: (existing.modificationCount ?? 1) + 1,
            });
          } else {
            nextAssets.unshift({
              id: `file:${canonicalPath}`,
              kind: /\.(png|jpe?g|gif|webp|svg)$/i.test(canonicalPath) ? 'image' : 'document',
              title: canonicalPath.split('/').pop() || canonicalPath,
              prompt: job.displayText,
              createdAt: now,
              updatedAt: now,
              modificationCount: 1,
              sourcePath: canonicalPath,
            });
          }
        }
        saveSessionAssets(sid, nextAssets);
        set({ assets: nextAssets });
      }

      if (!content.trim() || content === '작업 중…') {
        finishAssistantText('(빈 응답)');
      } else {
        finishAssistantText(content);
      }

      set({ apiOnline: true, apiError: null });
      if (get().modelOptions.length <= 1) {
        void get().refreshModelPicker().catch(() => undefined);
      }
      finishJob(sid);
    } catch (err) {
      if (isAbortError(err) || job.abort.signal.aborted) {
        if (!job.chat.find((t) => t.id === job.assistantId)?.text?.trim()) {
          patchAssistant({ text: '(중지됨)', streamPreview: undefined });
        } else {
          patchAssistant({ streamPreview: undefined });
        }
        finishJob(sid);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      patchAssistant({ text: `[오류] ${message}`, streamPreview: undefined });
      if (get().activeSessionId === sid) {
        set({ apiOnline: false, apiError: message });
      }
      finishJob(sid);
    }
  };

  return {
    mode: 'objects',
    browserInputUrl: '',
    browserLoadedUrl: '',
    browserHistory: [],
    browserHistoryIndex: -1,
    browserReloadKey: 0,
    files: [],
    filesRoot: null,
    filesMessage: '작업 폴더를 연결하면 여기에 실제 파일이 표시됩니다.',
    assets: [],
    chat: [],
    openTabs: [{ id: 'buffer-initial', title: '새 버퍼', language: 'plaintext', content: '' }],
    activeTabId: 'buffer-initial',
    activeFileId: null,
    editorContent: '',
    editorSaveStatus: null,
    editorSaving: false,
    canvasNodes: [],
    canvasEdges: [],
    busy: false,
    statusText: '',
    openGateText: '',
    contextBudget: null,
    selectedModel: 'auto',
    activeExecutionPolicy: { reasoning: 'auto', autopilot: 'auto', approval: 'ask' },
    effectiveExecutionPolicy: null,
    modelOptions: [{ id: 'auto', label: '기본 (자동)' }],
    apiOnline: null,
    apiError: null,
    previewPaneOpen: true,
    terminalOpen: readTerminalOpenPref(),
    terminalBusy: false,
    terminalLog: '',
    terminalJobId: null,
    terminalAttention: false,
    imagePreview: null,
    activeSessionId: null,
    activeProjectId: null,
    activeWorkspaceProjectId: null,
    skillMode: null,
    skillLabel: null,
    licenseMode: null,
    licenseEnforced: false,
    pendingAttachments: [],
    pendingContextPaths: [],
    streamAbort: null,
    canUndo: false,
    sessionPhases: {},
    messageQueue: loadMessageQueue(),
    removeQueuedMessage: (id) => {
      const queue = get().messageQueue.filter((item) => item.id !== id);
      saveMessageQueue(queue);
      set({ messageQueue: queue });
    },

    setMode: (mode) => set({ mode }),
    setBrowserInputUrl: (browserInputUrl) => set({ browserInputUrl }),
    navigateBrowser: (rawUrl) =>
      set((state) => {
        const url = validHttpUrl(rawUrl);
        if (!url) return state;
        if (url === state.browserLoadedUrl && state.browserHistoryIndex >= 0) {
          return { browserInputUrl: url, browserLoadedUrl: url };
        }
        const trimmed = [
          ...state.browserHistory.slice(0, state.browserHistoryIndex + 1),
          url,
        ].slice(-BROWSER_HISTORY_MAX);
        return {
          browserInputUrl: url,
          browserLoadedUrl: url,
          browserHistory: trimmed,
          browserHistoryIndex: trimmed.length - 1,
        };
      }),
    reloadBrowser: () => set((state) => ({ browserReloadKey: state.browserReloadKey + 1 })),
    goBrowserBack: () =>
      set((state) => {
        const browserHistoryIndex = state.browserHistoryIndex - 1;
        if (browserHistoryIndex < 0) return state;
        const browserLoadedUrl = state.browserHistory[browserHistoryIndex];
        if (!browserLoadedUrl) return state;
        return { browserHistoryIndex, browserLoadedUrl, browserInputUrl: browserLoadedUrl };
      }),
    goBrowserForward: () =>
      set((state) => {
        const browserHistoryIndex = state.browserHistoryIndex + 1;
        if (browserHistoryIndex >= state.browserHistory.length) return state;
        const browserLoadedUrl = state.browserHistory[browserHistoryIndex];
        if (!browserLoadedUrl) return state;
        return { browserHistoryIndex, browserLoadedUrl, browserInputUrl: browserLoadedUrl };
      }),
    setSelectedModel: (selectedModel) => set({ selectedModel }),
    setExecutionPolicy: async (patch) => {
      const policy = { ...get().activeExecutionPolicy, ...patch };
      set({ activeExecutionPolicy: policy, effectiveExecutionPolicy: null });
      let sid = get().activeSessionId;
      if (!sid) {
        executionPolicySessionPromise ??= createSession(get().activeProjectId);
        try {
          sid = await executionPolicySessionPromise;
        } finally {
          executionPolicySessionPromise = null;
        }
        if (!get().activeSessionId) set({ activeSessionId: sid });
      }
      const latest = get().activeExecutionPolicy;
      const revision = (executionPolicySaveRevisions.get(sid) ?? 0) + 1;
      executionPolicySaveRevisions.set(sid, revision);
      const previous = executionPolicySaveQueues.get(sid) ?? Promise.resolve();
      const save = previous
        .catch(() => undefined)
        .then(() => setSessionExecutionPolicy(sid, latest));
      executionPolicySaveQueues.set(sid, save);
      const rec = await save;
      if (get().activeSessionId === sid && executionPolicySaveRevisions.get(sid) === revision) {
        set({ activeExecutionPolicy: rec.execution_policy ?? latest });
      }
    },
    setSessionWorkspaceProject: async (workspaceProjectId) => {
      let sessionId = get().activeSessionId;
      if (!sessionId) {
        sessionId = await createSession(get().activeProjectId);
        set({ activeSessionId: sessionId });
        setStoredSessionId(sessionId);
      }
      const rec = await saveSessionWorkspaceProject(sessionId, workspaceProjectId);
      const remainingTabs = get().openTabs.filter((tab) => !tab.id.startsWith('file:'));
      set({
        activeWorkspaceProjectId: rec.workspace_project_id ?? null,
        files: [],
        filesRoot: null,
        filesMessage: '작업 폴더를 불러오는 중…',
        openTabs: remainingTabs,
        activeTabId: remainingTabs[0]?.id ?? null,
        activeFileId: null,
        editorContent: remainingTabs[0]?.content ?? '',
      });
      await get().refreshExplorer();
    },
    setSessionProject: async (projectId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) throw new Error('이동할 대화 세션이 없습니다.');
      const rec = await saveSessionProject(sessionId, projectId);
      set({ activeProjectId: rec.project_id ?? null });
      cacheActiveSessionView();
    },
    setModelOptions: (modelOptions) => set({ modelOptions }),
    refreshModelPicker: async (refreshRemote = false) => {
      const picker = await fetchModelPicker(refreshRemote);
      const models = picker.models.length ? picker.models : FALLBACK_MODEL_OPTIONS;
      const saved = readStoredPreference(MODEL_PREF_KEY, LEGACY_MODEL_PREF_KEY);
      const pick =
        (saved && models.some((m) => m.id === saved) && saved) ||
        (picker.default_id && models.some((m) => m.id === picker.default_id) && picker.default_id) ||
        'auto';
      set({ modelOptions: models, selectedModel: pick });
      return models.length;
    },
    setApiStatus: (apiOnline, apiError = null) => set({ apiOnline, apiError }),
    setLicenseMode: (licenseMode) => set({ licenseMode }),
    setLicenseEnforced: (licenseEnforced) => set({ licenseEnforced }),
    setPreviewPaneOpen: (previewPaneOpen) => set({ previewPaneOpen }),
    setTerminalOpen: (terminalOpen) => {
      try {
        localStorage.setItem(TERMINAL_OPEN_KEY, terminalOpen ? '1' : '0');
      } catch {
        /* ignore */
      }
      set({ terminalOpen, terminalAttention: terminalOpen ? false : get().terminalAttention });
      if (terminalOpen && !get().filesRoot) {
        void get().refreshExplorer();
      }
    },
    clearTerminalAttention: () => set({ terminalAttention: false }),
    clearTerminalLog: () => set({ terminalLog: '' }),
    runTerminalCommand: async (command) => {
      const trimmed = command.trim();
      if (!trimmed || get().terminalBusy) return;
      // Do not gate on filesRoot — API uses server-side dev_workspace_root.
      // Explorer may not have refreshed yet even when a workspace is connected.
      if (!get().filesRoot) {
        try {
          await get().refreshExplorer();
        } catch {
          /* ignore; API will report NO_DEV_WORKSPACE if needed */
        }
      }
      const prev = get().terminalLog;
      const promptLine = `$ ${trimmed}`;
      const jobId = `ui_term_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      set({
        terminalBusy: true,
        terminalJobId: jobId,
        terminalOpen: true,
        terminalLog: prev ? `${prev}\n${promptLine}` : promptLine,
      });
      try {
        const result = await runWorkspaceTerminal(trimmed, {
          async: true,
          jobId,
          timeoutMs: 180_000,
        });
        const body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        const status = result.cancelled
          ? 'cancelled'
          : result.ok
            ? `exit ${result.exit_code ?? 0}`
            : `exit ${result.exit_code ?? '?'} (failed)`;
        const chunk = body ? `${body}\n[${status}]` : `[${status}]`;
        const next = `${get().terminalLog}\n${chunk}`;
        set({ terminalLog: next, terminalBusy: false, terminalJobId: null, terminalAttention: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        set({
          terminalLog: `${get().terminalLog}\nERROR: ${msg}`,
          terminalBusy: false,
          terminalJobId: null,
          terminalAttention: true,
        });
      }
    },

    cancelTerminalCommand: async () => {
      const jobId = get().terminalJobId;
      if (!jobId && !get().terminalBusy) return;
      try {
        if (jobId) {
          await cancelRunTerminalJob({ jobId });
        }
        set({
          terminalLog: `${get().terminalLog}\n… cancel requested`,
        });
      } catch {
        /* cancel best-effort; run_terminal will resolve on kill */
      }
    },

    openImagePreview: (imagePreview) => set({ imagePreview }),
    closeImagePreview: () => set({ imagePreview: null }),
    setSkillMode: (skillMode, skillLabel = null) =>
      set({ skillMode, skillLabel: skillMode ? skillLabel : null }),
    hydrateOrganizationSkillDefault: async () => {
      if (get().skillMode) return;
      try {
        const skills = await listSkills();
        if (get().skillMode) return;
        const concept =
          skills.find((s) => s.source === 'organization' && s.id === 'brand_concept') ??
          skills.find((s) => s.source === 'organization');
        if (concept) set({ skillMode: concept.mode, skillLabel: concept.label });
      } catch {
        /* org module optional */
      }
    },

    addPendingAttachments: (items) => {
      if (!items.length) return;
      set({ pendingAttachments: [...get().pendingAttachments, ...items] });
    },

    removePendingAttachment: async (id) => {
      const target = get().pendingAttachments.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      set({ pendingAttachments: get().pendingAttachments.filter((a) => a.id !== id) });
      await deleteAttachment(id);
    },

    clearPendingAttachments: () => {
      for (const a of get().pendingAttachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      set({ pendingAttachments: [] });
    },

    addContextPath: (raw) => {
      const path = String(raw || '').replace(/\\/g, '/').trim().replace(/^\//, '');
      if (!path || /^buffer\.(tsx|ts|jsx|js)$/i.test(path)) return;
      const cur = get().pendingContextPaths;
      if (cur.includes(path)) return;
      set({ pendingContextPaths: [...cur, path].slice(0, 24) });
    },

    removeContextPath: (raw) => {
      const path = String(raw || '').replace(/\\/g, '/').trim();
      set({ pendingContextPaths: get().pendingContextPaths.filter((p) => p !== path) });
    },

    clearContextPaths: () => set({ pendingContextPaths: [] }),

    uploadFiles: async (files) => {
      if (!files.length) return;
      if (get().licenseMode && get().licenseMode !== 'full') {
        throw new Error('라이선스 필요');
      }
      const uploaded = await uploadAttachments(files);
      const items: PendingAttachment[] = uploaded.map((u, i) => {
        const file = files[i];
        const mime = u.mime || file?.type || '';
        const name = u.name || file?.name || '';
        const isImage =
          mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(name);
        return {
          id: u.id,
          name: u.name,
          mime: u.mime || mime || undefined,
          previewUrl: isImage && file ? URL.createObjectURL(file) : undefined,
        };
      });
      get().addPendingAttachments(items);
    },

    uploadClipboardImages: async (files) => get().uploadFiles(files),

    startNewChat: async (projectId = null) => {
      get().clearPendingAttachments();
      cacheActiveSessionView();
      const id = await createSession(projectId);
      const rec = await fetchSession(id);
      set({
        activeSessionId: id,
        activeProjectId: projectId,
        activeWorkspaceProjectId: rec.workspace_project_id ?? null,
        chat: [],
        activeExecutionPolicy: rec.execution_policy ?? { reasoning: 'auto', autopilot: 'auto', approval: 'ask' },
        effectiveExecutionPolicy: null,
        canUndo: false,
        assets: [],
        canvasNodes: [],
        canvasEdges: [],
        skillMode: null,
        skillLabel: null,
      });
      cacheActiveSessionView();
      syncViewBusy();
    },

    clearActiveChat: () => {
      get().clearPendingAttachments();
      cacheActiveSessionView();
      clearStoredSessionId();
      set({
        activeSessionId: null,
        activeProjectId: null,
        activeWorkspaceProjectId: null,
        chat: [],
        effectiveExecutionPolicy: null,
        canUndo: false,
        assets: [],
        canvasNodes: [],
        canvasEdges: [],
      });
      syncViewBusy();
    },

    loadChatSession: async (sessionId) => {
      get().clearPendingAttachments();
      cacheActiveSessionView();

      const live = liveJobs.get(sessionId);
      const cached = sessionViewCache.get(sessionId);
      setStoredSessionId(sessionId);

      if (cached || live) {
        const snapshot = cached;
        set({
          activeSessionId: sessionId,
          activeProjectId: snapshot?.activeProjectId ?? null,
          activeWorkspaceProjectId: snapshot?.activeWorkspaceProjectId ?? null,
          chat: live?.chat ?? snapshot?.chat ?? [],
          activeExecutionPolicy: live?.executionPolicy ?? snapshot?.activeExecutionPolicy ?? { reasoning: 'auto', autopilot: 'auto', approval: 'ask' },
          effectiveExecutionPolicy: live?.effectiveExecutionPolicy ?? snapshot?.effectiveExecutionPolicy ?? null,
          canUndo: live ? false : (snapshot?.canUndo ?? false),
          assets: snapshot?.assets ?? [],
          canvasNodes: snapshot?.canvasNodes ?? [],
          canvasEdges: snapshot?.canvasEdges ?? [],
        });
      } else {
        // Do not leave the previous conversation visible while the first fetch is pending.
        set({
          activeSessionId: sessionId,
          activeProjectId: null,
          activeWorkspaceProjectId: null,
          chat: [],
          activeExecutionPolicy: { reasoning: 'auto', autopilot: 'auto', approval: 'ask' },
          effectiveExecutionPolicy: null,
          canUndo: false,
          assets: [],
          canvasNodes: [],
          canvasEdges: [],
        });
      }
      syncViewBusy();

      // Refresh from the server without blocking the visible session switch.
      void fetchSession(sessionId).then((rec) => {
        const messages = rec.messages ?? [];
        const currentLive = liveJobs.get(sessionId);
        const previous = sessionViewCache.get(sessionId);
        const refreshed: SessionViewSnapshot = {
          activeProjectId: rec.project_id ?? null,
          activeWorkspaceProjectId: rec.workspace_project_id ?? null,
          chat: currentLive?.chat ?? sessionMessagesToChat(messages),
          activeExecutionPolicy: currentLive?.executionPolicy ?? rec.execution_policy ?? { reasoning: 'auto', autopilot: 'auto', approval: 'ask' },
          effectiveExecutionPolicy: currentLive?.effectiveExecutionPolicy ?? null,
          canUndo: currentLive ? false : messages.some((m) => m.role === 'user'),
          assets: currentLive && previous
            ? previous.assets
            : [...loadSessionAssets(sessionId), ...assetsFromMessages(messages)],
          canvasNodes: previous?.canvasNodes ?? [],
          canvasEdges: previous?.canvasEdges ?? [],
        };
        sessionViewCache.set(sessionId, refreshed);
        if (get().activeSessionId !== sessionId) return;
        set({
          activeProjectId: refreshed.activeProjectId,
          activeWorkspaceProjectId: refreshed.activeWorkspaceProjectId,
          chat: refreshed.chat,
          activeExecutionPolicy: refreshed.activeExecutionPolicy,
          effectiveExecutionPolicy: refreshed.effectiveExecutionPolicy,
          canUndo: refreshed.canUndo,
          assets: refreshed.assets,
          canvasNodes: refreshed.canvasNodes,
          canvasEdges: refreshed.canvasEdges,
        });
        syncViewBusy();
      }).catch(() => {
        // A cached/live view remains usable when a background refresh fails.
      });
    },

    openFile: async (id) => {
      const existing = get().openTabs.find((tab) => tab.id === `file:${id}`);
      if (existing) {
        get().setActiveTab(existing.id);
        set({ mode: 'editor', filesMessage: null });
        return;
      }
      try {
        const { content } = await readWorkspaceFsFile(id);
        get().openEditorTab({
          id: `file:${id}`,
          title: id.split(/[\\/]/).pop() || id,
          language: inferEditorLanguage(id),
          content,
        });
        set({ filesMessage: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ filesMessage: message, activeFileId: id, mode: 'editor' });
      }
    },

    openMutatedWorkspaceFiles: async (paths) => {
      const seen = new Set<string>();
      const cleaned = paths
        .map((p) => String(p || '').replace(/\\/g, '/').trim())
        .filter((p) => {
          if (!p || seen.has(p)) return false;
          // Skip build/vendor noise — keep source mutate tabs useful.
          if (/(?:^|\/)(?:node_modules|\.git|dist|build)(?:\/|$)/i.test(p)) return false;
          seen.add(p);
          return true;
        });
      if (!cleaned.length) return;

      let lastOpened: string | null = null;
      for (const rel of cleaned) {
        const tabId = `file:${rel}`;
        const existing = get().openTabs.find((tab) => tab.id === tabId);
        if (existing) {
          if (existing.dirty) {
            const ok = await confirmDialog({
              title: '디스크 버전으로 갱신',
              message: `"${rel}"에 저장되지 않은 편집이 있습니다.\n에이전트가 바꾼 디스크 버전으로 갱신할까요?`,
              confirmLabel: '디스크 버전으로 갱신',
              cancelLabel: '현재 편집 유지',
            });
            if (!ok) {
              get().setActiveTab(tabId);
              lastOpened = rel;
              continue;
            }
          }
          try {
            const { content } = await readWorkspaceFsFile(rel);
            const openTabs = get().openTabs.map((tab) =>
              tab.id === tabId ? { ...tab, content, dirty: false } : tab,
            );
            const active = get().activeTabId === tabId;
            set({
              openTabs,
              mode: 'editor',
              filesMessage: null,
              ...(active ? { editorContent: content, editorSaveStatus: null } : {}),
            });
            get().setActiveTab(tabId);
            lastOpened = rel;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set({ filesMessage: message, mode: 'editor' });
          }
          continue;
        }
        try {
          const { content } = await readWorkspaceFsFile(rel);
          get().openEditorTab({
            id: tabId,
            title: rel.split(/[\\/]/).pop() || rel,
            language: inferEditorLanguage(rel),
            content,
          });
          set({ mode: 'editor', filesMessage: null });
          lastOpened = rel;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          set({ filesMessage: message, mode: 'editor' });
        }
      }
      if (lastOpened) {
        set({ activeFileId: lastOpened, mode: 'editor' });
      }
    },

    refreshExplorer: async () => {
      try {
        const data = await fetchWorkspaceFsTree(3);
        if (!data.root) {
          set({
            files: [],
            filesRoot: null,
            filesMessage: data.message || '폴더를 연결하세요',
          });
          return;
        }
        set({
          files: mapFsTree(data.tree),
          filesRoot: data.root,
          filesMessage: data.tree.length ? null : '작업 폴더가 비어 있습니다.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ files: [], filesRoot: null, filesMessage: message });
      }
    },

    setEditorContent: (editorContent) => {
      const activeTabId = get().activeTabId;
      if (!activeTabId) return;
      const activeTab = get().openTabs.find((tab) => tab.id === activeTabId);
      if (!activeTab || activeTab.content === editorContent) return;
      set({
        editorContent,
        editorSaveStatus: null,
        openTabs: get().openTabs.map((tab) =>
          tab.id === activeTabId ? { ...tab, content: editorContent, dirty: true } : tab,
        ),
      });
    },
    saveActiveFile: async () => {
      const tabId = get().activeTabId;
      const relPath = fileIdFromTabId(tabId);
      const tab = get().openTabs.find((item) => item.id === tabId);
      if (!tab || !relPath) {
        set({ editorSaveStatus: '폴더 파일만 저장' });
        return;
      }
      if (get().editorSaving) return;
      if (!tab.dirty) {
        set({ editorSaveStatus: '변경 없음' });
        return;
      }
      const savedContent = tab.content;
      set({ editorSaving: true, editorSaveStatus: '저장 중…' });
      try {
        await writeWorkspaceFsFile(relPath, savedContent);
        const reloaded = await readWorkspaceFsFile(relPath);
        const current = get().openTabs.find((item) => item.id === tabId);
        if (!current || current.content !== savedContent) {
          set({ editorSaving: false, editorSaveStatus: '저장됨' });
          return;
        }
        set({
          editorSaving: false,
          editorSaveStatus: '저장됨',
          editorContent: get().activeTabId === tabId ? reloaded.content : get().editorContent,
          openTabs: get().openTabs.map((item) =>
            item.id === tabId ? { ...item, content: reloaded.content, dirty: false } : item,
          ),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ editorSaving: false, editorSaveStatus: `저장 실패: ${message}` });
      }
    },
    renameWorkspaceFile: async (relPath, name) => {
      const nextName = name.trim();
      if (!nextName) {
        set({ editorSaveStatus: '파일명 필요' });
        return;
      }
      try {
        const { path: nextPath } = await renameWorkspaceFsFile(relPath, nextName);
        const previousId = `file:${relPath}`;
        const nextId = `file:${nextPath}`;
        const activeWasRenamed = get().activeTabId === previousId;
        set({
          openTabs: get().openTabs.map((tab) =>
            tab.id === previousId
              ? {
                  ...tab,
                  id: nextId,
                  title: fileNameFromPath(nextPath),
                  language: inferEditorLanguage(nextPath),
                }
              : tab,
          ),
          activeTabId: activeWasRenamed ? nextId : get().activeTabId,
          activeFileId: activeWasRenamed ? nextPath : get().activeFileId,
          editorSaveStatus: `${fileNameFromPath(nextPath)} 이름 변경됨`,
        });
        await get().refreshExplorer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ editorSaveStatus: `이름 변경 실패: ${message}` });
        throw err;
      }
    },
    openEditorTab: (tab) => {
      const existing = get().openTabs.find((item) => item.id === tab.id);
      const activeTab = existing ?? tab;
      set({
        mode: 'editor',
        openTabs: existing ? get().openTabs : [...get().openTabs, tab],
        activeTabId: activeTab.id,
        activeFileId: fileIdFromTabId(activeTab.id),
        editorContent: activeTab.content,
      });
    },
    setActiveTab: (tabId) => {
      const tab = get().openTabs.find((item) => item.id === tabId);
      if (!tab) return;
      set({
        activeTabId: tab.id,
        activeFileId: fileIdFromTabId(tab.id),
        editorContent: tab.content,
      });
    },
    closeEditorTab: async (tabId) => {
      const tab = get().openTabs.find((item) => item.id === tabId);
      if (!tab) return;
      const relPath = fileIdFromTabId(tabId);
      // Policy: non-file buffers have no workspace save target, so they close immediately.
      if (tab.dirty && relPath) {
        const choice = await choiceDialog({
          title: '저장되지 않은 변경',
          message: `"${tab.title}"에 저장되지 않은 변경이 있습니다.`,
          options: [
            { id: 'save', label: '저장 후 닫기' },
            { id: 'discard', label: '저장 안 하고 닫기', danger: true },
            { id: 'cancel', label: '취소' },
          ],
          allowBackdropDismiss: false,
        });
        if (choice === 'cancel' || choice === null) return;
        if (choice === 'save') {
          if (get().editorSaving) return;
          const savedContent = tab.content;
          set({ editorSaving: true, editorSaveStatus: '저장 중…' });
          try {
            await writeWorkspaceFsFile(relPath, savedContent);
            const { content } = await readWorkspaceFsFile(relPath);
            const current = get().openTabs.find((item) => item.id === tabId);
            if (!current || current.content !== savedContent) {
              set({ editorSaving: false, editorSaveStatus: '저장됨' });
              return;
            }
            set({
              editorSaving: false,
              editorSaveStatus: '저장됨',
              openTabs: get().openTabs.map((item) =>
                item.id === tabId ? { ...item, content, dirty: false } : item,
              ),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set({ editorSaving: false, editorSaveStatus: `저장 실패: ${message}` });
            return;
          }
        }
      }
      const tabs = get().openTabs;
      const index = tabs.findIndex((item) => item.id === tabId);
      if (index < 0) return;
      const openTabs = tabs.filter((item) => item.id !== tabId);
      const currentActive = get().activeTabId;
      const nextTab =
        currentActive === tabId ? openTabs[Math.min(index, openTabs.length - 1)] ?? null :
          openTabs.find((item) => item.id === currentActive) ?? openTabs[0] ?? null;
      set({
        openTabs,
        activeTabId: nextTab?.id ?? null,
        activeFileId: fileIdFromTabId(nextTab?.id ?? null),
        editorContent: nextTab?.content ?? '',
      });
    },
    setCanvasNodes: (canvasNodes) => set({ canvasNodes }),
    setCanvasEdges: (canvasEdges) => set({ canvasEdges }),

    updateCanvasNodeSize: (nodeId, width, height) => {
      set({
        canvasNodes: get().canvasNodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                style: { ...n.style, width, height },
                data: { ...n.data, cardWidth: width, cardHeight: height },
              }
            : n,
        ),
      });
    },

    updateAssetPrompt: (assetId, prompt) => {
      set({
        assets: get().assets.map((a) => (a.id === assetId ? { ...a, prompt } : a)),
        canvasNodes: get().canvasNodes.map((n) =>
          n.data?.assetId === assetId ? { ...n, data: { ...n.data, prompt } } : n,
        ),
      });
    },

    regenerateAsset: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return;
      if (asset.kind === 'image') {
        void get().sendAiMessage(asset.prompt || asset.title);
        return;
      }
      const stamp = `// regenerated ${new Date().toLocaleTimeString()}\n`;
      const content = stamp + (asset.content ?? '');
      set({
        assets: get().assets.map((a) => (a.id === assetId ? { ...a, content } : a)),
        canvasNodes: get().canvasNodes.map((n) =>
          n.data?.assetId === assetId ? { ...n, data: { ...n.data, content } } : n,
        ),
      });
    },

    downloadAsset: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return;
      if (asset.kind === 'image' && asset.imageUrl) {
        const a = document.createElement('a');
        a.href = asset.imageUrl;
        a.download = asset.title;
        a.click();
        return;
      }
      void (async () => {
        const content = asset.sourcePath
          ? (await readWorkspaceFsFile(asset.sourcePath)).content
          : asset.content ?? asset.title;
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const fallbackExtension = asset.kind === 'code' ? '.txt' : '.md';
        a.download = /\.[^./\\]+$/.test(asset.title) ? asset.title : `${asset.title}${fallbackExtension}`;
        a.click();
        URL.revokeObjectURL(url);
      })().catch(() => undefined);
    },

    removeCanvasNode: (nodeId) => {
      const id = nodeId.trim();
      if (!id) return;
      set({
        canvasNodes: get().canvasNodes.filter((n) => n.id !== id),
        canvasEdges: get().canvasEdges.filter((e) => e.source !== id && e.target !== id),
      });
    },

    openFileOnCanvas: async (relPath) => {
      const { content } = await readWorkspaceFsFile(relPath);
      const title = fileNameFromPath(relPath) || relPath;
      const asset: WorkspaceAsset = {
        id: `workflow-${relPath}`,
        kind: 'document',
        title,
        createdAt: new Date().toISOString(),
        content,
        language: /\.(mmd|mermaid)$/i.test(title) ? 'mermaid' : undefined,
      };
      if (!isCanvasAsset(asset)) {
        await get().openFile(relPath);
        return;
      }
      const assets = [asset, ...get().assets.filter((item) => item.id !== asset.id)];
      const node = assetToCanvasNode(asset, { x: 180, y: 160 });
      set({ mode: 'canvas', assets, canvasNodes: [...get().canvasNodes, node] });
    },

    placeAssetOnCanvas: (assetId, position) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return;
      if (!isCanvasAsset(asset)) {
        get().openAssetInEditor(assetId);
        return;
      }
      const node = assetToCanvasNode(
        asset,
        position ?? { x: 120 + Math.random() * 200, y: 100 + Math.random() * 160 },
      );
      set({ mode: 'canvas', canvasNodes: [...get().canvasNodes, node] });
    },

    openAssetInEditor: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset || asset.kind === 'image') {
        get().placeAssetOnCanvas(assetId);
        return;
      }
      if (asset.sourcePath) {
        void get().openFile(asset.sourcePath);
        return;
      }
      get().openEditorTab({
        id: `asset:${asset.id}`,
        title: asset.title || '코드 자산',
        language: asset.language || inferEditorLanguage(asset.title),
        content: asset.content ?? '',
      });
    },

    sendAiMessage: async (text) => {
      const trimmed = text.trim();
      const pending = get().pendingAttachments;
      const attachmentIds = pending.map((a) => a.id);
      const attachmentNames = pending.map((a) => a.name);
      if ((!trimmed && !attachmentIds.length)) return;

      let sid = get().activeSessionId;
      if (!sid) {
        sid = await createSession(get().activeProjectId);
        set({ activeSessionId: sid });
      }
      if (liveJobs.has(sid) || get().sessionPhases[sid]) {
        const queued: QueuedMessage = {
          id: uid('queue'),
          sessionId: sid,
          text: trimmed,
          attachmentIds,
          attachmentNames,
          contextPaths: [...get().pendingContextPaths],
          createdAt: new Date().toISOString(),
        };
        const queue = [...get().messageQueue, queued];
        saveMessageQueue(queue);
        for (const attachment of pending) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
        set({ messageQueue: queue, pendingAttachments: [], pendingContextPaths: [] });
        return;
      }

      const skillMode = get().skillMode;
      const model = get().selectedModel || 'auto';
      const assistantId = uid('s');
      const displayText =
        trimmed ||
        (attachmentNames.length
          ? `첨부: ${attachmentNames.join(', ')}`
          : '');
      const userTurn: ChatTurn = {
        id: uid('u'),
        role: 'user',
        mode: 'text',
        text: displayText,
        attachmentNames: attachmentNames.length ? attachmentNames : undefined,
      };
      const assistantTurn: ChatTurn = {
      id: assistantId,
      role: 'assistant',
      mode: 'text',
      text: '',
      model,
      startedAt: new Date().toISOString(),
    };
      const chat = [...get().chat, userTurn, assistantTurn];
      const abort = new AbortController();

      for (const a of pending) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }

      const job: LiveJob = {
        sessionId: sid,
        abort,
        userTurn,
        assistantId,
        chat,
        statusText: '연결 중…',
        displayText,
        skillMode,
        model,
        executionPolicy: { ...get().activeExecutionPolicy },
        effectiveExecutionPolicy: null,
        attachmentIds,
        editorPath: get().activeFileId ?? '',
        editorSelection: get().activeFileId ? get().editorContent.slice(0, 4000) : '',
        contextPaths: [...get().pendingContextPaths],
        terminalUsed: false,
      };
      liveJobs.set(sid, job);
      setStoredSessionId(sid);
      set({
        pendingAttachments: [],
        pendingContextPaths: [],
        canUndo: false,
        sessionPhases: { ...get().sessionPhases, [sid]: 'running' },
        chat,
        busy: true,
        statusText: '연결 중…',
        streamAbort: abort,
      });
      void runJob(sid);
    },

    stopAiMessage: () => {
      const sid = get().activeSessionId;
      if (!sid) return;
      const phase = get().sessionPhases[sid];
      const job = liveJobs.get(sid);
      if (!phase || !job) return;
      if (phase !== 'running') return;
      set({ statusText: '중지 중…' });
      job.abort.abort();
      void cancelRunTerminalJob({ sessionId: sid }).catch(() => undefined);
    },

    undoLastTurn: async () => {
      const sid = get().activeSessionId;
      if (!sid || get().busy) return null;
      try {
        const result = await undoSessionTurn(sid);
        const rec = await fetchSession(sid);
        const messages = rec.messages ?? [];
        set({
          chat: sessionMessagesToChat(messages),
          canUndo: false,
        });
        return result.userText ?? null;
      } catch {
        set({ canUndo: false });
        return null;
      }
    },
  };
});

export { ASSET_MIME };

export function bootstrapCanvasEdges(): void {
  const { canvasNodes, canvasEdges, setCanvasEdges } = useWorkspaceStore.getState();
  // Keep edges coherent with node count; do not invent demo seed edges.
  if (canvasNodes.length < 2 && canvasEdges.length > 0) {
    setCanvasEdges([]);
  }
}
