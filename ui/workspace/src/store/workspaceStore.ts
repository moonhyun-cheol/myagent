import { create } from 'zustand';
import { BROWSER_HISTORY_MAX, validHttpUrl } from '../lib/browserUrl';
import { choiceDialog, confirmDialog } from '../lib/confirmDialog';
import { showUserNotification } from '../lib/userNotifications';
import {
  PLAN_BUILD_USER_MESSAGE,
  shouldOfferPlanBuild,
} from '../lib/plan-build';
import type {
  AiWorkMode,
  ChatTurn,
  FileNode,
  PendingAttachment,
  WorkspaceAsset,
  WorkspaceMode,
} from '../types';
import { isCanvasAsset } from '../types';
import { isDocumentMemoMessage } from '../lib/documentMemo';
import { normalizeWorkspaceMode } from '../components/workspacePreviewModes';
import {
  documentRecoveryRelPath,
  documentTitleFromPath,
  dumpRelPath,
  isAiDocumentOpenPath,
  isAllowedDocumentPath,
  isDocumentScratchPath,
  normalizeRelPath,
} from '../lib/documentFile';
import type { DocumentTab, DocumentMemo } from '../lib/documentFile';
import type { Edge, Node } from '@xyflow/react';
import {
  clearStoredSessionId,
  createSession,
  deleteAttachment,
  fetchDefaultModelOverride,
  fetchModelPicker,
  fetchSession,
  fetchWorkspaceFsTree,
  readWorkspaceFsFile,
  renameWorkspaceFsFile,
  resolveWorkspaceRootProjectId,
  runWorkspaceTerminal,
  setStoredSessionId,
  streamChat,
  setSessionExecutionPolicy,
  setSessionPreferredModel,
  setSessionProject as saveSessionProject,
  setSessionWorkspaceProject as saveSessionWorkspaceProject,
  undoSessionTurn,
  uploadAttachments,
  writeWorkspaceFsFile,
  rollbackWorkspaceCheckpoint,
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

function newDraftDocumentTab(existing: DocumentTab[]): DocumentTab {
  const used = new Set(existing.filter((tab) => tab.source === 'draft').map((tab) => tab.title));
  let index = 1;
  while (used.has(`제목 없음 ${index}`)) index += 1;
  return {
    id: uid('doc'),
    title: `제목 없음 ${index}`,
    path: null,
    source: 'draft',
    content: '',
    dirty: false,
    selection: '',
    view: 'preview',
    status: '임시 초안',
    lastDumpPath: null,
    lastDumpContent: null,
    memos: [],
    recoveryPath: null,
  };
}

function activeDocumentTab(state: Pick<WorkspaceState, 'documentTabs' | 'activeDocumentTabId'>): DocumentTab | null {
  return state.documentTabs.find((tab) => tab.id === state.activeDocumentTabId) ?? null;
}

function emptyDocumentState(): Pick<WorkspaceState, 'documentTabs' | 'activeDocumentTabId'> {
  const tab = newDraftDocumentTab([]);
  return { documentTabs: [tab], activeDocumentTabId: tab.id };
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

/** Prefix for document sticky-note asks — restored sessions stay out of ChatPane. */
export { DOCUMENT_MEMO_MARKER, isDocumentMemoMessage } from '../lib/documentMemo';

function sessionMessagesToChat(messages: SessionMessage[]): ChatTurn[] {
  return messages.map((m, i) => {
    const urls = Array.isArray(m.image_urls)
      ? m.image_urls.filter((u): u is string => typeof u === 'string' && !!u)
      : [];
    const text = String(m.content ?? '');
    const isPlaceholder =
      urls.length > 0
      && (/이미지를?\s*\d*\s*장?\s*생성했습니다/.test(text) || text.trim() === '');
    const prevUser = m.role === 'assistant' ? messages[i - 1] : undefined;
    const uiHidden =
      isDocumentMemoMessage(text) ||
      (m.role === 'assistant' &&
        typeof prevUser?.content === 'string' &&
        isDocumentMemoMessage(prevUser.content));
    return {
      id: `restored-${i}-${m.at}`,
      role: m.role,
      mode: (m.mode === 'image_gen' ? 'image' : m.mode === 'web_dev' ? 'code' : 'text') as AiWorkMode,
      text: isPlaceholder ? '' : text,
      uiHidden: uiHidden || undefined,
      model: m.role === 'assistant' ? m.reasoning?.model ?? m.model : undefined,
      thought: m.role === 'assistant'
        ? (typeof m.reasoning?.content === 'string' && m.reasoning.content.trim()
          ? m.reasoning.content
          : typeof m.thought === 'string' && m.thought.trim()
            ? m.thought
            : undefined)
        : undefined,
      applicationNotice: m.role === 'assistant' ? m.application_notice : undefined,
      imageUrls: urls.length ? urls : undefined,
      startedAt: m.role === 'assistant' ? messages[i - 1]?.at : undefined,
      completedAt: m.role === 'assistant' ? m.at : undefined,
      planBuildOffer: shouldOfferPlanBuild(messages, i),
      planConstraintsLocked:
        m.role === 'assistant' && typeof m.plan_constraints_locked === 'boolean'
          ? m.plan_constraints_locked
          : undefined,
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
  selectedModel: string;
  activeExecutionPolicy: ExecutionPolicy;
  effectiveExecutionPolicy: EffectiveExecutionPolicy | null;
  canUndo: boolean;
  assets: WorkspaceAsset[];
  canvasNodes: Node[];
  canvasEdges: Edge[];
  documentTabs: DocumentTab[];
  activeDocumentTabId: string | null;
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
  /** document-memo asks stay out of ChatPane and run as ask-only. */
  uiSurface?: 'chat' | 'document-memo';
}

export type PendingMutateReview = {
  checkpointId: string;
  paths: string[];
  sessionId: string;
};

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  attachmentIds: string[];
  attachmentNames: string[];
  contextPaths: string[];
  model?: string;
  createdAt: string;
  uiSurface?: 'chat' | 'document-memo';
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
  /** Preview「문서」 tab — markdown/txt cowork surface. */
  documentTabs: DocumentTab[];
  activeDocumentTabId: string | null;
  /** ChatPane watches this to seed the composer (Ask AI). */
  composerPrefill: string | null;
  composerFocusNonce: number;
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
    contextLength: number;
    effectiveContextLength: number;
    lastProcessedTokens: number | null;
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
  /** Workspace root derived from activeProjectId's ancestors, never stored on the session. */
  activeWorkspaceProjectId: string | null;
  skillMode: string | null;
  skillLabel: string | null;
  licenseMode: string | null;
  pendingAttachments: PendingAttachment[];
  /** Composer @ chips — workspace relative paths. */
  pendingContextPaths: string[];
  /**
   * After code agent mutates: Accept keeps disk, Reject restores auto-checkpoint.
   */
  pendingMutateReview: PendingMutateReview | null;
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
  setSelectedModel: (model: string) => Promise<void>;
  setExecutionPolicy: (policy: Partial<ExecutionPolicy>) => Promise<void>;
  setSessionWorkspaceProject: (workspaceProjectId: string | null) => Promise<void>;
  setSessionProject: (projectId: string | null) => Promise<void>;
  setModelOptions: (models: PickerModel[]) => void;
  /** Reload /models/picker into the chat header dropdown. Returns option count. */
  refreshModelPicker: (refreshRemote?: boolean) => Promise<number>;
  setApiStatus: (online: boolean, error?: string | null) => void;
  setLicenseMode: (mode: string | null) => void;
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
  setDocumentContent: (value: string) => void;
  setDocumentSelection: (value: string) => void;
  setDocumentView: (view: DocumentTab['view']) => void;
  setDocumentMemos: (memos: DocumentMemo[]) => void;
  setActiveDocumentTab: (tabId: string) => void;
  closeDocumentTab: (tabId: string) => Promise<'closed' | 'need-project-save' | 'cancelled'>;
  closeOtherDocumentTabs: (tabId: string) => Promise<void>;
  closeDocumentTabsToTheRight: (tabId: string) => Promise<void>;
  closeSavedDocumentTabs: () => Promise<void>;
  appendToDocument: (text: string) => void;
  openDocumentPath: (relPath: string, initialContent?: string) => Promise<void>;
  saveDocument: () => Promise<void>;
  newDocument: () => Promise<void>;
  saveDocumentToProject: (relPath: string) => Promise<void>;
  saveDocumentAs: (relPath: string) => Promise<void>;
  /** Explicit write to per-tab recovery under .my-agent/docs (not a project file). */
  saveDocumentScratch: () => Promise<void>;
  renameDocument: (relPath: string) => Promise<void>;
  reloadDocumentFromDisk: (tabId: string) => Promise<void>;
  keepDocumentLocalEdits: (tabId: string) => void;
  syncDocumentTabsFromMutations: (paths: string[]) => Promise<void>;
  openLastDump: () => Promise<void>;
  saveDocumentRecovery: () => Promise<void>;
  askAiFromDocumentSelection: () => void;
  flushDocumentAfterWorkspaceConnect: () => Promise<void>;
  clearComposerPrefill: () => void;
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
  addPendingAttachments: (items: PendingAttachment[]) => void;
  removePendingAttachment: (id: string) => Promise<void>;
  clearPendingAttachments: () => void;
  addContextPath: (path: string) => void;
  removeContextPath: (path: string) => void;
  clearContextPaths: () => void;
  acceptMutateReview: () => void;
  /** Reject all or only listed paths (partial rollback). */
  rejectMutateReview: (paths?: string[]) => Promise<void>;
  /** Upload any file type into pending attachments (images get preview chips). */
  uploadFiles: (files: File[]) => Promise<void>;
  /** @deprecated Prefer uploadFiles — kept for clipboard paste call sites. */
  uploadClipboardImages: (files: File[]) => Promise<void>;
  startNewChat: (projectId?: string | null, workspaceProjectId?: string | null) => Promise<void>;
  /** Clear current chat without creating a replacement session (allows zero chats). */
  clearActiveChat: () => void;
  loadChatSession: (sessionId: string) => Promise<void>;
  sendAiMessage: (
    text: string,
    modelOverride?: string,
    opts?: { uiSurface?: 'chat' | 'document-memo' },
  ) => Promise<void>;
  /** Plan → Agent: switch mode and send build prompt for a plan assistant turn. */
  buildFromPlan: (assistantTurnId: string) => Promise<void>;
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
      selectedModel: state.selectedModel,
      chat: liveJobs.get(sid)?.chat ?? state.chat,

      activeExecutionPolicy: liveJobs.get(sid)?.executionPolicy ?? state.activeExecutionPolicy,
      effectiveExecutionPolicy: liveJobs.get(sid)?.effectiveExecutionPolicy ?? state.effectiveExecutionPolicy,
      canUndo: state.canUndo,
      assets: state.assets,
      canvasNodes: state.canvasNodes,
      canvasEdges: state.canvasEdges,
      documentTabs: state.documentTabs,
      activeDocumentTabId: state.activeDocumentTabId,
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

  const dispatchNextQueuedMessage = (sid: string) => {
    if (get().activeSessionId !== sid || liveJobs.has(sid) || get().sessionPhases[sid]) return;
    const next = get().messageQueue.find((item) => item.sessionId === sid);
    if (!next) return;

    const remaining = get().messageQueue.filter((item) => item.id !== next.id);
    saveMessageQueue(remaining);
    set({
      messageQueue: remaining,
      pendingAttachments: next.attachmentIds.map((id, index) => ({
        id,
        name: next.attachmentNames[index] ?? '첨부 파일',
      })),
      pendingContextPaths: next.contextPaths,
    });
    void get().sendAiMessage(next.text, next.model, {
      uiSurface: next.uiSurface === 'document-memo' ? 'document-memo' : 'chat',
    });
  };

  const finishJob = (sid: string) => {
    const finishedJob = liveJobs.get(sid);
    if (finishedJob) {
      const completedAt = new Date().toISOString();
      const isPlanRun = finishedJob.executionPolicy.workspace_behavior === 'plan';
      const completedChat = finishedJob.chat.map((turn) => {
        if (turn.id !== finishedJob.assistantId) return turn;
        const next: ChatTurn = { ...turn, completedAt };
        if (isPlanRun && turn.text?.trim() && turn.text !== '(빈 응답)' && turn.text !== '(중지됨)') {
          next.planBuildOffer = true;
        }
        // Keep uiHidden sticky for document-memo replies.
        if (finishedJob.uiSurface === 'document-memo') {
          next.uiHidden = true;
        }
        return next;
      });
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
    } else if (finishedJob?.terminalUsed) {
      set({ terminalAttention: true });
    }
    queueMicrotask(() => dispatchNextQueuedMessage(sid));
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
      const selection = job.editorSelection?.trim() || '';
      const editor_context =
        hasRealEditorFile || contextPaths.length || selection
          ? {
              path: hasRealEditorFile ? editorPath : contextPaths[0] || '',
              selection: selection || undefined,
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
              if (get().activeSessionId !== sid) return;
              const used = Math.max(0, Math.floor(Number(snap.usedChars) || 0));
              const budget = Math.max(0, Math.floor(Number(snap.budgetChars) || 0));
              set({
                contextBudget: {
                  usedChars: used,
                  budgetChars: budget,
                  contextLength: Math.max(0, Math.floor(Number(snap.contextLength) || 0)),
                  effectiveContextLength: Math.max(
                    0,
                    Math.floor(Number(snap.effectiveContextLength) || 0),
                  ),
                  lastProcessedTokens: get().contextBudget?.lastProcessedTokens ?? null,
                  compressed: Boolean(snap.compressed),
                  fallback128k: Boolean(snap.fallback128k),
                },
              });
            },
            onThought: (t) => {
              const delta = String(t || '');
              if (!delta) return;
              const activeTurn = job.chat.find((turn) => turn.id === job.assistantId);
              const previous = activeTurn?.thought ?? '';
              patchAssistant({ thought: `${previous}${delta}` });
            },
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
              if (
                get().activeSessionId === sid &&
                typeof info.lastProcessedTokens === 'number'
              ) {
                const current = get().contextBudget;
                if (current) {
                  set({
                    contextBudget: {
                      ...current,
                      lastProcessedTokens: Math.max(0, Math.floor(info.lastProcessedTokens)),
                    },
                  });
                }
              }
        if (info.model && info.model !== '중지됨') patchAssistant({ model: info.model });
              if (info.applicationNotice) {
                patchAssistant({ applicationNotice: info.applicationNotice });
              }
              const resolvedMode: AiWorkMode = info.mode === 'web_dev'
                ? 'code'
                : info.mode === 'image_gen'
                  ? 'image'
                  : 'text';
              patchAssistant({
                mode: resolvedMode,
                ...(typeof info.planConstraintsLocked === 'boolean'
                  ? { planConstraintsLocked: info.planConstraintsLocked }
                  : {}),
              });
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
              if (info.model !== '중지됨') {
                const isContinuation = info.applicationNotice?.kind === 'continuation';
                const atChainCap = /한도|자동 진행했습니다/.test(
                  `${info.applicationNotice?.title ?? ''} ${info.applicationNotice?.message ?? ''}`,
                );
                showUserNotification({
                  kind: 'complete',
                  title: isContinuation
                    ? (atChainCap ? '순차 진행 한도에 도달했습니다' : '실행이 중간 종료되었습니다')
                    : finalOnly ? '작업이 완료되었습니다' : '답변이 완료되었습니다',
                  message: isContinuation
                    ? (atChainCap
                      ? '이 대화의 순차 진행 한도까지 자동으로 이어갔습니다.'
                      : '현재 결과는 보존됐습니다. 같은 대화에서 이어서 진행할 수 있습니다.')
                    : finalOnly ? '요청한 작업 결과를 확인할 수 있습니다.' : '새 답변을 확인할 수 있습니다.',
                  persistent: false,
                  system: 'when-hidden',
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
        const mutatedList = [...mutatedWorkspacePaths].map((p) => normalizeRelPath(p));
        await get().syncDocumentTabsFromMutations(mutatedList);
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
    ...emptyDocumentState(),
    composerPrefill: null,
    composerFocusNonce: 0,
    canvasNodes: [],
    canvasEdges: [],
    busy: false,
    statusText: '',
    openGateText: '',
    contextBudget: null,
    selectedModel: 'auto',
    activeExecutionPolicy: { reasoning: 'auto', autopilot: 'auto', approval: 'ask', workspace_behavior: 'agent' },
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
    pendingAttachments: [],
    pendingContextPaths: [],
    pendingMutateReview: null,
    streamAbort: null,
    canUndo: false,
    sessionPhases: {},
    messageQueue: loadMessageQueue(),
    removeQueuedMessage: (id) => {
      const queue = get().messageQueue.filter((item) => item.id !== id);
      saveMessageQueue(queue);
      set({ messageQueue: queue });
    },

    setMode: (mode) => set({ mode: normalizeWorkspaceMode(mode) }),
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
    setSelectedModel: async (selectedModel) => {
      const previous = get().selectedModel;
      const sessionId = get().activeSessionId;
      set({ selectedModel });
      if (!sessionId) return;
      try {
        await setSessionPreferredModel(sessionId, selectedModel);
        const cached = sessionViewCache.get(sessionId);
        if (cached) sessionViewCache.set(sessionId, { ...cached, selectedModel });
      } catch (err) {
        if (get().activeSessionId === sessionId && get().selectedModel === selectedModel) {
          set({ selectedModel: previous });
        }
        throw err;
      }
    },
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
        sessionId = await createSession(workspaceProjectId);
        set({ activeSessionId: sessionId });
        setStoredSessionId(sessionId);
      }
      const rec = await saveSessionWorkspaceProject(sessionId, workspaceProjectId);
      const projectId = rec.project_id ?? null;
      const derivedWorkspaceProjectId = await resolveWorkspaceRootProjectId(projectId);
      const remainingTabs = get().openTabs.filter((tab) => !tab.id.startsWith('file:'));
      set({
        activeProjectId: projectId,
        activeWorkspaceProjectId: derivedWorkspaceProjectId,
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
      const membershipProjectId = rec.project_id ?? null;
      const workspaceRootProjectId = await resolveWorkspaceRootProjectId(membershipProjectId);
      set({
        activeProjectId: membershipProjectId,
        activeWorkspaceProjectId: workspaceRootProjectId,
      });
      cacheActiveSessionView();
    },
    setModelOptions: (modelOptions) => set({ modelOptions }),
    refreshModelPicker: async (refreshRemote = false) => {
      const picker = await fetchModelPicker(refreshRemote);
      const models = picker.models.length ? picker.models : FALLBACK_MODEL_OPTIONS;
      set({ modelOptions: models });
      return models.length;
    },
    setApiStatus: (apiOnline, apiError = null) => set({ apiOnline, apiError }),
    setLicenseMode: (licenseMode) => set({ licenseMode }),
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

    acceptMutateReview: () => {
      set({ pendingMutateReview: null, statusText: '변경 수락됨' });
      window.setTimeout(() => {
        if (get().statusText === '변경 수락됨') set({ statusText: '' });
      }, 2000);
    },

    rejectMutateReview: async (onlyPaths) => {
      const review = get().pendingMutateReview;
      if (!review) return;
      const partial =
        Array.isArray(onlyPaths) && onlyPaths.length > 0
          ? onlyPaths
              .map((p) => String(p || '').replace(/\\/g, '/').trim())
              .filter((p) => review.paths.includes(p))
          : null;
      // Always pass the mutate path list so new files (not in snapshot) can be deleted.
      const targets = partial ?? review.paths;
      if (targets.length === 0) {
        set({ statusText: '선택된 경로 없음' });
        return;
      }
      set({
        statusText: partial
          ? `선택 ${targets.length}개 되돌리는 중…`
          : '변경 되돌리는 중…',
      });
      try {
        const result = await rollbackWorkspaceCheckpoint({
          checkpointId: review.checkpointId,
          sessionId: review.sessionId,
          confirm: true,
          paths: targets,
        });
        if (!result.ok) {
          set({
            statusText: result.message || result.error || '롤백 실패',
          });
          return;
        }
        const remaining = review.paths.filter((p) => !targets.includes(p));
        set({
          pendingMutateReview: remaining.length
            ? { ...review, paths: remaining }
            : null,
        });
        await get().openMutatedWorkspaceFiles(
          targets.filter((p) => !(result.deleted_paths || []).includes(p)),
        );
        await get().refreshExplorer();
        const delN = result.deleted ?? 0;
        set({
          statusText: [
            partial ? '부분 거부' : '변경 거부',
            `복원 ${result.restored ?? 0}`,
            delN ? `삭제 ${delN}` : null,
            remaining.length ? `남은 ${remaining.length}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        });
        window.setTimeout(() => {
          if (/거부|롤백|복원|삭제/.test(get().statusText)) set({ statusText: '' });
        }, 3500);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ statusText: `롤백 오류: ${msg}` });
      }
    },

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

    startNewChat: async (projectId = null, legacyWorkspaceProjectId = null) => {
      get().clearPendingAttachments();
      cacheActiveSessionView();
      const membershipProjectId = projectId ?? legacyWorkspaceProjectId;
      const id = await createSession(membershipProjectId);
      const [rec, globalDefaultModel, workspaceRootProjectId] = await Promise.all([
        fetchSession(id),
        fetchDefaultModelOverride().catch(() => 'auto'),
        resolveWorkspaceRootProjectId(membershipProjectId),
      ]);
      const policy = rec.execution_policy ?? {
        reasoning: 'auto' as const,
        autopilot: 'auto' as const,
        approval: 'ask' as const,
        workspace_behavior: 'agent' as const,
      };
      set({
        activeSessionId: id,
        activeProjectId: rec.project_id ?? membershipProjectId,
        activeWorkspaceProjectId: workspaceRootProjectId,
        chat: [],
        selectedModel: rec.preferred_model ?? globalDefaultModel,
        activeExecutionPolicy: {
          ...policy,
          workspace_behavior: policy.workspace_behavior ?? 'agent',
        },
        effectiveExecutionPolicy: null,
        canUndo: false,
        assets: [],
        canvasNodes: [],
        canvasEdges: [],
        ...emptyDocumentState(),
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
        // First-time / empty composer must not inherit Plan/Ask from the previous chat.
        activeExecutionPolicy: {
          reasoning: 'auto',
          autopilot: 'auto',
          approval: 'ask',
          workspace_behavior: 'agent',
        },
        effectiveExecutionPolicy: null,
        canUndo: false,
        assets: [],
        canvasNodes: [],
        canvasEdges: [],
        ...emptyDocumentState(),
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
          activeExecutionPolicy: live?.executionPolicy ?? snapshot?.activeExecutionPolicy ?? { reasoning: 'auto', autopilot: 'auto', approval: 'ask', workspace_behavior: 'agent' },
          effectiveExecutionPolicy: live?.effectiveExecutionPolicy ?? snapshot?.effectiveExecutionPolicy ?? null,
          canUndo: live ? false : (snapshot?.canUndo ?? false),
          assets: snapshot?.assets ?? [],
          canvasNodes: snapshot?.canvasNodes ?? [],
          canvasEdges: snapshot?.canvasEdges ?? [],
          documentTabs: snapshot?.documentTabs ?? [newDraftDocumentTab([])],
          activeDocumentTabId: snapshot?.activeDocumentTabId ?? null,
        });
      } else {
        // Do not leave the previous conversation visible while the first fetch is pending.
        set({
          activeSessionId: sessionId,
          activeProjectId: null,
          activeWorkspaceProjectId: null,
          chat: [],
          activeExecutionPolicy: { reasoning: 'auto', autopilot: 'auto', approval: 'ask', workspace_behavior: 'agent' },
          effectiveExecutionPolicy: null,
          canUndo: false,
          assets: [],
          canvasNodes: [],
          canvasEdges: [],
          documentTabs: [newDraftDocumentTab([])],
          activeDocumentTabId: null,
        });
      }
      syncViewBusy();
      queueMicrotask(() => dispatchNextQueuedMessage(sessionId));

      // Refresh from the server without blocking the visible session switch.
      void fetchSession(sessionId).then(async (rec) => {
        const messages = rec.messages ?? [];
        const membershipProjectId = rec.project_id ?? null;
        const workspaceRootProjectId = await resolveWorkspaceRootProjectId(membershipProjectId);
        const currentLive = liveJobs.get(sessionId);
        const previous = sessionViewCache.get(sessionId);
        const refreshed: SessionViewSnapshot = {
          activeProjectId: membershipProjectId,
          selectedModel: rec.preferred_model ?? readStoredPreference(MODEL_PREF_KEY, LEGACY_MODEL_PREF_KEY) ?? 'auto',
          activeWorkspaceProjectId: workspaceRootProjectId,
          chat: currentLive?.chat ?? sessionMessagesToChat(messages),
          activeExecutionPolicy: currentLive?.executionPolicy ?? rec.execution_policy ?? { reasoning: 'auto', autopilot: 'auto', approval: 'ask', workspace_behavior: 'agent' },
          effectiveExecutionPolicy: currentLive?.effectiveExecutionPolicy ?? null,
          canUndo: currentLive ? false : messages.some((m) => m.role === 'user'),
          assets: currentLive && previous
            ? previous.assets
            : [...loadSessionAssets(sessionId), ...assetsFromMessages(messages)],
          canvasNodes: previous?.canvasNodes ?? [],
          canvasEdges: previous?.canvasEdges ?? [],
          documentTabs: previous?.documentTabs ?? [newDraftDocumentTab([])],
          activeDocumentTabId: previous?.activeDocumentTabId ?? null,
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
          documentTabs: refreshed.documentTabs,
          activeDocumentTabId: refreshed.activeDocumentTabId,
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
    setDocumentContent: (content) => {
      const active = activeDocumentTab(get());
      if (!active) return;
      set({
        documentTabs: get().documentTabs.map((tab) =>
          tab.id === active.id ? { ...tab, content, dirty: true, status: null } : tab,
        ),
      });
    },
    setDocumentSelection: (selection) => {
      const active = activeDocumentTab(get());
      if (!active) return;
      set({
        documentTabs: get().documentTabs.map((tab) =>
          tab.id === active.id ? { ...tab, selection } : tab,
        ),
      });
    },
    setDocumentView: (view) => {
      const active = activeDocumentTab(get());
      if (!active) return;
      set({
        documentTabs: get().documentTabs.map((tab) =>
          tab.id === active.id ? { ...tab, view } : tab,
        ),
      });
    },
    setDocumentMemos: (memos) => {
      const active = activeDocumentTab(get());
      if (!active) return;
      set({
        documentTabs: get().documentTabs.map((tab) =>
          tab.id === active.id ? { ...tab, memos } : tab,
        ),
      });
    },
    setActiveDocumentTab: (tabId) => {
      if (!get().documentTabs.some((tab) => tab.id === tabId)) return;
      set({ activeDocumentTabId: tabId, mode: 'document' });
    },
    closeDocumentTab: async (tabId) => {
      const tabs = get().documentTabs;
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return 'cancelled';
      const tab = tabs[index];
      if (tab.dirty) {
        const choice = await choiceDialog({
          title: '문서 닫기',
          message: `"${tab.title}"에 저장되지 않은 변경이 있습니다.`,
          options: [
            { id: 'save', label: '저장 후 닫기' },
            { id: 'discard', label: '저장하지 않고 닫기', danger: true },
            { id: 'cancel', label: '취소' },
          ],
          allowBackdropDismiss: false,
        });
        if (choice === 'cancel' || choice === null) return 'cancelled';
        if (choice === 'save') {
          if (tab.source !== 'workspace' || !tab.path) {
            set({
              activeDocumentTabId: tabId,
              mode: 'document',
              documentTabs: tabs.map((item) =>
                item.id === tabId
                  ? { ...item, status: '프로젝트에 저장한 뒤 닫습니다.' }
                  : item,
              ),
            });
            return 'need-project-save';
          }
          await get().saveDocument();
          if (get().documentTabs.find((item) => item.id === tabId)?.dirty) return 'cancelled';
        }
      }
      const nextTabs = get().documentTabs.filter((item) => item.id !== tabId);
      const next = get().activeDocumentTabId === tabId
        ? nextTabs[Math.min(index, nextTabs.length - 1)] ?? null
        : nextTabs.find((item) => item.id === get().activeDocumentTabId) ?? nextTabs[0] ?? null;
      const fallback = nextTabs.length ? nextTabs : [newDraftDocumentTab([])];
      set({
        documentTabs: fallback,
        activeDocumentTabId: next?.id ?? fallback[0].id,
        mode: 'document',
      });
      return 'closed';
    },
    closeOtherDocumentTabs: async (tabId) => {
      const keep = get().documentTabs.find((tab) => tab.id === tabId);
      if (!keep) return;
      const others = get().documentTabs.filter((tab) => tab.id !== tabId);
      for (const tab of others) {
        const result = await get().closeDocumentTab(tab.id);
        if (result === 'need-project-save' || result === 'cancelled') return;
      }
      set({ activeDocumentTabId: tabId, mode: 'document' });
    },
    closeDocumentTabsToTheRight: async (tabId) => {
      const tabs = get().documentTabs;
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const right = tabs.slice(index + 1);
      for (const tab of right) {
        const result = await get().closeDocumentTab(tab.id);
        if (result === 'need-project-save' || result === 'cancelled') return;
      }
    },
    closeSavedDocumentTabs: async () => {
      const saved = get().documentTabs.filter((tab) => !tab.dirty);
      for (const tab of saved) {
        await get().closeDocumentTab(tab.id);
      }
    },
    clearComposerPrefill: () => set({ composerPrefill: null }),
    appendToDocument: (text) => {
      const chunk = String(text || '');
      if (!chunk.trim()) return;
      const active = activeDocumentTab(get());
      if (!active) return;
      const prev = active.content;
      const next = prev ? `${prev.replace(/\s+$/, '')}\n\n${chunk}` : chunk;
      set({
        documentTabs: get().documentTabs.map((tab) =>
          tab.id === active.id ? { ...tab, content: next, dirty: true, status: '문서에 추가됨' } : tab,
        ),
        mode: 'document',
      });
    },
    openDocumentPath: async (relPath, initialContent) => {
      const path = normalizeRelPath(relPath);
      if (!isAllowedDocumentPath(path) && initialContent === undefined) {
        const active = activeDocumentTab(get());
        if (active) set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: 'md/txt만 열 수 있습니다.' } : tab) });
        return;
      }
      if (initialContent !== undefined) {
        const title = documentTitleFromPath(path);
        const existing = get().documentTabs.find(
          (tab) => tab.source === 'import' && tab.title === title && tab.content === initialContent,
        );
        if (existing) {
          set({ activeDocumentTabId: existing.id, mode: 'document' });
          return;
        }
        const tab: DocumentTab = {
          id: uid('doc'),
          title,
          path: null,
          source: 'import',
          content: initialContent,
          dirty: true,
          selection: '',
          view: 'preview',
          status: '외부 파일 · 프로젝트에 저장하기 전까지 원본은 변경되지 않습니다.',
          lastDumpPath: null,
          lastDumpContent: null,
          memos: [],
          recoveryPath: null,
        };
        set({
          documentTabs: [...get().documentTabs, tab],
          activeDocumentTabId: tab.id,
          mode: 'document',
        });
        return;
      }
      if (!get().filesRoot) {
        const active = activeDocumentTab(get());
        if (active) set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: '작업 폴더를 먼저 연결하세요.' } : tab), mode: 'document' });
        return;
      }
      const existing = get().documentTabs.find(
        (tab) => tab.source === 'workspace' && tab.path?.toLowerCase() === path.toLowerCase(),
      );
      if (existing) {
        set({ activeDocumentTabId: existing.id, mode: 'document' });
        return;
      }
      try {
        const { content } = await readWorkspaceFsFile(path);
        const tab: DocumentTab = {
          id: uid('doc'),
          title: documentTitleFromPath(path),
          path,
          source: 'workspace',
          content,
          dirty: false,
          selection: '',
          view: 'preview',
          status: `프로젝트 파일 · ${path}`,
          lastDumpPath: null,
          lastDumpContent: null,
          memos: [],
          recoveryPath: null,
        };
        set({
          documentTabs: [...get().documentTabs, tab],
          activeDocumentTabId: tab.id,
          mode: 'document',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const active = activeDocumentTab(get());
        if (active) set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab), mode: 'document' });
      }
    },
    saveDocument: async () => {
      const active = activeDocumentTab(get());
      if (!active) return;
      if (active.source !== 'workspace' || !active.path) {
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: '이 문서는 프로젝트에 저장…을 사용하세요.' } : tab), mode: 'document' });
        return;
      }
      if (!get().filesRoot) {
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: '저장하려면 작업 폴더가 필요합니다.' } : tab) });
        return;
      }
      try {
        await writeWorkspaceFsFile(active.path, active.content);
        set({
          documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, dirty: false, status: `프로젝트 파일 · ${active.path}` } : tab),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab) });
      }
    },
    newDocument: async () => {
      const tab = newDraftDocumentTab(get().documentTabs);
      set({
        documentTabs: [...get().documentTabs, tab],
        activeDocumentTabId: tab.id,
        mode: 'document',
      });
    },
    saveDocumentToProject: async (relPath) => {
      const active = activeDocumentTab(get());
      if (!active) throw new Error('열린 문서가 없습니다.');
      if (!get().filesRoot) {
        const message = '프로젝트 저장에는 작업 폴더가 필요합니다.';
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab) });
        throw new Error(message);
      }
      const path = normalizeRelPath(relPath);
      if (isDocumentScratchPath(path)) {
        const message = '세션 임시 경로(.my-agent/docs)에는 프로젝트 저장할 수 없습니다. 더보기 → 세션 임시본으로 저장을 쓰세요.';
        set({
          documentTabs: get().documentTabs.map((tab) =>
            tab.id === active.id ? { ...tab, status: message } : tab,
          ),
        });
        throw new Error(message);
      }
      const conflict = get().documentTabs.find(
        (tab) =>
          tab.id !== active.id &&
          tab.source === 'workspace' &&
          tab.path?.toLowerCase() === path.toLowerCase(),
      );
      if (conflict) {
        if (conflict.dirty) {
          const message = `이미 다른 탭에서 수정 중인 파일입니다: ${path}`;
          set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab) });
          throw new Error(message);
        }
        set({
          documentTabs: get().documentTabs.filter((tab) => tab.id !== conflict.id),
        });
      }
      try {
        await writeWorkspaceFsFile(path, active.content);
        const title = documentTitleFromPath(path);
        set({
          documentTabs: get().documentTabs.map((tab) =>
            tab.id === active.id
              ? { ...tab, title, path, source: 'workspace', dirty: false, status: `프로젝트 파일 · ${path}`, recoveryPath: null }
              : tab,
          ),
          mode: 'document',
        });
        await get().refreshExplorer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab) });
        throw err;
      }
    },
    saveDocumentAs: async (relPath) => {
      await get().saveDocumentToProject(relPath);
    },
    saveDocumentScratch: async () => {
      const active = activeDocumentTab(get());
      const sessionId = get().activeSessionId;
      if (!active) throw new Error('열린 문서가 없습니다.');
      if (!get().filesRoot) throw new Error('세션 임시본 저장에는 작업 폴더가 필요합니다.');
      if (!sessionId) throw new Error('세션이 없습니다. 대화를 시작한 뒤 다시 시도하세요.');
      const recoveryPath = active.recoveryPath || documentRecoveryRelPath(sessionId, active.id);
      try {
        await writeWorkspaceFsFile(recoveryPath, active.content);
        set({
          documentTabs: get().documentTabs.map((tab) =>
            tab.id === active.id
              ? {
                  ...tab,
                  recoveryPath,
                  // Keep draft/import — scratch is not a project file.
                  status: `세션 임시본 · ${recoveryPath}`,
                }
              : tab,
          ),
          mode: 'document',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab) });
        throw err;
      }
    },
    renameDocument: async (relPath) => {
      const active = activeDocumentTab(get());
      if (!active?.path || active.source !== 'workspace') {
        throw new Error('프로젝트 파일만 이름을 바꿀 수 있습니다.');
      }
      if (!get().filesRoot) throw new Error('작업 폴더가 필요합니다.');
      const nextPath = normalizeRelPath(relPath);
      const nextName = documentTitleFromPath(nextPath);
      const { path: renamed } = await renameWorkspaceFsFile(active.path, nextName);
      const path = normalizeRelPath(renamed);
      set({
        documentTabs: get().documentTabs.map((tab) =>
          tab.id === active.id
            ? { ...tab, path, title: documentTitleFromPath(path), dirty: false, status: `이름 변경: ${path}` }
            : tab,
        ),
      });
      await get().refreshExplorer();
    },
    reloadDocumentFromDisk: async (tabId) => {
      const tab = get().documentTabs.find((item) => item.id === tabId);
      if (!tab?.path || tab.source !== 'workspace') return;
      try {
        const { content } = await readWorkspaceFsFile(tab.path);
        set({
          documentTabs: get().documentTabs.map((item) =>
            item.id === tabId
              ? { ...item, content, dirty: false, status: `디스크 버전으로 갱신: ${tab.path}` }
              : item,
          ),
          mode: 'document',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({
          documentTabs: get().documentTabs.map((item) =>
            item.id === tabId ? { ...item, status: `디스크 갱신 실패: ${message}` } : item,
          ),
        });
      }
    },
    keepDocumentLocalEdits: (tabId) => {
      set({
        documentTabs: get().documentTabs.map((item) =>
          item.id === tabId
            ? { ...item, status: '내 편집을 유지합니다. 저장하면 디스크를 덮어씁니다.' }
            : item,
        ),
      });
    },
    syncDocumentTabsFromMutations: async (paths) => {
      const docPaths = [...new Set(paths.map((p) => normalizeRelPath(p)).filter(isAiDocumentOpenPath))];
      if (!docPaths.length) return;
      let activated: string | null = null;
      for (const path of docPaths) {
        const existing = get().documentTabs.find(
          (tab) => tab.source === 'workspace' && tab.path?.toLowerCase() === path.toLowerCase(),
        );
        if (existing) {
          if (existing.dirty) {
            try {
              const before = existing.content;
              const sidDump = get().activeSessionId || 'session';
              const dumpPath = dumpRelPath(sidDump);
              if (get().filesRoot) {
                await writeWorkspaceFsFile(dumpPath, before);
              }
              set({
                documentTabs: get().documentTabs.map((tab) =>
                  tab.id === existing.id
                    ? {
                        ...tab,
                        lastDumpPath: get().filesRoot ? dumpPath : null,
                        lastDumpContent: before,
                        status: '디스크에서 변경됨 — 내 편집 유지 또는 디스크 버전 보기',
                      }
                    : tab,
                ),
              });
            } catch {
              set({
                documentTabs: get().documentTabs.map((tab) =>
                  tab.id === existing.id
                    ? { ...tab, status: '디스크에서 변경됨 — 내 편집을 덮어쓰지 않았습니다.' }
                    : tab,
                ),
              });
            }
            continue;
          }
          try {
            const { content } = await readWorkspaceFsFile(path);
            set({
              documentTabs: get().documentTabs.map((tab) =>
                tab.id === existing.id
                  ? { ...tab, content, dirty: false, status: `디스크에서 갱신: ${path}` }
                  : tab,
              ),
            });
          } catch {
            /* ignore per-path read errors */
          }
          continue;
        }
        await get().openDocumentPath(path);
        if (!activated) activated = path;
      }
      if (activated) {
        const tab = get().documentTabs.find(
          (item) => item.source === 'workspace' && item.path?.toLowerCase() === activated!.toLowerCase(),
        );
        if (tab) set({ activeDocumentTabId: tab.id, mode: 'document' });
      }
    },
    openLastDump: async () => {
      const active = activeDocumentTab(get());
      if (!active) return;
      const dumpPath = active.lastDumpPath;
      const mem = active.lastDumpContent;
      if (mem != null && !dumpPath) {
        set({
          documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, content: mem, dirty: true, status: '메모리 덤프를 열었습니다' } : tab),
        });
        return;
      }
      if (!dumpPath) {
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: '열 덤프가 없습니다.' } : tab) });
        return;
      }
      if (!get().filesRoot) {
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: '덤프를 열려면 작업 폴더가 필요합니다.' } : tab) });
        return;
      }
      try {
        const { content } = await readWorkspaceFsFile(dumpPath);
        set({
          documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, content, dirty: false, status: `덤프 열림: ${dumpPath}` } : tab),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab) });
      }
    },
    saveDocumentRecovery: async () => {
      const active = activeDocumentTab(get());
      const sessionId = get().activeSessionId;
      if (!active || !get().filesRoot || !sessionId) return;
      const recoveryPath = active.recoveryPath || documentRecoveryRelPath(sessionId, active.id);
      try {
        await writeWorkspaceFsFile(recoveryPath, active.content);
        set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, recoveryPath } : tab) });
      } catch {
        // Recovery is best effort and must never turn into a project-file save.
      }
    },
    askAiFromDocumentSelection: () => {
      const active = activeDocumentTab(get());
      if (!active) return;
      const sel = active.selection.trim();
      if (!sel) {
        if (active) set({ documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: 'Ask AI: 문서에서 텍스트를 선택하세요.' } : tab) });
        return;
      }
      const path = active.path;
      const prefill = path
        ? `문서 \`${path}\` 선택 구간에 대해:\n\n"""\n${sel}\n"""\n\n`
        : `다음 선택 구간에 대해:\n\n"""\n${sel}\n"""\n\n`;
      set({
        composerPrefill: prefill,
        composerFocusNonce: get().composerFocusNonce + 1,
        mode: 'document',
        documentTabs: get().documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: 'Ask AI: 채팅 입력에 선택 내용을 넣었습니다. 질문을 이어서 보내세요.' } : tab),
      });
    },
    flushDocumentAfterWorkspaceConnect: async () => {
      const sessionId = get().activeSessionId;
      if (!get().filesRoot || !sessionId) return;
      const tabs = get().documentTabs;
      for (const tab of tabs) {
        if (tab.source !== 'workspace') {
          const recoveryPath = tab.recoveryPath || documentRecoveryRelPath(sessionId, tab.id);
          try {
            await writeWorkspaceFsFile(recoveryPath, tab.content);
            set({ documentTabs: get().documentTabs.map((item) => item.id === tab.id ? { ...item, recoveryPath } : item) });
          } catch {
            // Best effort recovery only.
          }
        }
      }
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
      set({ mode: 'document', assets, canvasNodes: [...get().canvasNodes, node] });
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
      set({ mode: 'document', canvasNodes: [...get().canvasNodes, node] });
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

    sendAiMessage: async (text, modelOverride, opts) => {
      const trimmed = text.trim();
      const pending = get().pendingAttachments;
      const attachmentIds = pending.map((a) => a.id);
      const attachmentNames = pending.map((a) => a.name);
      if ((!trimmed && !attachmentIds.length)) return;
      const uiSurface = opts?.uiSurface === 'document-memo' ? 'document-memo' : 'chat';
      const uiHidden = uiSurface === 'document-memo';

      let sid = get().activeSessionId;
      let createdFreshSession = false;
      if (!sid) {
        sid = await createSession(get().activeProjectId);
        createdFreshSession = true;
        set({ activeSessionId: sid });
      }
      if (createdFreshSession) {
        // New session uses PC default (agent). Do not leak Plan/Ask from a cleared previous chat.
        try {
          const rec = await fetchSession(sid);
          const policy = rec.execution_policy ?? {
            reasoning: 'auto' as const,
            autopilot: 'auto' as const,
            approval: 'ask' as const,
            workspace_behavior: 'agent' as const,
          };
          set({
            activeExecutionPolicy: {
              ...policy,
              workspace_behavior: policy.workspace_behavior ?? 'agent',
            },
            effectiveExecutionPolicy: null,
          });
        } catch {
          set({
            activeExecutionPolicy: {
              reasoning: 'auto',
              autopilot: 'auto',
              approval: 'ask',
              workspace_behavior: 'agent',
            },
            effectiveExecutionPolicy: null,
          });
        }
      }
      if (liveJobs.has(sid) || get().sessionPhases[sid]) {
        const queued: QueuedMessage = {
          id: uid('queue'),
          sessionId: sid,
          text: trimmed,
          attachmentIds,
          attachmentNames,
          contextPaths: [...get().pendingContextPaths],
          model: get().selectedModel || 'auto',
          createdAt: new Date().toISOString(),
          uiSurface,
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
      const model = modelOverride || get().selectedModel || 'auto';
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
        uiHidden: uiHidden || undefined,
        attachmentNames: attachmentNames.length ? attachmentNames : undefined,
      };
      const assistantTurn: ChatTurn = {
      id: assistantId,
      role: 'assistant',
      mode: 'text',
      text: '',
      uiHidden: uiHidden || undefined,
      model,
      startedAt: new Date().toISOString(),
    };
      const chat = [...get().chat, userTurn, assistantTurn];
      const abort = new AbortController();

      for (const a of pending) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }

      const basePolicy = { ...get().activeExecutionPolicy };
      // Document sticky memos are short Q&A — never open the tool plane.
      const executionPolicy =
        uiSurface === 'document-memo'
          ? { ...basePolicy, workspace_behavior: 'ask' as const }
          : basePolicy;

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
        executionPolicy,
        effectiveExecutionPolicy: null,
        attachmentIds,
        editorPath:
          get().mode === 'document'
            ? activeDocumentTab(get())?.path || ''
            : get().activeFileId ?? '',
        editorSelection:
          get().mode === 'document'
            ? activeDocumentTab(get())?.selection || ''
            : get().activeFileId
              ? get().editorContent.slice(0, 4000)
              : '',
        contextPaths: [...get().pendingContextPaths],
        terminalUsed: false,
        uiSurface,
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

    buildFromPlan: async (assistantTurnId) => {
      const sid = get().activeSessionId;
      if (!sid || get().busy) return;
      const turn = get().chat.find((t) => t.id === assistantTurnId);
      if (!turn || turn.role !== 'assistant' || !turn.planBuildOffer || turn.planBuilt) return;

      const nextChat = get().chat.map((t) =>
        t.id === assistantTurnId ? { ...t, planBuilt: true, planBuildOffer: false } : t,
      );
      set({ chat: nextChat });
      const cached = sessionViewCache.get(sid);
      if (cached) sessionViewCache.set(sid, { ...cached, chat: nextChat });

      const priorAutopilot = get().activeExecutionPolicy.autopilot;
      await get().setExecutionPolicy({
        workspace_behavior: 'agent',
        autopilot:
          get().activeExecutionPolicy.workspace_behavior === 'plan' ||
          get().activeExecutionPolicy.workspace_behavior === 'ask'
            ? 'auto'
            : priorAutopilot,
      });

      await get().sendAiMessage(PLAN_BUILD_USER_MESSAGE);
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
