import {
  ArrowClockwise,
  CircleNotch,
  File as FileIcon,
  FilmStrip,
  Paperclip,
  Plus,
  PaperPlaneTilt,
  Browser,
  CaretDown,
  CheckCircle,
  FolderSimple,
  X,
  Image as ImageIcon,
  Stop,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { isChatTurnUiHidden } from '../lib/documentMemo';
import { useConversationDisplayPreferences } from '../lib/conversationDisplayPreferences';
import { createPortal } from 'react-dom';
import type { ChatTurn } from '../types';
import { ToolActivityLog } from './ToolActivityLog';
import { ASSET_MIME, useWorkspaceStore } from '../store/workspaceStore';
import {
  listSelectableSkills,
  fetchSession,
  fetchWorkspaceTree,
  getStoredSessionId,
  summarizeSession,
  type ApprovalLevel,
  type ReasoningLevel,
  type SkillListItem,
  type WorkspaceBehavior,
} from '../api/myAgentClient';
import {
  filesFromClipboard,
  filesFromClipboardApi,
  filesFromDataTransfer,
} from '../lib/clipboardImages';
import {
  reasoningLevelLabel,
  reasoningSelectOptionsForModel,
  modelOmitsReasoningEffort,
  normalizeReasoningLevelForModel,
} from '../lib/reasoning-levels';
import { normalizeBrowserUrl } from '../lib/browserUrl';
import { openInAppBrowser } from '../lib/inAppBrowserBridge';
import {
  copyImageToClipboard,
  copyImageUrl,
  copyText,
  downloadImageUrl,
  guessImageFilename,
} from '../lib/mediaActions';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { flattenWorkspaceFiles, QuickOpenModal } from './QuickOpenModal';
import { SessionAttachmentGallery } from './SessionAttachmentGallery';
import { MessageMarkdown } from './MessageMarkdown';
import { focusHistoryBackground, navigateHistory, tabToComposer, type HistoryCursor } from '../lib/chatHistoryNavigation';
import { useAnchoredOverlay } from '../lib/useAnchoredOverlay';

const CHAT_SCROLL_KEY_PREFIX = 'my-agent-chat-scroll:';

function readChatScrollPosition(sessionId: string): number | null {
  try {
    const value = Number(localStorage.getItem(`${CHAT_SCROLL_KEY_PREFIX}${sessionId}`));
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function writeChatScrollPosition(sessionId: string, scrollTop: number): void {
  try {
    localStorage.setItem(`${CHAT_SCROLL_KEY_PREFIX}${sessionId}`, String(Math.max(0, Math.round(scrollTop))));
  } catch {
    // Storage can be unavailable in restricted WebView contexts; keep the current view usable.
  }
}

const reasoningLabel = reasoningLevelLabel;
const approvalLabel = (value: ApprovalLevel) =>
  value === 'autopilot' ? 'Autopilot' : value === 'delegate' ? '나 대신 승인' : '승인 요청';
const workspaceBehaviorLabel = (value: WorkspaceBehavior | null | undefined) =>
  value === 'plan' ? 'Plan' : value === 'ask' ? 'Ask' : 'Agent';

function isImageAttachment(mime?: string, name?: string): boolean {
  if (mime?.startsWith('image/')) return true;
  if (!name) return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

function isVideoAttachment(mime?: string, name?: string): boolean {
  if (mime?.startsWith('video/')) return true;
  if (!name) return false;
  return /\.(mp4|webm|mov|mkv|avi|m4v|mpeg|mpg)$/i.test(name);
}

function indexedAttachmentName(name: string, ordinal: number, total: number): string {
  if (total < 2) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${name.slice(0, dot)}_${ordinal}${name.slice(dot)}`
    : `${name}_${ordinal}`;
}

function queuedMessageNeedsExpansion(text: string, attachmentNames: string[]): boolean {
  const content = text || attachmentNames.join(', ');
  return content.length > 240 || content.split(/\r?\n/).length > 3;
}

/** http(s) URLs, or bare www./amazon. hosts commonly pasted into chat. */
const EXTERNAL_URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'`）】)\]]+/gi;
const URL_TRAILING_PUNCTUATION_RE = /[.,!?;:`'"”’）】)\]>]+$/;

/** Prefer shell in-app browser; otherwise Preview「웹」pane — never navigate the workspace away. */
function openExternalUrl(rawUrl: string): boolean {
  const href = normalizeExternalHref(rawUrl);
  if (!href) return false;
  if (openInAppBrowser(href)) return true;
  const store = useWorkspaceStore.getState();
  store.setPreviewPaneOpen(true);
  store.setMode('browser');
  store.navigateBrowser(href);
  return true;
}

function normalizeExternalHref(rawUrl: string): string | null {
  const cleaned = rawUrl.trim().replace(URL_TRAILING_PUNCTUATION_RE, '');
  return normalizeBrowserUrl(cleaned);
}

function formatElapsedRuntime(elapsedMs?: number): string | null {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatClockTime(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatWorkDuration(startedAt?: string, completedAt?: string, now = Date.now()): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface MessageReference {
  id: string;
  role: ChatTurn['role'];
  text: string;
}

function renderMessageText(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(EXTERNAL_URL_RE)) {
    const rawUrl = match[0];
    const start = match.index ?? cursor;
    const cleaned = rawUrl.replace(URL_TRAILING_PUNCTUATION_RE, '');
    const url = normalizeExternalHref(cleaned);

    if (!url) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));

    parts.push(
      <a
        key={`${start}-${url}`}
        href={url}
        className="cursor-pointer break-all text-accent underline decoration-accent underline-offset-2 hover:text-accent/80"
        title="앱 안에서 열기 (셸 인앱 브라우저 또는 Preview 웹)"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openExternalUrl(url);
        }}
      >
        {url}
      </a>,
    );

    const trailing = rawUrl.slice(cleaned.length);
    if (trailing) parts.push(trailing);
    cursor = start + rawUrl.length;
  }

  if (cursor === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function PolicyChoices({ testId, label, value, options, disabled, onSelect }: {
  testId: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string; description?: string }>;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  return <div role="menu" aria-label={label} data-testid={testId} className="chat-policy-choices"
    onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    {options.map((option) => <button key={option.value} type="button" role="menuitemradio"
      aria-checked={option.value === value} aria-label={option.label} disabled={disabled}
      data-value={option.value} tabIndex={option.value === value ? 0 : -1}
      className="chat-policy-choice" onClick={() => onSelect(option.value)}>
      <span className="chat-policy-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
      <span><span className="block font-semibold">{option.label}</span>
        {option.description ? <span className="mt-0.5 block text-[11px] leading-5 text-muted">{option.description}</span> : null}
      </span>
    </button>)}
  </div>;
}

function LiveDuration({ startedAt, completedAt, live = false }: { startedAt?: string; completedAt?: string; live?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live || completedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, completedAt]);
  return <>{formatWorkDuration(startedAt, completedAt, now) ?? '00:00'}</>;
}

const copyMarkdownText = async (text: string) => { await navigator.clipboard.writeText(text); return true; };

export function ChatPane() {
  const chat = useWorkspaceStore((s) => s.chat);
  const busy = useWorkspaceStore((s) => s.busy);
  const statusText = useWorkspaceStore((s) => s.statusText);
  const progressSteps = useMemo(() => {
    const activeAssistant = [...chat].reverse().find((turn) => turn.role === 'assistant');
    return activeAssistant?.progressSteps?.length
      ? activeAssistant.progressSteps
      : statusText
        ? [statusText]
        : [];
  }, [chat, statusText]);
  const contextBudget = useWorkspaceStore((s) => s.contextBudget);
  const openGateText = useWorkspaceStore((s) => s.openGateText);
  const sendAiMessage = useWorkspaceStore((s) => s.sendAiMessage);
  const messageQueue = useWorkspaceStore((s) => s.messageQueue);
  const queueReviewSessions = useWorkspaceStore((s) => s.queueReviewSessions);
  const updateQueuedMessage = useWorkspaceStore((s) => s.updateQueuedMessage);
  const removeQueuedMessage = useWorkspaceStore((s) => s.removeQueuedMessage);
  const continueQueuedMessages = useWorkspaceStore((s) => s.continueQueuedMessages);
  const stopAiMessage = useWorkspaceStore((s) => s.stopAiMessage);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const composerSessionPromotionId = useWorkspaceStore((s) => s.composerSessionPromotionId);
  const activeQueue = messageQueue.filter((item) => item.sessionId === activeSessionId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeWorkspaceProjectId = useWorkspaceStore((s) => s.activeWorkspaceProjectId);
  const setSessionWorkspaceProject = useWorkspaceStore((s) => s.setSessionWorkspaceProject);
  const setSessionProject = useWorkspaceStore((s) => s.setSessionProject);
  const selectedModel = useWorkspaceStore((s) => s.selectedModel);
  const setSelectedModel = useWorkspaceStore((s) => s.setSelectedModel);
  const modelOptions = useWorkspaceStore((s) => s.modelOptions);
  const selectedReasoningCapability = useMemo(
    () => modelOptions.find((option) => option.id === selectedModel)?.reasoning_capability,
    [modelOptions, selectedModel],
  );
  const refreshModelPicker = useWorkspaceStore((s) => s.refreshModelPicker);
  const activeExecutionPolicy = useWorkspaceStore((s) => s.activeExecutionPolicy);
  const effectiveExecutionPolicy = useWorkspaceStore((s) => s.effectiveExecutionPolicy);
  const setExecutionPolicy = useWorkspaceStore((s) => s.setExecutionPolicy);
  const apiError = useWorkspaceStore((s) => s.apiError);
  const setApiStatus = useWorkspaceStore((s) => s.setApiStatus);
  const pendingAttachments = useWorkspaceStore((s) => s.pendingAttachments);
  const removePendingAttachment = useWorkspaceStore((s) => s.removePendingAttachment);
  const pendingContextPaths = useWorkspaceStore((s) => s.pendingContextPaths);
  const addContextPath = useWorkspaceStore((s) => s.addContextPath);
  const removeContextPath = useWorkspaceStore((s) => s.removeContextPath);
  const previewPaneOpen = useWorkspaceStore((s) => s.previewPaneOpen);
  const setPreviewPaneOpen = useWorkspaceStore((s) => s.setPreviewPaneOpen);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const files = useWorkspaceStore((s) => s.files);
  const uploadFiles = useWorkspaceStore((s) => s.uploadFiles);
  const acceptExternalFileDrop = useWorkspaceStore((s) => s.acceptExternalFileDrop);
  const rejectExternalFileDrop = useWorkspaceStore((s) => s.rejectExternalFileDrop);
  const adoptExternalFileDrop = useWorkspaceStore((s) => s.adoptExternalFileDrop);
  const attachAssetToComposer = useWorkspaceStore((s) => s.attachAssetToComposer);
  const skillMode = useWorkspaceStore((s) => s.skillMode);
  const skillLabel = useWorkspaceStore((s) => s.skillLabel);
  const setSkillMode = useWorkspaceStore((s) => s.setSkillMode);
  const loadChatSession = useWorkspaceStore((s) => s.loadChatSession);
  const clearActiveChat = useWorkspaceStore((s) => s.clearActiveChat);
  const openImagePreview = useWorkspaceStore((s) => s.openImagePreview);
  const [draft, setDraft] = useState('');
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<string>>(() => new Set());
  // 세션별 입력 초안 분리: 미전송 초안이 다른 채팅으로 전환할 때 따라가지 않도록
  // 세션 id별로 보관하고, 전환 시 해당 세션의 초안을 복원한다.
  const draftsBySessionRef = useRef<Map<string, string>>(new Map());
  const draftSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = draftSessionRef.current;
    const next = activeSessionId ?? null;
    if (prev === next) {
      // 같은 세션 내 입력 변화는 계속 동기화 (전송으로 비워진 경우 포함)
      if (next) draftsBySessionRef.current.set(next, draft);
      return;
    }
    if (prev) draftsBySessionRef.current.set(prev, draft);
    draftSessionRef.current = next;
    if (prev === null && next && next === composerSessionPromotionId) {
      draftsBySessionRef.current.set(next, draft);
      return;
    }
    setDraft(next ? draftsBySessionRef.current.get(next) ?? '' : '');
  }, [activeSessionId, composerSessionPromotionId, draft]);
  const composerPrefill = useWorkspaceStore((s) => s.composerPrefill);
  const composerFocusNonce = useWorkspaceStore((s) => s.composerFocusNonce);
  const clearComposerPrefill = useWorkspaceStore((s) => s.clearComposerPrefill);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeDraftInput = useCallback(() => {
    const input = draftInputRef.current;
    if (!input) return;
    input.style.height = '0px';
    const nextHeight = Math.min(240, Math.max(56, input.scrollHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > 240 ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(() => resizeDraftInput(), [draft, resizeDraftInput]);
  useEffect(() => {
    const input = draftInputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resizeDraftInput);
    observer.observe(input);
    return () => observer.disconnect();
  }, [resizeDraftInput]);
  useEffect(() => {
    if (!composerFocusNonce || composerPrefill == null) return;
    setDraft((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${composerPrefill}` : composerPrefill));
    clearComposerPrefill();
    window.setTimeout(() => draftInputRef.current?.focus(), 0);
  }, [composerFocusNonce, composerPrefill, clearComposerPrefill]);
  const [messageReferences, setMessageReferences] = useState<MessageReference[]>([]);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyTarget, setPolicyTarget] = useState('chat-workspace-behavior');
  const policyId = useId();
  const policyRef = useRef<HTMLDivElement>(null);
  const policyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedModelLabel = modelOptions.find((model) => model.id === selectedModel)?.label
    ?? (selectedModel || '모델 없음');
  const closeModelPicker = (restoreFocus = true) => {
    setModelPickerOpen(false);
    if (restoreFocus) modelPickerTriggerRef.current?.focus();
  };
  useAnchoredOverlay({
    open: modelPickerOpen,
    anchorRef: modelPickerTriggerRef,
    overlayRef: modelPickerRef,
    maxHeight: 360,
  });
  useEffect(() => {
    if (!modelPickerOpen) return;
    const panel = modelPickerRef.current;
    const focusFrame = requestAnimationFrame(() => {
      const selected = panel?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]');
      (selected ?? panel?.querySelector<HTMLButtonElement>('[role="option"]') ?? panel)?.focus();
      selected?.scrollIntoView({ block: 'nearest' });
    });
    const dismissOutside = (event: Event) => {
      const node = event.target as Node;
      if (!panel?.contains(node) && !modelPickerTriggerRef.current?.contains(node)) setModelPickerOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeModelPicker();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [modelPickerOpen]);
  const chooseModel = (model: string) => {
    if (busy) return;
    void setSelectedModel(model);
    closeModelPicker();
  };
  const [policySaving, setPolicySaving] = useState(false);
  const policySavingRef = useRef(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const policyEpochRef = useRef(0);
  const openPolicy = (event: ReactMouseEvent<HTMLButtonElement>, target: string) => {
    const sameTrigger = policyTriggerRef.current === event.currentTarget;
    policyTriggerRef.current = event.currentTarget;
    policyEpochRef.current += 1;
    setPolicyError(null);
    setModelPickerOpen(false);
    setPolicyTarget(target);
    setPolicyOpen((open) => !open || !sameTrigger);
  };
  const closePolicy = () => {
    policyEpochRef.current += 1;
    setPolicyOpen(false);
    policyTriggerRef.current?.focus();
  };
  const savePolicy = async (patch: Parameters<typeof setExecutionPolicy>[0]) => {
    if (busy || policySavingRef.current) return;
    const epoch = policyEpochRef.current;
    const previous = useWorkspaceStore.getState().activeExecutionPolicy;
    const session = useWorkspaceStore.getState().activeSessionId;
    policySavingRef.current = true;
    setPolicySaving(true);
    setPolicyError(null);
    try {
      await setExecutionPolicy(patch);
      if (epoch === policyEpochRef.current) closePolicy();
    } catch (error) {
      // The store updates optimistically. Do not leave an unsaved value looking applied.
      const current = useWorkspaceStore.getState();
      if (current.activeSessionId === session || session === null && epoch === policyEpochRef.current) {
        if (Object.entries(patch).every(([key, value]) => current.activeExecutionPolicy[key as keyof typeof patch] === value)) {
          const restored = Object.fromEntries(Object.keys(patch).map((key) => [key, previous[key as keyof typeof previous]]));
          useWorkspaceStore.setState({ activeExecutionPolicy: { ...current.activeExecutionPolicy, ...restored } });
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (epoch === policyEpochRef.current) setPolicyError(`저장하지 못했습니다. ${message}`);
      else flashPasteHint(`설정 저장 실패: ${message}`);
    } finally {
      policySavingRef.current = false;
      setPolicySaving(false);
    }
  };
  useAnchoredOverlay({
    open: policyOpen,
    anchorRef: policyTriggerRef,
    overlayRef: policyRef,
    maxHeight: 260,
  });
  useEffect(() => {
    if (!policyOpen) return;
    const panel = policyRef.current;
    const focusFrame = requestAnimationFrame(() => {
      const target = panel?.querySelector<HTMLButtonElement | HTMLSelectElement>('button[aria-checked="true"]:not(:disabled), select:not(:disabled)')
        ?? panel?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)');
      (target && !target.disabled ? target : panel)?.focus();
    });
    const dismissOutside = (event: Event) => {
      const node = event.target as Node;
      if (!panel?.contains(node) && !policyTriggerRef.current?.contains(node)) {
        policyEpochRef.current += 1;
        setPolicyOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      policyEpochRef.current += 1;
      setPolicyOpen(false);
      policyTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [policyOpen, policyTarget]);
  useEffect(() => {
    if (!policyOpen || policySaving) return;
    const panel = policyRef.current;
    if (document.activeElement === document.body || document.activeElement === panel) {
      panel?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)')?.focus();
    }
  }, [policyOpen, policySaving, policyError]);
  const policySessionRef = useRef(activeSessionId);
  useEffect(() => {
    const previous = policySessionRef.current;
    policySessionRef.current = activeSessionId;
    // A first save creates the session; keep its pending/error UI visible.
    if (previous === null && policySavingRef.current) return;
    policyEpochRef.current += 1;
    setPolicyOpen(false);
  }, [activeSessionId]);
  const [dragActive, setDragActive] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const skillButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!skillPickerOpen) return;
    const panel = skillPickerRef.current;
    (panel?.querySelector<HTMLButtonElement>('button') ?? panel)?.focus();
    const dismissOutside = (event: Event) => {
      const node = event.target as Node;
      if (!panel?.contains(node) && !skillButtonRef.current?.contains(node)) setSkillPickerOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setSkillPickerOpen(false);
      skillButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [skillPickerOpen]);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const conversationDisplay = useConversationDisplayPreferences();
  const [selectableSkills, setSelectableSkills] = useState<SkillListItem[]>([]);
  const [staleSkillNotice, setStaleSkillNotice] = useState<string | null>(null);
  const [workspaceOptions, setWorkspaceOptions] = useState<Array<{ id: string; title: string; path: string }>>([]);
  const [projectOptions, setProjectOptions] = useState<Array<{ id: string; title: string }>>([]);
  const [workspaceTreeProjectIds, setWorkspaceTreeProjectIds] = useState<string[]>([]);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspacePromptText, setWorkspacePromptText] = useState<string | null>(null);
  const contextFiles = useMemo(
    () => flattenWorkspaceFiles(files, { includeFolders: true }),
    [files],
  );
  const byokModels = useMemo(
    () => modelOptions.filter((model) => model.access_mode === 'byok'),
    [modelOptions],
  );
  const managedModels = useMemo(() => {
    const explicit = modelOptions.filter(
      (model) => model.access_mode !== 'byok' && model.access_mode !== 'auto' && model.id !== 'auto',
    );
    return explicit.length
      ? explicit
      : modelOptions.filter((model) => model.access_mode !== 'byok');
  }, [modelOptions]);
  const pickerModels = useMemo(
    () => [...managedModels, ...byokModels],
    [managedModels, byokModels],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceTree()
      .then((tree) => {
        if (cancelled) return;
        const scopedIds: string[] = [];
        const collectIds = (node: (typeof tree.workspace_trees)[number]) => {
          scopedIds.push(node.id);
          for (const child of node.children ?? []) collectIds(child);
        };
        for (const node of tree.workspace_trees ?? []) collectIds(node);
        setWorkspaceTreeProjectIds(scopedIds);
        setWorkspaceOptions(
          (tree.workspace_trees ?? [])
            .filter((node) => node.kind === 'workspace_root' && node.folder_path)
            .map((node) => ({ id: node.id, title: node.title, path: node.folder_path || node.title })),
        );
        setProjectOptions(
          (tree.projects ?? [])
            .filter((project) => project.kind === 'project' || !project.kind)
            .map((project) => ({ id: project.id, title: project.title })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceOptions([]);
          setProjectOptions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    const refreshSkills = () => {
      void listSelectableSkills().then((skills) => {
        if (cancelled) return;
        setSelectableSkills(skills);
        if (skillMode && /^(?:user|org):/.test(skillMode) && !skills.some((skill) => skill.mode === skillMode)) {
          setStaleSkillNotice(`「${skillLabel ?? skillMode}」 스킬이 제거되었거나 사용할 수 없어 해제했습니다.`);
          setSkillMode(null);
        }
      }).catch(() => {
        // Keep the last known list on transient API failures; do not invalidate an active skill.
      });
    };
    refreshSkills();
    const onFocus = () => refreshSkills();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [skillPickerOpen, skillMode, skillLabel, setSkillMode]);

  useEffect(() => {
    setMessageReferences([]);
  }, [activeSessionId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const historyCursorRef = useRef<HistoryCursor | null>(null);
  useEffect(() => { historyCursorRef.current = null; }, [activeSessionId]);
  const historyFocusNonce = useWorkspaceStore((s) => s.historyFocusNonce);
  // After a session loads (including re-selecting the same one), move keyboard focus onto
  // the conversation history on the next frame so arrow/Page keys work and Tab reaches the composer.
  useEffect(() => {
    if (!historyFocusNonce) return;
    const frame = window.requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [historyFocusNonce]);
  const openedSessionRef = useRef<string | null>(null);
  const turnAnchorRefs = useRef<Map<string, HTMLElement>>(new Map());
  const wasBusyRef = useRef(false);
  const chatPaneRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const workspacePromptBypassRef = useRef<string | null>(null);
  const { menu, openAt, close } = useContextMenu();

  const visibleChat = useMemo(() => chat.filter((turn) => !isChatTurnUiHidden(turn, chat)), [chat]);
  const modelLabels = useMemo(() => new Map(modelOptions.map((option) => [option.id, option.label])), [modelOptions]);
  const hasChatTurns = visibleChat.length > 0;
  const latestUserTurnId = [...visibleChat].reverse().find((t) => t.role === 'user')?.id ?? null;
  const latestAssistantTurnId =
    [...visibleChat].reverse().find((t) => t.role === 'assistant')?.id ?? null;

  const pinTurnNearTop = useCallback((turnId: string | null) => {
    if (!turnId) return;
    const scroller = scrollRef.current;
    const anchor = turnAnchorRefs.current.get(turnId);
    if (!scroller || !anchor) return;
    // Place the turn just under the top of the viewport (Cursor-style), not at absolute bottom.
    const top = anchor.offsetTop - 12;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, []);

  // Restore each conversation to the position last viewed on this PC. A conversation
  // without saved state still opens at its latest turn, preserving the first-open behavior.
  useLayoutEffect(() => {
    if (!activeSessionId || chat.length === 0 || openedSessionRef.current === activeSessionId) return;
    openedSessionRef.current = activeSessionId;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const savedPosition = readChatScrollPosition(activeSessionId);
    const restore = () => {
      scroller.scrollTop = savedPosition ?? scroller.scrollHeight;
    };
    restore();
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, chat.length]);

  useEffect(() => {
    const sessionId = activeSessionId;
    const scroller = scrollRef.current;
    // An empty, newly-created conversation has no meaningful viewport yet. Persisting
    // scrollTop=0 here would make its first populated view look like a restored session.
    if (!sessionId || !scroller || !hasChatTurns) return;
    const remember = () => writeChatScrollPosition(sessionId, scroller.scrollTop);
    scroller.addEventListener('scroll', remember, { passive: true });
    window.addEventListener('beforeunload', remember);
    return () => {
      // On a session switch React runs this cleanup after the shared scroller has
      // rendered the next conversation. Reading scrollTop here would therefore
      // overwrite the previous conversation with the next one's initial position.
      // User scroll events and beforeunload already persist the latest valid value.
      scroller.removeEventListener('scroll', remember);
      window.removeEventListener('beforeunload', remember);
    };
  }, [activeSessionId, hasChatTurns]);

  const flashPasteHint = useCallback((msg: string) => {
    setPasteHint(msg);
    window.setTimeout(() => setPasteHint(null), 3500);
  }, []);

  const openSessionMenu = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-chat-bubble="true"]')) return;

    const runSessionAction = async (action: () => Promise<void>) => {
      if (sessionActionBusy) return;
      setSessionActionBusy(true);
      try {
        await action();
      } catch (error) {
        flashPasteHint(error instanceof Error ? error.message : '세션 작업에 실패했습니다.');
      } finally {
        setSessionActionBusy(false);
      }
    };

    const workspaceChildren: ContextMenuItem[] = workspaceOptions.map((workspace) => ({
      id: `workspace-${workspace.id}`,
      label: workspace.title,
      disabled: workspace.id === activeWorkspaceProjectId,
      onSelect: () => runSessionAction(async () => {
        await setSessionProject(workspace.id);
        await setSessionWorkspaceProject(workspace.id);
        window.dispatchEvent(new Event('cqr:workspace-tree-changed'));
        flashPasteHint(`대화를 작업폴더 “${workspace.title}”로 이전했습니다.`);
      }),
    }));
    const projectChildren: ContextMenuItem[] = projectOptions.map((project) => ({
      id: `project-${project.id}`,
      label: project.title,
      disabled: project.id === activeProjectId,
      onSelect: () => runSessionAction(async () => {
        await setSessionWorkspaceProject(null);
        await setSessionProject(project.id);
        window.dispatchEvent(new Event('cqr:workspace-tree-changed'));
        flashPasteHint(`대화를 프로젝트 “${project.title}”로 이전했습니다.`);
      }),
    }));

    openAt(e, [
      {
        id: 'summarize-new-chat',
        label: '내용 요약 후 새대화로 열기',
        disabled: !activeSessionId || !chat.length || busy || sessionActionBusy,
        onSelect: () => runSessionAction(async () => {
          const result = await summarizeSession(activeSessionId!, { createSession: true, model: selectedModel });
          if (!result.session_id) throw new Error('요약 세션을 만들지 못했습니다.');
          await loadChatSession(result.session_id);
          flashPasteHint('대화 내용을 압축해 새 대화로 열었습니다.');
        }),
      },
      {
        id: 'move-workspace',
        label: '작업폴더로 대화 이전',
        disabled: !activeSessionId || !workspaceChildren.length || busy || sessionActionBusy,
        children: workspaceChildren,
      },
      {
        id: 'move-project',
        label: '프로젝트로 대화 이전',
        disabled: !activeSessionId || !projectChildren.length || busy || sessionActionBusy,
        children: projectChildren,
      },
      {
        id: 'copy-summary',
        label: '요약해서 복사하기',
        disabled: !activeSessionId || !chat.length || busy || sessionActionBusy,
        onSelect: () => runSessionAction(async () => {
          const result = await summarizeSession(activeSessionId!, { model: selectedModel });
          await copyText(result.summary);
          flashPasteHint('대화 요약을 클립보드에 복사했습니다.');
        }),
      },
      {
        id: 'export-session',
        label: '대화 세션 출력',
        disabled: !activeSessionId || busy || sessionActionBusy,
        onSelect: () => runSessionAction(async () => {
          const session = await fetchSession(activeSessionId!);
          const payload = {
            format: 'cqr-pa-conversation-session',
            version: 1,
            exported_at: new Date().toISOString(),
            conversation: {
              id: session.id,
              title: session.title,
              created_at: session.created_at,
              updated_at: session.updated_at,
              project_id: session.project_id ?? null,
              workspace_project_id: session.workspace_project_id ?? null,
              messages: session.messages.map((message) => ({
                role: message.role,
                content: message.content,
                at: message.at,
                ...(message.model ? { model: message.model } : {}),
                ...(message.mode ? { mode: message.mode } : {}),
                ...(message.image_urls?.length ? { image_urls: message.image_urls } : {}),
              })),
            },
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${session.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'conversation'}.cqr-session.json`;
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 0);
          flashPasteHint('호환 가능한 JSON 세션 파일로 출력했습니다.');
        }),
      },
    ]);
  };

  const openMessageMenu = useCallback(
    (e: ReactMouseEvent, turn: ChatTurn) => {
      const items: ContextMenuItem[] = [
        {
          id: 'copy-text',
          label: '메시지 복사',
          disabled: !turn.text?.trim(),
          onSelect: async () => {
            await copyText(turn.text || '');
            flashPasteHint('메시지를 복사했습니다.');
          },
        },
        {
          id: 'reference-message',
          label: '챗에 참조로 추가',
          disabled: !turn.text?.trim(),
          onSelect: () => {
            const text = turn.text.trim();
            setMessageReferences((current) =>
              current.some((item) => item.id === turn.id)
                ? current
                : [...current, { id: turn.id, role: turn.role, text }],
            );
            flashPasteHint('메시지를 챗 참조에 추가했습니다.');
          },
        },
        {
          id: 'append-to-document',
          label: '문서에 추가',
          disabled: !turn.text?.trim(),
          onSelect: () => {
            useWorkspaceStore.getState().appendToDocument(turn.text.trim());
            flashPasteHint('문서에 추가했습니다.');
          },
        },
      ];
      if (turn.imageUrls?.length) {
        const first = turn.imageUrls[0];
        items.push(
          {
            id: 'preview',
            label: '이미지 크게 보기',
            onSelect: () =>
              openImagePreview({
                src: first,
                title: turn.text?.slice(0, 48) || '생성 이미지',
                prompt: turn.text || '',
              }),
          },
          {
            id: 'copy-url',
            label: '이미지 주소 복사',
            onSelect: async () => {
              await copyImageUrl(first);
              flashPasteHint('이미지 주소를 복사했습니다.');
            },
          },
        );
      }
      openAt(e, items);
    },
    [flashPasteHint, openAt, openImagePreview],
  );

  const openImageMenu = useCallback(
    (e: ReactMouseEvent, url: string, title: string, prompt: string) => {
      openAt(e, [
        {
          id: 'preview',
          label: '크게 보기',
          onSelect: () => openImagePreview({ src: url, title, prompt }),
        },
        {
          id: 'copy-url',
          label: '이미지 주소 복사',
          onSelect: async () => {
            await copyImageUrl(url);
            flashPasteHint('이미지 주소를 복사했습니다.');
          },
        },
        {
          id: 'copy-image',
          label: '이미지 복사',
          onSelect: async () => {
            const kind = await copyImageToClipboard(url);
            flashPasteHint(kind === 'image' ? '이미지를 복사했습니다.' : '이미지 주소를 복사했습니다.');
          },
        },
        {
          id: 'save',
          label: '이미지 저장',
          onSelect: () => downloadImageUrl(url, guessImageFilename(title, url)),
        },
      ]);
    },
    [flashPasteHint, openAt, openImagePreview],
  );

  // On answer start: jump to the new turn / thinking log (near top), never chase absolute bottom.
  // Streaming updates no longer force-scroll, so a scrolled-up view stays put.
  useEffect(() => {
    const started = busy && !wasBusyRef.current;
    wasBusyRef.current = busy;
    if (!started) return;
    const pinId = latestUserTurnId ?? latestAssistantTurnId;
    // Wait a frame so the new DOM nodes exist.
    const raf = window.requestAnimationFrame(() => pinTurnNearTop(pinId));
    return () => window.cancelAnimationFrame(raf);
  }, [busy, latestAssistantTurnId, latestUserTurnId, pinTurnNearTop]);

  useEffect(() => {
    let cancelled = false;

    const applyPicker = async () => {
      setPickerBusy(true);
      try {
        await refreshModelPicker(false);
      } catch {
        /* keep fallback auto option */
      } finally {
        if (!cancelled) setPickerBusy(false);
      }
    };

    (async () => {
      setApiStatus(true, null);
      void applyPicker();

      try {
        const existing = getStoredSessionId();
        if (existing) {
          await loadChatSession(existing);
        }
        // No auto-create: empty state is valid; send / 「새 채팅」이 세션을 만듦.
      } catch {
        if (cancelled) return;
        clearActiveChat();
      }
    })();

    const onFocus = () => {
      if (useWorkspaceStore.getState().modelOptions.length <= 1) {
        void applyPicker();
      }
    };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [clearActiveChat, loadChatSession, refreshModelPicker, setApiStatus]);

  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setPasting(true);
      try {
        await uploadFiles(files);
      } catch (err) {
        flashPasteHint(err instanceof Error ? err.message : String(err));
      } finally {
        setPasting(false);
      }
    },
    [flashPasteHint, uploadFiles],
  );

  const handlePaste = useCallback(
    (e: ReactClipboardEvent | ClipboardEvent) => {
      const anyFiles = filesFromDataTransfer(e.clipboardData);

      // Explorer / OS file paste — any format
      if (anyFiles.length) {
        e.preventDefault();
        e.stopPropagation();
        void ingestFiles(anyFiles);
        return;
      }

      const syncImages = filesFromClipboard(e.clipboardData);
      if (syncImages.length) {
        e.preventDefault();
        e.stopPropagation();
        void ingestFiles(syncImages);
        return;
      }

      const items = [...(e.clipboardData?.items ?? [])];
      const maybeImage = items.some(
        (i) => i.type.startsWith('image/') || (i.kind === 'file' && !i.type),
      );
      if (!maybeImage) return;

      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        try {
          if (!navigator.clipboard?.read) {
            flashPasteHint('클립보드 이미지를 못 읽었습니다');
            return;
          }
          const images = await filesFromClipboardApi();
          if (!images.length) {
            flashPasteHint('다시 캡처해 주세요');
            return;
          }
          await ingestFiles(images);
        } catch (err) {
          flashPasteHint(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [flashPasteHint, ingestFiles],
  );

  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      const t = e.target as Node | null;
      if (!composerRef.current?.contains(t)) return;
      handlePaste(e);
    };
    document.addEventListener('paste', onDocPaste, true);
    return () => document.removeEventListener('paste', onDocPaste, true);
  }, [handlePaste]);

  const onComposerDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;
    const types = [...dataTransfer.types];
    if (!types.includes('Files') && !types.includes(ASSET_MIME)) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  const onComposerDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  const onComposerDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;
    const types = [...dataTransfer.types];
    if (types.includes('Files') || types.includes(ASSET_MIME)) {
      dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onComposerDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragActive(false);
      const dataTransfer = e.dataTransfer;
      if (!dataTransfer) {
        flashPasteHint('드롭 데이터를 읽지 못했습니다. 다시 놓거나 첨부 버튼을 사용해 주세요.');
        return;
      }
      // Internal workspace result dragged from the result gallery.
      const assetId = dataTransfer.getData(ASSET_MIME);
      if (assetId) {
        void attachAssetToComposer(assetId);
        return;
      }
      const files = filesFromDataTransfer(dataTransfer);
      if (!files.length) {
        flashPasteHint('드롭한 파일을 읽지 못했습니다. 다시 놓거나 첨부 버튼을 사용해 주세요.');
        return;
      }
      void ingestFiles(files);
    },
    [attachAssetToComposer, flashPasteHint, ingestFiles],
  );

  // Browser tests and internal workspace drags arrive as DOM File objects here.
  // Installed-app Explorer drops use the shell bridge below because CompositionControl
  // does not expose OLE files consistently across WebView2 runtime versions.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.addEventListener('dragenter', onComposerDragEnter, true);
    composer.addEventListener('dragleave', onComposerDragLeave, true);
    composer.addEventListener('dragover', onComposerDragOver, true);
    composer.addEventListener('drop', onComposerDrop, true);
    return () => {
      composer.removeEventListener('dragenter', onComposerDragEnter, true);
      composer.removeEventListener('dragleave', onComposerDragLeave, true);
      composer.removeEventListener('dragover', onComposerDragOver, true);
      composer.removeEventListener('drop', onComposerDrop, true);
    };
  }, [onComposerDragEnter, onComposerDragLeave, onComposerDragOver, onComposerDrop]);

  useEffect(() => {
    const webview = (window as unknown as {
      chrome?: { webview?: {
        addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
        removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
      } };
    }).chrome?.webview;
    if (!webview) return;
    const onMessage = (event: { data: unknown }) => {
      const message = event.data as {
        type?: string;
        phase?: string;
        requestId?: string;
        xRatio?: number;
        yRatio?: number;
        detail?: { sessionId?: string; message?: string; attachments?: Array<{ id?: string; name?: string; mime?: string }> };
      };
      if (message?.type !== 'composer.externalDrop') return;
      const pointTargetsComposer = () => {
        const composer = composerRef.current;
        if (!composer || typeof message.xRatio !== 'number' || typeof message.yRatio !== 'number') return true;
        const x = message.xRatio * window.innerWidth;
        const y = message.yRatio * window.innerHeight;
        const bounds = composer.getBoundingClientRect();
        return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      };
      if (message.phase === 'dragging') {
        setDragActive(pointTargetsComposer());
        return;
      }
      if (message.phase === 'idle') {
        setDragActive(false);
        return;
      }
      if (message.phase === 'request' && message.requestId) {
        setDragActive(false);
        if (!pointTargetsComposer()) {
          rejectExternalFileDrop(message.requestId);
          return;
        }
        setPasting(true);
        void acceptExternalFileDrop(message.requestId).catch((error) => {
          rejectExternalFileDrop(message.requestId!);
          setPasting(false);
          flashPasteHint(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (message.phase === 'completed' && message.detail?.sessionId) {
        const uploaded = (message.detail.attachments ?? []).flatMap((item) =>
          item.id ? [{ id: item.id, name: item.name ?? 'file', mime: item.mime }] : []);
        adoptExternalFileDrop(message.detail.sessionId, uploaded);
        setPasting(false);
        return;
      }
      if (message.phase === 'failed') {
        setDragActive(false);
        setPasting(false);
        flashPasteHint(message.detail?.message || '드롭한 파일을 업로드하지 못했습니다.');
      }
    };
    webview.addEventListener('message', onMessage);
    return () => webview.removeEventListener('message', onMessage);
  }, [acceptExternalFileDrop, adoptExternalFileDrop, flashPasteHint, rejectExternalFileDrop]);

  const attachDisabled = pasting;

  const attachmentDisplayNames = useMemo(() => {
    const totals = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const attachment of pendingAttachments) {
      totals.set(attachment.name, (totals.get(attachment.name) ?? 0) + 1);
    }
    return pendingAttachments.map((attachment) => {
      const ordinal = (seen.get(attachment.name) ?? 0) + 1;
      seen.set(attachment.name, ordinal);
      return indexedAttachmentName(attachment.name, ordinal, totals.get(attachment.name) ?? 1);
    });
  }, [pendingAttachments]);

  const canSend = (!!draft.trim() || pendingAttachments.length > 0 || messageReferences.length > 0) && !pasting;

  const submit = () => {
    if (!canSend) return;
    const referenceContext = messageReferences
      .map((reference, index) =>
        `[참조 메시지 ${index + 1} · ${reference.role === 'user' ? '사용자' : '모델'}]\n${reference.text}`,
      )
      .join('\n\n');
    const t = [referenceContext, draft.trim()].filter(Boolean).join('\n\n');
    const promptKey = activeSessionId ?? (activeProjectId ? `project:${activeProjectId}` : null);
    const projectInWorkspaceTree = Boolean(
      activeProjectId && workspaceTreeProjectIds.includes(activeProjectId),
    );
    if (
      promptKey
      && activeProjectId
      && !activeWorkspaceProjectId
      && !projectInWorkspaceTree
      && workspaceOptions.length > 0
      && workspacePromptBypassRef.current !== promptKey
    ) {
      setWorkspacePromptText(t);
      return;
    }
    setDraft('');
    setMessageReferences([]);
    void sendAiMessage(t);
  };

  return (
    <section
      ref={chatPaneRef}
      className="relative flex h-full flex-col bg-ink"
    >
      <SessionAttachmentGallery key={activeSessionId ?? 'none'} sessionId={activeSessionId}
        onOpen={(url, name) => openImagePreview({ src: url, title: name, prompt: '' })}
        onMenu={(e, url, name) => openImageMenu(e, url, name, '')} />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void ingestFiles(files);
        }}
      />
      {workspacePromptText !== null ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/35 px-6 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="작업폴더 권한 연결"
            data-testid="workspace-access-dialog"
            className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl"
          >
            <p className="text-base font-semibold text-text">이 채팅에 작업폴더를 연결할까요?</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              파일을 읽거나 수정하려면 등록된 작업폴더를 이 채팅에 명시적으로 연결해야 합니다.
              선택한 권한은 다른 채팅에 적용되지 않습니다.
            </p>
            <div className="mt-4 space-y-2">
              {workspaceOptions.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={workspaceSaving}
                  onClick={() => {
                    const pendingText = workspacePromptText;
                    setWorkspaceSaving(true);
                    void setSessionWorkspaceProject(workspace.id)
                      .then(() => {
                        setWorkspacePromptText(null);
                        setDraft('');
                        void sendAiMessage(pendingText);
                      })
                      .catch((error) => flashPasteHint(error instanceof Error ? error.message : String(error)))
                      .finally(() => setWorkspaceSaving(false));
                  }}
                  className="w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 text-left text-sm text-text hover:border-accent/60 disabled:opacity-50"
                >
                  <span className="block font-medium">{workspace.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">{workspace.path}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={workspaceSaving}
                onClick={() => {
                  const pendingText = workspacePromptText;
                  workspacePromptBypassRef.current = activeSessionId ?? (activeProjectId ? `project:${activeProjectId}` : null);
                  setWorkspacePromptText(null);
                  setDraft('');
                  void sendAiMessage(pendingText);
                }}
                className="rounded-xl border border-line px-3 py-2 text-xs text-muted hover:text-text"
              >
                작업폴더 없이 대화
              </button>
              <button
                type="button"
                disabled={workspaceSaving}
                onClick={() => setWorkspacePromptText(null)}
                className="rounded-xl bg-panel-2 px-3 py-2 text-xs text-text"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="chat-settings-header" data-testid="chat-settings-header" role="group" aria-label="대화 설정">
        <div className="chat-model-control">
          <button
            type="button"
            ref={modelPickerTriggerRef}
            aria-label={`대화 모델: ${selectedModelLabel}`}
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
            aria-controls={modelPickerOpen ? 'chat-model-listbox' : undefined}
            data-testid="chat-model-select"
            disabled={busy || pickerModels.length === 0}
            onClick={() => {
              setPolicyOpen(false);
              setModelPickerOpen((open) => !open);
            }}
            className="chat-model-select"
            style={{ width: `${Math.min(30, Math.max(14, selectedModelLabel.length + 5))}ch` }}
            title={`${selectedModelLabel}${busy ? ' · 응답 생성 중에는 모델을 변경할 수 없습니다.' : ''}`}
          >
            <span>{selectedModelLabel}</span>
            <CaretDown size={14} aria-hidden="true" className="chat-model-caret" />
          </button>
          {modelPickerOpen ? createPortal(
            <div
              id="chat-model-listbox"
              ref={modelPickerRef}
              role="listbox"
              aria-label="대화 모델"
              data-testid="chat-model-menu"
              className="chat-model-menu"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === 'Tab') {
                  setModelPickerOpen(false);
                  return;
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
                if (!options.length) return;
                const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
                const next = event.key === 'Home' ? 0
                  : event.key === 'End' ? options.length - 1
                    : event.key === 'ArrowDown' ? Math.min(options.length - 1, current + 1)
                      : Math.max(0, current - 1);
                options[next]?.focus();
                options[next]?.scrollIntoView({ block: 'nearest' });
              }}
            >
              {!pickerModels.some((model) => model.id === selectedModel) && selectedModel ? (
                <div className="chat-model-group">
                  <p className="chat-model-group-label">현재</p>
                  <button type="button" role="option" aria-selected="true" data-value={selectedModel}
                    className="chat-model-option" onClick={() => chooseModel(selectedModel)}>
                    {selectedModel} · 현재 목록에 없음
                  </button>
                </div>
              ) : null}
              {managedModels.length > 0 ? (
                <div className="chat-model-group">
                  <p className="chat-model-group-label">제공</p>
                  {managedModels.map((model) => (
                    <button key={model.id} type="button" role="option" aria-selected={model.id === selectedModel}
                      data-value={model.id} className="chat-model-option" title={model.label}
                      onClick={() => chooseModel(model.id)}>
                      {model.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {byokModels.length > 0 ? (
                <div className="chat-model-group">
                  <p className="chat-model-group-label">개인 키</p>
                  {byokModels.map((model) => (
                    <button key={model.id} type="button" role="option" aria-selected={model.id === selectedModel}
                      data-value={model.id} className="chat-model-option" title={model.label}
                      onClick={() => chooseModel(model.id)}>
                      {model.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>,
            document.body,
          ) : null}
        </div>
        <div className="chat-policy-controls" role="group" aria-label="실행 설정">
          <button type="button" data-testid="chat-execution-policy" className="chat-setting-control"
            aria-label={`작업 방식: ${workspaceBehaviorLabel(activeExecutionPolicy.workspace_behavior)}`}
            aria-haspopup="dialog" aria-controls={policyOpen && policyTarget === 'chat-workspace-behavior' ? policyId : undefined}
            aria-expanded={policyOpen && policyTarget === 'chat-workspace-behavior'}
            onClick={(event) => openPolicy(event, 'chat-workspace-behavior')}>
            {workspaceBehaviorLabel(activeExecutionPolicy.workspace_behavior)} <CaretDown size={12} aria-hidden="true" />
          </button>
          <button type="button" data-testid="chat-reasoning-button" className="chat-setting-control"
            aria-haspopup="dialog" aria-controls={policyOpen && policyTarget === 'chat-reasoning-level' ? policyId : undefined}
            aria-expanded={policyOpen && policyTarget === 'chat-reasoning-level'}
            onClick={(event) => openPolicy(event, 'chat-reasoning-level')}>
            <span>추론: {skillMode === 'image' || modelOmitsReasoningEffort(selectedModel, selectedReasoningCapability) ? '미사용' : reasoningLabel(activeExecutionPolicy.reasoning)}</span>
            <CaretDown size={12} aria-hidden="true" />
          </button>
          <button type="button" data-testid="chat-approval-button" className="chat-setting-control"
            aria-haspopup="dialog" aria-controls={policyOpen && policyTarget === 'chat-approval-level' ? policyId : undefined}
            aria-expanded={policyOpen && policyTarget === 'chat-approval-level'}
            onClick={(event) => openPolicy(event, 'chat-approval-level')}>
            <span>승인: {approvalLabel(activeExecutionPolicy.approval)}</span> <CaretDown size={12} aria-hidden="true" />
          </button>
        </div>
        <div className="chat-context-controls" role="group" aria-label="작업 폴더 및 보조 도구">
        <button
          type="button"
          data-testid="chat-workspace-button"
          onClick={(event) => openPolicy(event, 'chat-workspace-select')}
          className="chat-setting-control chat-workspace-control"
          aria-haspopup="dialog" aria-controls={policyOpen && policyTarget === 'chat-workspace-select' ? policyId : undefined}
          aria-expanded={policyOpen && policyTarget === 'chat-workspace-select'}
          aria-label={activeWorkspaceProjectId ? `작업 폴더: ${workspaceOptions.find((w) => w.id === activeWorkspaceProjectId)?.title ?? '연결됨'}` : '작업폴더 연결'}
          title={workspaceOptions.find((w) => w.id === activeWorkspaceProjectId)?.path ?? '이 채팅에 등록 작업폴더 연결'}
        >
          <FolderSimple size={16} aria-hidden="true" />
          <span>{activeWorkspaceProjectId ? (workspaceOptions.find((w) => w.id === activeWorkspaceProjectId)?.title ?? '작업폴더 연결됨') : '작업폴더 연결'}</span>
          <CaretDown size={12} aria-hidden="true" />
        </button>
        {policyOpen ? createPortal(
          <div
            id={policyId}
            ref={policyRef}
            tabIndex={-1}
            role="dialog"
            aria-label={policyTarget === 'chat-workspace-select' ? '작업 폴더 연결' : policyTarget === 'chat-workspace-behavior' ? '작업 방식' : policyTarget === 'chat-reasoning-level' ? '추론 수준' : '작업 승인'}
            data-testid="chat-policy-popover"
            className="chat-policy-popover"
            onKeyDown={(event) => {
              if (event.key === 'Tab' && policyTarget !== 'chat-workspace-select') closePolicy();
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-text">{policyTarget === 'chat-workspace-select' ? '작업 폴더 연결' : policyTarget === 'chat-workspace-behavior' ? '작업 방식' : policyTarget === 'chat-reasoning-level' ? '추론 수준' : '작업 승인'}</p>
              <button type="button" className="chat-setting-control chat-icon-control" aria-label="설정 닫기" onClick={closePolicy}><X size={16} aria-hidden="true" /></button>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-muted">이 채팅에만 적용 · 다음 요청부터 사용</p>
            {policySaving ? <p role="status" className="mt-2 text-xs text-muted">저장 중…</p> : null}
            {policyError ? <p role="alert" className="mt-2 text-xs text-red-700">{policyError}</p> : null}
            {busy ? <p className="mt-2 text-xs text-muted">응답 생성 중에는 변경할 수 없습니다.</p> : null}
            {policyTarget === 'chat-workspace-select' ? (
              <label className="mt-4 block text-xs font-medium text-text">
                연결할 작업 폴더
                <select data-testid="chat-workspace-select" value={activeWorkspaceProjectId ?? ''}
                  disabled={busy || workspaceSaving}
                  className="mt-1.5 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm"
                  onChange={(event) => {
                    setWorkspaceSaving(true);
                    void setSessionWorkspaceProject(event.target.value || null)
                      .catch((error) => flashPasteHint(error instanceof Error ? error.message : String(error)))
                      .finally(() => setWorkspaceSaving(false));
                  }}>
                  <option value="">작업폴더 없이 대화</option>
                  {activeWorkspaceProjectId && !workspaceOptions.some((w) => w.id === activeWorkspaceProjectId) ? <option value={activeWorkspaceProjectId}>현재 연결된 작업폴더 · 목록에 없음</option> : null}
                  {workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
                </select>
                <span className="mt-2 block break-all text-[11px] leading-5 text-muted">{workspaceOptions.find((w) => w.id === activeWorkspaceProjectId)?.path ?? '등록된 작업 폴더의 파일 접근 범위를 연결합니다. 스킬은 자동 적용하지 않습니다.'}</span>
              </label>
            ) : policyTarget === 'chat-workspace-behavior' ? (
              <PolicyChoices testId="chat-workspace-behavior" label="작업 방식 선택"
                value={activeExecutionPolicy.workspace_behavior ?? 'agent'} disabled={busy || policySaving}
                options={[
                  { value: 'agent', label: 'Agent', description: '도구로 바로 실행' },
                  { value: 'plan', label: 'Plan', description: '계획만 · 수정 전 확인' },
                  { value: 'ask', label: 'Ask', description: '설명·질문 중심 · 도구 최소' },
                ]} onSelect={(value) => void savePolicy({ workspace_behavior: value as WorkspaceBehavior })} />
            ) : policyTarget === 'chat-reasoning-level' ? (<>
              <PolicyChoices testId="chat-reasoning-level" label="추론 수준 선택"
                value={normalizeReasoningLevelForModel(activeExecutionPolicy.reasoning, skillMode === 'image' ? null : selectedModel, selectedReasoningCapability)}
                disabled={busy || policySaving || skillMode === 'image' || modelOmitsReasoningEffort(selectedModel, selectedReasoningCapability)}
                options={reasoningSelectOptionsForModel(selectedModel, { imageMode: skillMode === 'image', capability: selectedReasoningCapability })}
                onSelect={(value) => void savePolicy({ reasoning: value as ReasoningLevel })} />
              <p className="mt-2 text-[11px] leading-5 text-muted">
                {skillMode === 'image' || modelOmitsReasoningEffort(selectedModel, selectedReasoningCapability)
                  ? '이 모델에서는 추론 수준을 쓰지 않습니다.'
                  : '자동은 앱이 요청 난이도와 모델 지원 범위를 보고 실제 단계를 선택합니다.'}
              </p>
              {effectiveExecutionPolicy ? <p className="mt-2 text-[11px] text-muted">최근 실행의 추론: {reasoningLabel(effectiveExecutionPolicy.reasoning)}</p> : null}
            </>) : (<>
              <PolicyChoices testId="chat-approval-level" label="작업 승인 선택"
                value={activeExecutionPolicy.approval} disabled={busy || policySaving}
                options={[
                  { value: 'autopilot', label: 'Autopilot', description: '안전 범위 완전 위임' },
                  { value: 'delegate', label: '나 대신 승인', description: 'Luna가 위험 판단' },
                  { value: 'ask', label: '작업 시 승인 요청', description: '승인이 필요한 작업은 직접 확인' },
                ]} onSelect={(value) => void savePolicy({ approval: value as ApprovalLevel,
                  autopilot: value === 'autopilot' ? 'on' : value === 'delegate' ? 'auto' : 'off' })} />
              <p className="mt-2 text-[11px] leading-5 text-muted">외부 쓰기·삭제·롤백·플러그인 변경·Office 원본 변경은 Luna에 위임하지 않고 사용자에게 확인합니다.</p>
            </>)}
          </div>
        , document.body) : null}
        <button
          type="button"
          className="chat-setting-control chat-icon-control"
          aria-label="모델 목록 새로고침"
          title="모델 목록 새로고침"
          disabled={pickerBusy}
          onClick={() => {
            setPickerBusy(true);
            void refreshModelPicker(true)
              .catch(() => undefined)
              .finally(() => setPickerBusy(false));
          }}
        >
          <ArrowClockwise size={14} className={pickerBusy ? 'animate-spin' : undefined} />
        </button>
        <button
          type="button"
          aria-pressed={previewPaneOpen}
          aria-label={previewPaneOpen ? '오른쪽 패널 접기' : '오른쪽 패널 펼치기'}
          title={previewPaneOpen ? '오른쪽 패널 접기' : '오른쪽 패널 펼치기'}
          onClick={() => setPreviewPaneOpen(!previewPaneOpen)}
          className="chat-setting-control chat-icon-control"
        >
          <Browser size={16} weight={previewPaneOpen ? 'bold' : 'regular'} />
        </button>
        </div>
      </div>
      {apiError ? (
        <div className="border-b border-line bg-red-950/40 px-5 py-2 text-[12px] text-red-300">
          {apiError}
        </div>
      ) : null}

      {skillMode ? (
      <div
        data-testid="skill-status-bar"
        data-active={Boolean(skillMode)}
        className="chat-skill-status"
      >
        <div role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <CheckCircle size={16} weight="fill" aria-hidden="true" className="shrink-0 text-accent-dim" />
          <span className="text-muted">스킬</span>
          <span className="min-w-0 break-all font-semibold">{skillLabel || skillMode}</span>
          <span className="text-accent-dim">적용 중</span>
        </div>
        <div className="flex items-center gap-1">
        <button type="button" className="chat-setting-control" onClick={() => {
          setSkillPickerOpen(true);
        }}>변경</button>
        <button
          type="button"
          data-testid="skill-status-action"
          className="chat-setting-control"
          onClick={() => {
            setSkillMode(null);
            skillButtonRef.current?.focus();
          }}
        >
          <X size={14} aria-hidden="true" /> 해제
        </button>
        </div>
      </div>
      ) : null}

      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="대화 이력"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown PageUp PageDown Tab"
        className="chat-content-padding min-h-0 flex-1 overflow-auto px-5 py-6 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        onClick={(event) => focusHistoryBackground(event.currentTarget, event.target)}
        onWheel={() => { historyCursorRef.current = null; }}
        onPointerDown={() => { historyCursorRef.current = null; }}
        onBlur={() => { historyCursorRef.current = null; }}
        onKeyDown={(event) => {
          const scroller = event.currentTarget;
          if (tabToComposer(event.nativeEvent, scroller, draftInputRef.current)) return;
          const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
          const anchors = visibleChat.flatMap((turn) => {
            const anchor = turnAnchorRefs.current.get(turn.id);
            return anchor && (turn.role === 'user' || turn.role === 'assistant')
              ? [{ id: turn.id, role: turn.role, top: anchor.getBoundingClientRect().top - viewportTop + scroller.scrollTop }]
              : [];
          });
          historyCursorRef.current = navigateHistory(
            event.nativeEvent, scroller, anchors, historyCursorRef.current, Boolean(menu),
          );
          if (event.nativeEvent.defaultPrevented) event.stopPropagation();
        }}
        onContextMenu={openSessionMenu}
      >
        <div className="chat-content-width mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-5">
          {visibleChat.length === 0 && !busy ? (
            <div className="py-16 text-center">
              <p className="text-lg font-medium text-text/90">무엇을 할까요?</p>
            </div>
          ) : null}
          {visibleChat.map((turn) => (
            <div
              key={turn.id}
              ref={(el) => {
                if (el) turnAnchorRefs.current.set(turn.id, el);
                else turnAnchorRefs.current.delete(turn.id);
              }}
              className={`flex w-full min-w-0 flex-col gap-1 ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted">
                {turn.role === 'user'
                  ? 'You'
                  : String(modelLabels.get(turn.model ?? '') ?? turn.model ?? 'Assistant')
                      .replace(/\uD68C\uC0AC OpenRouter/g, 'MY OpenRouter')}
              </span>
              <div
                data-chat-bubble="true"
                className={`min-w-0 max-w-[92%] overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                  turn.role === 'user'
                    ? 'bg-panel-2 text-text'
                    : 'border border-line bg-panel text-text/90'
                }`}
                onContextMenu={(e) => openMessageMenu(e, turn)}
              >
                {turn.role === 'assistant' && (turn.thought?.trim() || turn.streamPreview?.trim() || turn.toolActivity?.length) ? (
                  <ToolActivityLog
                    storageKey={activeSessionId ? `${activeSessionId}:${turn.id}` : undefined}
                    rows={turn.toolActivity ?? []}
                    timeline={turn.workTimeline}
                    modelResponse={turn.thought}
                    streamPreview={turn.streamPreview}
                    live={busy && !turn.completedAt && turn.id === latestAssistantTurnId}
                  />
                ) : null}
                {turn.attachmentNames?.length ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {turn.attachmentNames.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 rounded-lg border border-line/70 bg-ink/30 px-2 py-0.5 text-[11px] text-muted"
                      >
                        {isImageAttachment(undefined, name) ? (
                          <ImageIcon size={12} />
                        ) : (
                          <FileIcon size={12} />
                        )}
                        {name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {turn.imageUrls?.length ? (
                  <div className={`flex flex-col gap-2 ${turn.text ? 'mb-3' : ''}`}>
                    {turn.imageUrls.map((url) => (
                      <button
                        key={url}
                        type="button"
                        className="block overflow-hidden rounded-xl border border-line/70 bg-ink/40 text-left"
                        onClick={() =>
                          openImagePreview({
                            src: url,
                            title: turn.text?.slice(0, 48) || '생성 이미지',
                            prompt: turn.text || '',
                          })
                        }
                        onContextMenu={(e) =>
                          openImageMenu(
                            e,
                            url,
                            turn.text?.slice(0, 48) || '생성 이미지',
                            turn.text || '',
                          )
                        }
                      >
                        <img
                          src={url}
                          alt=""
                          className="max-h-80 w-full object-contain"
                          loading="lazy"
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
                {!turn.text || turn.text === '작업 중…'
                  ? busy && turn.role === 'assistant' && !turn.imageUrls?.length
                    ? <>작업 중 · <LiveDuration startedAt={turn.startedAt} live={busy} /></>
                    : ''
                  : turn.role === 'assistant'
                    ? <MessageMarkdown text={turn.text} onOpenUrl={openExternalUrl} copyText={copyMarkdownText} />
                    : renderMessageText(turn.text)}
              </div>
              {turn.role === 'assistant' && (conversationDisplay.showTokens || conversationDisplay.showTime)
                ? (() => {
                    const parts: string[] = [];
                    if (conversationDisplay.showTokens && typeof turn.usage?.inputTokens === 'number') {
                      parts.push(`입력 ${turn.usage.inputTokens.toLocaleString()} 토큰`);
                    }
                    if (conversationDisplay.showTime) {
                      const req = formatClockTime(turn.startedAt);
                      if (req) parts.push(`요청 ${req}`);
                    }
                    if (conversationDisplay.showTokens && typeof turn.usage?.outputTokens === 'number') {
                      parts.push(`출력 ${turn.usage.outputTokens.toLocaleString()} 토큰`);
                    }
                    if (conversationDisplay.showTime) {
                      const done = formatClockTime(turn.completedAt);
                      if (done) parts.push(`완료 ${done}`);
                      const dur = turn.completedAt ? formatWorkDuration(turn.startedAt, turn.completedAt) : null;
                      if (dur) parts.push(`소요 ${dur}`);
                    }
                    return parts.length ? (
                      <div className="max-w-[92%] px-1 text-[11px] text-muted">{parts.join(' · ')}</div>
                    ) : null;
                  })()
                : null}
              {turn.role === 'assistant' && turn.applicationNotice ? (
                <aside
                  className={`max-w-[92%] rounded-xl border px-3 py-2 text-[12px] leading-relaxed ${
                    turn.applicationNotice.kind === 'continuation'
                      ? 'border-amber-500/30 bg-amber-500/5 text-amber-100/90'
                      : 'border-red-500/30 bg-red-500/5 text-red-100/90'
                  }`}
                  aria-label="애플리케이션 안내"
                >
                  <p className="font-medium">애플리케이션 · {turn.applicationNotice.title}</p>
                  <p className="mt-1 text-text/80">{turn.applicationNotice.message}</p>
                  {(turn.applicationNotice.model || formatElapsedRuntime(turn.applicationNotice.elapsedMs)) ? (
                    <p className="mt-1.5 text-[11px] text-muted">
                      {[
                        turn.applicationNotice.model ? `모델 ${turn.applicationNotice.model}` : '',
                        formatElapsedRuntime(turn.applicationNotice.elapsedMs)
                          ? `누적 작업시간 ${formatElapsedRuntime(turn.applicationNotice.elapsedMs)}`
                          : '',
                        typeof turn.applicationNotice.step === 'number'
                          ? `${turn.applicationNotice.step} 스텝`
                          : '',
                      ].filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                </aside>
              ) : null}
            </div>
          ))}
          {openGateText && !busy ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100/90">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-200/80">
                  Exit Gate · 1
                </p>
                <p className="mt-0.5 leading-snug">{openGateText}</p>
                <p className="mt-1 text-[11px] text-muted">다음 턴은 이 게이트만 닫으면 됩니다.</p>
              </div>
            </div>
          ) : null}
          {busy ? (
            <div className="flex items-start gap-2 rounded-xl border border-accent/25 bg-accent/5 px-3 py-2.5 text-sm text-accent">
              <CircleNotch size={16} className="mt-0.5 shrink-0 animate-spin" />
              <div className="min-w-0">
                {/* 전체 진행 이력은 말풍선의 접힌 작업 영역에서만 표시 — 여기는 현재 상태 1줄만 (중복 렌더링 제거) */}
                <div className="flex items-start gap-2 leading-snug">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-400" aria-hidden="true" />
                  <span className="font-medium text-text">
                    {(progressSteps.length ? progressSteps[progressSteps.length - 1] : '생각 중…').replace(
                      /\uD68C\uC0AC OpenRouter/g,
                      'MY OpenRouter',
                    )}
                  </span>
                </div>
                {openGateText ? (
                  <p className="mt-0.5 text-[11px] text-amber-200/80">Exit Gate: {openGateText}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <ContextMenuPortal menu={menu} onClose={close} />

      <div className="chat-content-padding bg-panel px-5 py-4">
        <div className="chat-content-width composer-content-width mx-auto w-full max-w-2xl">
          {contextBudget && contextBudget.contextLength > 0 ? (
            <div
              className="mb-2 flex justify-end gap-3 text-[10px] tabular-nums text-muted"
              data-testid="context-budget-gauge"
              title={
                contextBudget.fallback128k
                  ? '모델 컨텍스트 정보를 찾지 못해 128k 기준값을 사용 중입니다.'
                  : '전달 예정은 압축 후 대화 기록 문자 수를 토큰으로 환산한 추정치입니다.'
              }
            >
              <span>전체 컨텍스트 {(contextBudget.contextLength / 1000).toFixed(0)}k</span>
              <span>전달 예정 ≈{Math.ceil(contextBudget.usedChars / 4).toLocaleString()}</span>
              <span>
                직전 처리{' '}
                {contextBudget.lastProcessedTokens === null
                  ? '—'
                  : contextBudget.lastProcessedTokens.toLocaleString()}
              </span>
              {contextBudget.compressed ? <span className="text-amber-300">압축됨</span> : null}
            </div>
          ) : null}          {pasteHint ? (
            <p className="mb-2 text-[11px] text-amber-300/90">{pasteHint}</p>
          ) : null}
          <div
            ref={composerRef}
            data-drag-active={dragActive}
            className={`chat-composer relative rounded-2xl border transition-colors ${
              skillPickerOpen ? 'overflow-visible' : 'overflow-hidden'
            } ${
              dragActive
                ? 'border-accent bg-accent/5 shadow-[0_0_0_1px_rgba(45,212,191,0.35)]'
                : 'border-line'
            }`}
          >
            {dragActive ? (
              <div className="composer-dropzone pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl" role="status">
                <span>파일을 여기에 놓으세요</span>
              </div>
            ) : null}
            {messageReferences.length > 0 ? (
              <div className="composer-meta-row flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
                {messageReferences.map((reference) => (
                  <div
                    key={reference.id}
                    className="inline-flex max-w-full items-center gap-1 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1 text-[11px] text-accent"
                    title={reference.text}
                  >
                    <span className="shrink-0 opacity-70">↪</span>
                    <span className="max-w-56 truncate">
                      {reference.role === 'user' ? '사용자' : '모델'} · {reference.text}
                    </span>
                    <button
                      type="button"
                      className="rounded p-0.5 text-muted hover:bg-ink hover:text-text"
                      aria-label="메시지 참조 제거"
                      onClick={() => setMessageReferences((current) => current.filter((item) => item.id !== reference.id))}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {pendingAttachments.length > 0 ? (
              <div className="composer-attachments flex gap-2 overflow-x-auto px-3 pb-1 pt-2" aria-label="첨부 파일">
                {pendingAttachments.map((a, index) => (
                  <div
                    key={a.id}
                    className="composer-attachment-card group relative flex shrink-0 items-center gap-2 overflow-hidden rounded-lg px-1.5 py-1"
                  >
                    {isImageAttachment(a.mime, a.name) ? (
                      <button type="button" className="composer-attachment-preview overflow-hidden rounded-md" aria-label={`${attachmentDisplayNames[index]} 크게 보기`}
                        onClick={() => openImagePreview({ src: a.previewUrl || `/attachments/${encodeURIComponent(a.id)}`, title: a.name, prompt: '' })}
                        onContextMenu={(e) => openImageMenu(e, a.previewUrl || `/attachments/${encodeURIComponent(a.id)}`, a.name, '')}>
                        <img src={a.previewUrl || `/attachments/${encodeURIComponent(a.id)}`} alt={attachmentDisplayNames[index]} className="h-10 w-10 object-cover" />
                      </button>
                    ) : isVideoAttachment(a.mime, a.name) ? (
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-accent">
                        <FilmStrip size={16} weight="bold" />
                      </span>
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-muted">
                        <FileIcon size={16} />
                      </span>
                    )}
                    <span className="max-w-[112px] truncate text-[11px] text-muted" title={attachmentDisplayNames[index]}>
                      {attachmentDisplayNames[index]}
                    </span>
                    <button
                      type="button"
                      className="composer-attachment-remove rounded text-muted hover:bg-ink hover:text-text"
                      aria-label={`${attachmentDisplayNames[index]} 첨부 제거`}
                      onClick={() => void removePendingAttachment(a.id)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {pendingContextPaths.length > 0 ? (
              <div className="composer-meta-row flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
                {pendingContextPaths.map((p) => {
                  const label = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
                  return (
                    <div
                      key={p}
                      className="inline-flex max-w-full items-center gap-1 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1 text-[11px] text-accent"
                      title={p}
                    >
                      <span className="shrink-0 opacity-70">@</span>
                      <span className="truncate">{label}</span>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted hover:bg-ink hover:text-text"
                        aria-label="@ 컨텍스트 제거"
                        onClick={() => removeContextPath(p)}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <textarea
              ref={draftInputRef}
              value={draft}
              onChange={(e) => {
                const next = e.target.value;
                const prev = draft;
                setDraft(next);
                // Bare trailing @ opens file picker for context chips (code mode preferred).
                if (
                  next.length === prev.length + 1 &&
                  next.endsWith('@') &&
                  (prev === '' || /[\s\n]$/.test(prev) || prev.endsWith('@'))
                ) {
                  setContextPickerOpen(true);
                }
              }}
              rows={1}
              aria-label="메시지 입력"
              placeholder={skillMode === 'image' ? '만들고 싶은 이미지를 설명하세요…' : activeWorkspaceProjectId ? '메시지 또는 작업 요청… (@로 파일 첨부)' : '무엇이든 물어보세요…'}
              className="composer-input w-full resize-none bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-muted"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {activeQueue.length > 0 ? (
              <div className="mx-3 mb-2 rounded-lg border border-line bg-panel-2/60 px-3 py-2" data-testid="message-queue">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold text-muted">대기 중 {activeQueue.length}</div>
                  {activeSessionId && queueReviewSessions[activeSessionId] ? (
                    <button
                      type="button"
                      disabled={editingQueueId !== null || activeQueue.some((item) => !item.text.trim() && item.attachmentIds.length === 0)}
                      onClick={() => continueQueuedMessages(activeSessionId)}
                      className="rounded-md bg-accent px-2 py-1 text-[10px] font-semibold text-ink disabled:opacity-40"
                    >
                      편집 완료 후 진행
                    </button>
                  ) : null}
                </div>
                {activeSessionId && queueReviewSessions[activeSessionId] ? (
                  <div className="mb-1.5 text-[10px] text-muted">순서를 유지한 채 내용을 확인·수정한 다음 진행하세요.</div>
                ) : null}
                <div className="max-h-[min(28vh,220px)] overflow-y-auto overscroll-contain pr-1">
                  {activeQueue.map((item, index) => {
                    const queueText = item.text || item.attachmentNames.join(', ');
                    const canExpand = queuedMessageNeedsExpansion(item.text, item.attachmentNames);
                    const expanded = expandedQueueIds.has(item.id);
                    return (
                  <div key={item.id} className="flex items-start gap-2 border-t border-line/50 py-1.5 text-[11px] text-text first:border-t-0">
                    <span className="pt-0.5 text-muted">{index + 1}</span>
                    {editingQueueId === item.id ? (
                      <textarea
                        autoFocus
                        rows={2}
                        value={editingQueueText}
                        onChange={(event) => setEditingQueueText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                          if (event.key === 'Escape') {
                            setEditingQueueId(null);
                            setEditingQueueText('');
                          }
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            if (editingQueueText.trim() || item.attachmentIds.length > 0) {
                              updateQueuedMessage(item.id, editingQueueText.trim());
                              setEditingQueueId(null);
                              setEditingQueueText('');
                            }
                          }
                        }}
                        className="max-h-40 min-w-0 flex-1 resize-y overflow-y-auto rounded-md border border-line bg-ink px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
                      />
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p className={`whitespace-pre-wrap break-words leading-5 ${expanded ? '' : 'line-clamp-3'}`}>
                          {queueText}
                        </p>
                        {canExpand ? (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-muted hover:text-text"
                            onClick={() => setExpandedQueueIds((current) => {
                              const next = new Set(current);
                              if (expanded) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })}
                          >
                            <CaretDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                            {expanded ? '접기' : '전체 보기'}
                          </button>
                        ) : null}
                      </div>
                    )}
                    {editingQueueId === item.id ? (
                      <>
                        <button
                          type="button"
                          disabled={!editingQueueText.trim() && item.attachmentIds.length === 0}
                          className="pt-0.5 text-accent disabled:opacity-40"
                          onClick={() => {
                            updateQueuedMessage(item.id, editingQueueText.trim());
                            setEditingQueueId(null);
                            setEditingQueueText('');
                          }}
                        >
                          저장
                        </button>
                        <button
                          type="button"
                          className="pt-0.5 text-muted hover:text-text"
                          onClick={() => {
                            setEditingQueueId(null);
                            setEditingQueueText('');
                          }}
                        >
                          취소
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="pt-0.5 text-muted hover:text-text"
                        onClick={() => {
                          setEditingQueueId(item.id);
                          setEditingQueueText(item.text);
                        }}
                      >
                        편집
                      </button>
                    )}
                    <button
                      type="button"
                      className="pt-0.5 text-muted hover:text-red-300"
                      onClick={() => removeQueuedMessage(item.id)}
                    >
                      삭제
                    </button>
                  </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="composer-toolbar flex items-center justify-between gap-3 px-3 pb-3 pt-1">
              <div className="relative flex items-center gap-1.5">
                <button
                  type="button"
                  title="파일 첨부 · 이 입력창에 끌어놓기도 가능"
                  aria-label="파일 첨부"
                  disabled={attachDisabled}
                  onClick={() => fileInputRef.current?.click()}
                  className="composer-tool-button"
                >
                  <Paperclip size={14} weight="bold" />
                </button>
                <button
                  type="button"
                  title={skillMode && skillLabel ? `스킬: ${skillLabel}` : '스킬 선택'}
                  aria-label="스킬 선택"
                  aria-expanded={skillPickerOpen}
                  data-testid="organization-skill-button"
                  ref={skillButtonRef}
                  onClick={() => setSkillPickerOpen((open) => !open)}
                  className={`composer-tool-button ${
                    skillMode || skillPickerOpen
                      ? 'composer-tool-button-active'
                      : ''
                  }`}
                >
                  <Plus size={14} weight="bold" />
                </button>
                <button
                  type="button"
                  title="컨텍스트 파일 추가"
                  data-testid="context-at-button"
                  onClick={(e) => {
                    if (
                      e.shiftKey &&
                      activeFileId &&
                      !/^buffer\.(tsx|ts|jsx|js)$/i.test(activeFileId)
                    ) {
                      addContextPath(activeFileId);
                      flashPasteHint(`@ ${activeFileId}`);
                      return;
                    }
                    if (!files.length) {
                      flashPasteHint('작업 폴더 파일을 불러온 뒤 @ 피커를 사용하세요.');
                      return;
                    }
                    setContextPickerOpen(true);
                  }}
                  className="composer-tool-button text-xs font-semibold"
                >
                  @
                </button>
                {pasting ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                    <CircleNotch size={12} className="animate-spin" />
                    업로드 중…
                  </span>
                ) : null}
                {skillPickerOpen ? (
                  <div
                    className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-56 overflow-y-auto rounded-xl border border-line bg-panel p-2 shadow-xl"
                    data-testid="organization-skill-menu"
                    ref={skillPickerRef}
                    tabIndex={-1}
                  >
                    <div className="px-2 pb-1 text-[10px] font-semibold text-muted">대화 스킬</div>
                    {staleSkillNotice ? (
                      <div className="mb-1 rounded-lg bg-amber-500/10 px-2 py-2 text-[11px] leading-4 text-amber-200" role="status">
                        {staleSkillNotice}
                      </div>
                    ) : null}
                    {skillMode ? (
                      <button
                        type="button"
                        data-testid="organization-skill-clear"
                        className="mb-1 block w-full rounded-lg px-2 py-2 text-left text-xs text-muted hover:bg-panel-2 hover:text-text"
                        onClick={() => {
                          setStaleSkillNotice(null);
                          setSkillMode(null);
                          setSkillPickerOpen(false);
                          skillButtonRef.current?.focus();
                        }}
                      >
                        <div className="font-medium">스킬 끄기</div>
                        <div className="mt-0.5 text-[10px] text-muted">현재 적용 중: {skillLabel ?? skillMode}</div>
                      </button>
                    ) : null}
                    {selectableSkills.length ? ['user', 'organization'].map((source) => {
                      const group = selectableSkills.filter((skill) => skill.source === source);
                      if (!group.length) return null;
                      return (
                        <div key={source} data-testid={`skill-group-${source}`}>
                          <div className="px-2 pb-1 pt-2 text-[10px] font-semibold text-muted">
                            {source === 'user' ? '사용자 스킬' : '조직 스킬'}
                          </div>
                          {group.map((skill) => (
                      <button
                        key={skill.mode}
                        type="button"
                        aria-pressed={skillMode === skill.mode}
                        className={`block w-full rounded-lg px-2 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dim ${skillMode === skill.mode ? 'bg-accent-dim text-white hover:bg-accent-dim' : 'text-text hover:bg-panel-2'}`}
                        onClick={() => {
                          setStaleSkillNotice(null);
                          if (skillMode === skill.mode) {
                            setSkillMode(null);
                          } else {
                            setSkillMode(skill.mode, skill.label);
                          }
                          setSkillPickerOpen(false);
                          skillButtonRef.current?.focus();
                        }}
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          {skillMode === skill.mode ? <CheckCircle size={16} weight="fill" aria-hidden="true" className="shrink-0" /> : null}
                          <span className="min-w-0 break-all">{skill.label}{skillMode === skill.mode ? ' · 적용 중' : ''}</span>
                        </div>
                        {skill.description ? <div className={`mt-1 text-xs ${skillMode === skill.mode ? 'text-white' : 'text-muted'}`}>{skill.description}</div> : null}
                      </button>
                          ))}
                        </div>
                      );
                    }) : <div className="px-2 py-2 text-[11px] text-muted">사용 가능한 스킬이 없습니다.</div>}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                {busy ? (
                  <>
                    <button
                      type="button"
                      disabled={!canSend}
                      onClick={submit}
                      title="현재 응답 다음에 실행"
                      className="composer-send-button"
                    >
                      <PaperPlaneTilt size={14} weight="fill" />
                      대기열 추가
                    </button>
                    <button
                    type="button"
                    onClick={() => stopAiMessage()}
                    title="생성 중지"
                    className="composer-stop-button"
                  >
                    <Stop size={14} weight="fill" />
                    중지
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={submit}
                    className="composer-send-button"
                  >
                    <PaperPlaneTilt size={14} weight="fill" />
                    전송
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {contextPickerOpen ? (
        <QuickOpenModal
          files={contextFiles}
          title="@ 컨텍스트 추가"
          placeholder="파일·폴더 검색… (Enter 추가, Esc 닫기)"
          selectedPaths={pendingContextPaths}
          keepOpenOnSelect
          onClose={() => setContextPickerOpen(false)}
          onOpen={(path) => {
            addContextPath(path);
            // Strip a lone trailing @ left by the trigger key.
            setDraft((d) => (d.endsWith('@') ? d.slice(0, -1) : d));
            flashPasteHint(`@ ${path}`);
          }}
        />
      ) : null}
    </section>
  );
}
