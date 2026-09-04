import {
  ArrowClockwise,
  ArrowUUpLeft,
  CircleNotch,
  File as FileIcon,
  FilmStrip,
  Paperclip,
  Plus,
  PaperPlaneTilt,
  Browser,
  CaretDown,
  X,
  Image as ImageIcon,
  Stop,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { isChatTurnUiHidden } from '../lib/documentMemo';
import type { ChatTurn } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  listSelectableOrganizationSkills,
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
} from '../lib/reasoning-levels';
import {
  copyImageToClipboard,
  copyImageUrl,
  copyText,
  downloadImageUrl,
  guessImageFilename,
} from '../lib/mediaActions';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { flattenWorkspaceFiles, QuickOpenModal } from './QuickOpenModal';

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

/** http(s) URLs, or bare www./amazon. hosts commonly pasted into chat. */
const EXTERNAL_URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'`）】)\]]+/gi;
const URL_TRAILING_PUNCTUATION_RE = /[.,!?;:`'"”’）】)\]>]+$/;

type ChromeWebViewHost = {
  postMessage: (message: unknown) => void;
};

function getChromeWebView(): ChromeWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ChromeWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

/** Open http(s) in the WPF shell right-side BrowserWebView (not the system browser). */
function openInAppBrowser(rawUrl: string): boolean {
  const href = normalizeExternalHref(rawUrl);
  if (!href) return false;
  const webview = getChromeWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.open', url: href });
  return true;
}

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
  let value = rawUrl.trim().replace(URL_TRAILING_PUNCTUATION_RE, '');
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'http:' && uri.protocol !== 'https:') return null;
    return uri.href;
  } catch {
    return null;
  }
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
  const removeQueuedMessage = useWorkspaceStore((s) => s.removeQueuedMessage);
  const stopAiMessage = useWorkspaceStore((s) => s.stopAiMessage);
  const undoLastTurn = useWorkspaceStore((s) => s.undoLastTurn);
  const canUndo = useWorkspaceStore((s) => s.canUndo);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeQueue = messageQueue.filter((item) => item.sessionId === activeSessionId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeWorkspaceProjectId = useWorkspaceStore((s) => s.activeWorkspaceProjectId);
  const setSessionWorkspaceProject = useWorkspaceStore((s) => s.setSessionWorkspaceProject);
  const setSessionProject = useWorkspaceStore((s) => s.setSessionProject);
  const selectedModel = useWorkspaceStore((s) => s.selectedModel);
  const setSelectedModel = useWorkspaceStore((s) => s.setSelectedModel);
  const modelOptions = useWorkspaceStore((s) => s.modelOptions);
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
  const skillMode = useWorkspaceStore((s) => s.skillMode);
  const skillLabel = useWorkspaceStore((s) => s.skillLabel);
  const setSkillMode = useWorkspaceStore((s) => s.setSkillMode);
  const loadChatSession = useWorkspaceStore((s) => s.loadChatSession);
  const clearActiveChat = useWorkspaceStore((s) => s.clearActiveChat);
  const openImagePreview = useWorkspaceStore((s) => s.openImagePreview);
  const [draft, setDraft] = useState('');
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
    setDraft(next ? draftsBySessionRef.current.get(next) ?? '' : '');
  }, [activeSessionId, draft]);
  const composerPrefill = useWorkspaceStore((s) => s.composerPrefill);
  const composerFocusNonce = useWorkspaceStore((s) => s.composerFocusNonce);
  const clearComposerPrefill = useWorkspaceStore((s) => s.clearComposerPrefill);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!composerFocusNonce || composerPrefill == null) return;
    setDraft((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${composerPrefill}` : composerPrefill));
    clearComposerPrefill();
    window.setTimeout(() => draftInputRef.current?.focus(), 0);
  }, [composerFocusNonce, composerPrefill, clearComposerPrefill]);
  const [messageReferences, setMessageReferences] = useState<MessageReference[]>([]);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [selectableSkills, setSelectableSkills] = useState<SkillListItem[]>([]);
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
    void listSelectableOrganizationSkills().then((skills) => { if (!cancelled) setSelectableSkills(skills); }).catch(() => { if (!cancelled) setSelectableSkills([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setMessageReferences([]);
  }, [activeSessionId]);

  useEffect(() => {
    if (!busy) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const openedSessionRef = useRef<string | null>(null);
  const turnAnchorRefs = useRef<Map<string, HTMLElement>>(new Map());
  const wasBusyRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const workspacePromptBypassRef = useRef<string | null>(null);
  const { menu, openAt, close } = useContextMenu();

  const visibleChat = chat.filter((turn) => !isChatTurnUiHidden(turn, chat));
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

  const onComposerDragEnter = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  const onComposerDragLeave = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  const onComposerDragOver = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if ([...e.dataTransfer.types].includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onComposerDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = filesFromDataTransfer(e.dataTransfer);
      void ingestFiles(files);
    },
    [ingestFiles],
  );

  const attachDisabled = pasting;

  const canSend = (!!draft.trim() || pendingAttachments.length > 0 || messageReferences.length > 0) && !pasting;

  const showUndo = canUndo && !busy;

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
      className="relative flex h-full flex-col bg-ink"
      onDragEnter={onComposerDragEnter}
      onDragLeave={onComposerDragLeave}
      onDragOver={onComposerDragOver}
      onDrop={onComposerDrop}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-ink/75 text-sm font-medium text-accent">
          파일을 여기에 놓으세요 (형식 제한 없음)
        </div>
      ) : null}
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
      <div className="relative flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <select
          value={selectedModel}
          disabled={busy}
          onChange={(e) => {
            void setSelectedModel(e.target.value);
          }}
          className="min-w-0 flex-1 truncate rounded-md border-0 bg-transparent py-1 text-[12px] text-text outline-none focus:text-accent"
          title={busy ? '응답 생성 중에는 모델을 변경할 수 없습니다.' : '모델'}
        >
          {!pickerModels.some((model) => model.id === selectedModel) && selectedModel ? (
            <option value={selectedModel}>{selectedModel} · 현재 목록에 없음</option>
          ) : null}
          {pickerModels.length === 0 ? (
            <option value="" disabled>
              모델 없음 · 왼쪽 모델에서 키 등록
            </option>
          ) : null}
          {managedModels.length > 0 ? (
            <optgroup label="제공">
              {managedModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {byokModels.length > 0 ? (
            <optgroup label="개인 키">
              {byokModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button
          type="button"
          data-testid="chat-workspace-button"
          onClick={() => setPolicyOpen(true)}
          className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] ${
            activeWorkspaceProjectId
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-line bg-panel text-muted hover:border-accent/50 hover:text-text'
          }`}
          title="이 채팅에 등록 작업폴더 연결"
        >
          {activeWorkspaceProjectId ? '작업폴더 연결됨' : '작업폴더 연결'}
        </button>
        <button
          type="button"
          data-testid="chat-execution-policy"
          aria-expanded={policyOpen}
          onClick={() => setPolicyOpen((open) => !open)}
          className="shrink-0 rounded-lg border border-line bg-panel px-2.5 py-1 text-[11px] text-muted hover:border-accent/50 hover:text-text"
          title="현재 채팅의 추론·작업 방식·승인 권한"
        >
          {workspaceBehaviorLabel(activeExecutionPolicy.workspace_behavior)}
          {' · '}추론 {effectiveExecutionPolicy ? reasoningLabel(effectiveExecutionPolicy.reasoning) : reasoningLabel(activeExecutionPolicy.reasoning)}
          {' · '}{approvalLabel(activeExecutionPolicy.approval)}
        </button>
        {policyOpen ? (
          <div
            role="dialog"
            aria-label="채팅 실행 정책"
            className="absolute right-12 top-9 z-50 w-72 rounded-2xl border border-line bg-panel p-4 shadow-xl"
          >
            <p className="text-sm font-semibold text-text">현재 채팅 실행 정책</p>
            <p className="mt-1 text-[11px] leading-5 text-muted">변경값은 이 채팅에만 저장되며 실행 중인 작업에는 영향을 주지 않습니다.</p>
            <label className="mt-4 block text-xs font-medium text-text">
              추론 수준
              <select
                data-testid="chat-reasoning-level"
                value={
                  reasoningSelectOptionsForModel(selectedModel, { imageMode: skillMode === 'image' })
                    .some((o) => o.value === activeExecutionPolicy.reasoning)
                    ? activeExecutionPolicy.reasoning
                    : 'auto'
                }
                disabled={busy || skillMode === 'image' || modelOmitsReasoningEffort(selectedModel)}
                onChange={(event) => void setExecutionPolicy({
                  reasoning: event.target.value as ReasoningLevel,
                })}
                className="mt-1.5 w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2 text-sm"
              >
                {reasoningSelectOptionsForModel(selectedModel, { imageMode: skillMode === 'image' }).map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {skillMode === 'image' || modelOmitsReasoningEffort(selectedModel) ? (
                <span className="mt-1 block text-[11px] text-muted">이미지 모델에서는 추론 수준을 쓰지 않습니다.</span>
              ) : null}
            </label>
            <label className="mt-3 block text-xs font-medium text-text">
              작업 방식
              <select
                data-testid="chat-workspace-behavior"
                value={activeExecutionPolicy.workspace_behavior ?? 'agent'}
                disabled={busy}
                onChange={(event) =>
                  void setExecutionPolicy({
                    workspace_behavior: event.target.value as WorkspaceBehavior,
                  })
                }
                className="mt-1.5 w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2 text-sm"
              >
                <option value="agent">Agent — 도구로 바로 실행</option>
                <option value="plan">Plan — 계획만 (수정 전 확인)</option>
                <option value="ask">Ask — 설명·질문 (도구 최소)</option>
              </select>
            </label>
            <p className="mt-1 text-[11px] leading-5 text-muted">
              Plan은 「작업 시 승인 요청」과 다릅니다. 위 항목은 에이전트 행동 방식, 아래는 위험 작업 승인입니다.
            </p>
            <label className="mt-3 block text-xs font-medium text-text">
              작업 권한
              <select
                data-testid="chat-approval-level"
                value={activeExecutionPolicy.approval}
                disabled={busy}
                onChange={(event) => {
                  const approval = event.target.value as ApprovalLevel;
                  void setExecutionPolicy({
                    approval,
                    autopilot: approval === 'autopilot' ? 'on' : approval === 'delegate' ? 'auto' : 'off',
                  });
                }}
                className="mt-1.5 w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2 text-sm"
              >
                <option value="autopilot">Autopilot — 안전 범위 완전 위임</option>
                <option value="delegate">나 대신 승인 — Luna가 위험 판단</option>
                <option value="ask">작업 시 승인 요청</option>
              </select>
            </label>
            <p className="mt-2 text-[11px] leading-5 text-muted">
              외부 쓰기·삭제·롤백·플러그인 변경·Office 원본 변경은 Luna에 위임하지 않고 사용자에게 확인합니다.
            </p>
            {effectiveExecutionPolicy ? (
              <p className="mt-3 rounded-lg bg-ink px-3 py-2 text-[11px] text-muted">
                최근 적용: 추론 {reasoningLabel(effectiveExecutionPolicy.reasoning)} · {approvalLabel(effectiveExecutionPolicy.approval)}
              </p>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-panel hover:text-text disabled:opacity-40"
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
          title={previewPaneOpen ? 'Preview 닫기' : 'Preview 열기'}
          onClick={() => setPreviewPaneOpen(!previewPaneOpen)}
          className={`rounded-md p-1 ${
            previewPaneOpen ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel hover:text-text'
          }`}
        >
          <Browser size={16} weight={previewPaneOpen ? 'bold' : 'regular'} />
        </button>
      </div>
      {apiError ? (
        <div className="border-b border-line bg-red-950/40 px-5 py-2 text-[12px] text-red-300">
          {apiError}
        </div>
      ) : null}

      {skillMode && skillLabel ? (
        <div className="flex items-center justify-between border-b border-line bg-accent/10 px-5 py-1.5 text-[11px] text-accent">
          <span>스킬 적용 중: {skillLabel}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent/20"
            onClick={() => setSkillMode(null)}
          >
            <X size={12} />
            해제
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto px-5 py-6"
        onContextMenu={openSessionMenu}
      >
        <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-5">
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
                  : String(modelOptions.find((option) => option.id === turn.model)?.label ?? turn.model ?? 'Assistant')
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
                {turn.role === 'assistant' && (turn.thought?.trim() || turn.streamPreview?.trim()) ? (
                  <details
                    className="group mb-3 border-b border-line/70 pb-3"
                    open={busy && !turn.completedAt}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-muted hover:text-text [&::-webkit-details-marker]:hidden">
                      <span>모델 응답</span>
                      <CaretDown
                        size={13}
                        className="transition-transform duration-150 group-open:rotate-180"
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="mt-3 space-y-3 border-l border-line/70 pl-3 text-[13px] leading-relaxed text-muted">
                      {turn.thought?.trim() ? (
                        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-text/75">
                          {turn.thought.trim()}
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
                {turn.streamPreview?.trim() ? (
                  <details
                    className="mb-3 rounded-xl border border-dashed border-line/70 bg-ink/25 px-3 py-2"
                    open={busy && turn.role === 'assistant'}
                  >
                    <summary className="cursor-pointer select-none text-[11px] tracking-[0.04em] text-muted">
                      스트림 미리보기 · 공식 답 아님
                      {busy && turn.role === 'assistant' ? ' · 생성 중' : ''}
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted/90">
                      {turn.streamPreview}
                    </pre>
                  </details>
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
                    ? `작업 중 · ${formatWorkDuration(turn.startedAt, undefined, clockNow) ?? '00:00'}`
                    : ''
                  : renderMessageText(turn.text)}
              </div>
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

      <div className="border-t border-line bg-panel/65 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto max-w-2xl">
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
            className={`overflow-hidden rounded-2xl border bg-ink/90 shadow-[0_8px_28px_rgba(0,0,0,0.16)] transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_8px_28px_rgba(0,0,0,0.2)] ${
              dragActive
                ? 'border-accent bg-accent/5 shadow-[0_0_0_1px_rgba(45,212,191,0.35)]'
                : 'border-line'
            }`}
          >
            {messageReferences.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-b border-line/60 px-3 pb-2 pt-2">
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
              <div className="flex flex-wrap gap-2 border-b border-line/60 px-3 pt-3">
                {pendingAttachments.map((a) => (
                  <div
                    key={a.id}
                    className="group relative flex items-center gap-2 rounded-xl border border-line bg-panel-2 px-2 py-1.5"
                  >
                    {a.previewUrl && isImageAttachment(a.mime, a.name) ? (
                      <img src={a.previewUrl} alt="" className="h-10 w-10 rounded-md object-cover" />
                    ) : isVideoAttachment(a.mime, a.name) ? (
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-accent">
                        <FilmStrip size={16} weight="bold" />
                      </span>
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-muted">
                        <FileIcon size={16} />
                      </span>
                    )}
                    <span className="max-w-[120px] truncate text-[11px] text-muted" title={a.name}>
                      {a.name}
                    </span>
                    <button
                      type="button"
                      className="rounded p-0.5 text-muted hover:bg-ink hover:text-text"
                      aria-label="첨부 제거"
                      onClick={() => void removePendingAttachment(a.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {pendingContextPaths.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-b border-line/60 px-3 pt-2 pb-2">
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
              rows={3}
              placeholder="할 일 입력… (@ 또는 피커로 파일 컨텍스트)"
              className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-text outline-none placeholder:text-muted/50"
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
                <div className="mb-1 text-[10px] font-semibold text-muted">대기 중 {activeQueue.length}</div>
                {activeQueue.map((item, index) => (
                  <div key={item.id} className="flex items-center gap-2 py-1 text-[11px] text-text">
                    <span className="text-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{item.text || item.attachmentNames.join(', ')}</span>
                    <button
                      type="button"
                      className="text-muted hover:text-red-300"
                      onClick={() => removeQueuedMessage(item.id)}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <div className="relative flex items-center gap-1.5">
                <button
                  type="button"
                  title="파일 추가"
                  disabled={attachDisabled}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-xl border border-line bg-panel-2/70 px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-accent/60 hover:bg-panel-2 hover:text-text disabled:opacity-40"
                >
                  <Paperclip size={14} weight="bold" />
                </button>
                <button
                  type="button"
                  title={skillMode && skillLabel ? `조직 스킬: ${skillLabel}` : '조직 스킬 선택'}
                  aria-label="조직 스킬 선택"
                  aria-expanded={skillPickerOpen}
                  data-testid="organization-skill-button"
                  onClick={() => setSkillPickerOpen((open) => !open)}
                  className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-[11px] font-medium ${
                    skillMode || skillPickerOpen
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-line bg-panel-2/70 text-muted hover:border-accent/60 hover:text-text'
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
                  className="inline-flex items-center gap-1 rounded-xl border border-line bg-panel-2/70 px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-accent/60 hover:bg-panel-2 hover:text-text"
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
                    className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-xl border border-line bg-panel p-2 shadow-xl"
                    data-testid="organization-skill-menu"
                  >
                    <div className="px-2 pb-1 text-[10px] font-semibold text-muted">조직 스킬</div>
                    {skillMode ? (
                      <button
                        type="button"
                        data-testid="organization-skill-clear"
                        className="mb-1 block w-full rounded-lg px-2 py-2 text-left text-xs text-muted hover:bg-panel-2 hover:text-text"
                        onClick={() => {
                          setSkillMode(null);
                          setSkillPickerOpen(false);
                        }}
                      >
                        <div className="font-medium">스킬 끄기</div>
                        <div className="mt-0.5 text-[10px] text-muted">현재 적용 중: {skillLabel ?? skillMode}</div>
                      </button>
                    ) : null}
                    {selectableSkills.length ? selectableSkills.map((skill) => (
                      <button
                        key={skill.mode}
                        type="button"
                        className={`block w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-panel-2 ${skillMode === skill.mode ? 'bg-accent/10 text-accent' : 'text-text'}`}
                        onClick={() => {
                          if (skillMode === skill.mode) {
                            setSkillMode(null);
                          } else {
                            setSkillMode(skill.mode, skill.label);
                          }
                          setSkillPickerOpen(false);
                        }}
                      >
                        <div className="font-medium">{skill.label}{skillMode === skill.mode ? ' · 사용 중' : ''}</div>
                        {skill.description ? <div className="mt-0.5 text-[10px] text-muted">{skill.description}</div> : null}
                      </button>
                    )) : <div className="px-2 py-2 text-[11px] text-muted">사용 가능한 조직 스킬이 없습니다.</div>}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                {showUndo ? (
                  <button
                    type="button"
                    title="마지막 턴 되돌리기"
                    onClick={() =>
                      void undoLastTurn().then((text) => {
                        if (text) setDraft(text);
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-xl border border-line bg-panel-2/70 px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-accent/60 hover:bg-panel-2 hover:text-text"
                  >
                    <ArrowUUpLeft size={14} weight="bold" />
                    Undo
                  </button>
                ) : null}
                {busy ? (
                  <>
                    <button
                      type="button"
                      disabled={!canSend}
                      onClick={submit}
                      title="현재 응답 다음에 실행"
                      className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-ink shadow-sm transition-colors hover:bg-accent/90 disabled:opacity-40"
                    >
                      <PaperPlaneTilt size={14} weight="fill" />
                      대기열 추가
                    </button>
                    <button
                    type="button"
                    onClick={() => stopAiMessage()}
                    title="생성 중지"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-panel-2/70 px-3 py-1.5 text-xs font-semibold text-text transition-colors hover:border-red-400/50 hover:bg-red-950/20 hover:text-red-300"
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
                    className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-ink shadow-sm transition-colors hover:bg-accent/90 disabled:opacity-40"
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
