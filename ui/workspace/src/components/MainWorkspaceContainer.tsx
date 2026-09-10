import { useEffect, useId, useState } from 'react';
import { ArrowsInSimple, ArrowsOutSimple, TerminalWindow, X } from '@phosphor-icons/react';
import type { WorkspaceMode } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { BrowserPane } from './BrowserPane';
import { APP_PREFERENCES_CHANGED_EVENT, syncMinimizeToTrayOnClose } from '../lib/appPreferences';
import { listAutomationFeed, markAutomationFeedRead } from '../api/myAgentClient';
import { subscribeInAppBrowserActivation } from '../lib/inAppBrowserBridge';
import { ChatPane } from './ChatPane';
import { GeminiNavSidebar, type AppSurface } from './GeminiNavSidebar';
import { ImagePreviewModal } from './ImagePreviewModal';
import { ConfirmModal } from './ConfirmModal';
import { MarkdownDocument } from './MarkdownDocument';
import { MediaPane } from './MediaPane';
import { DocumentPane } from './DocumentPane';
import { ResizableSplit } from './ResizableSplit';
import { WorkPanelLayout, type WorkPanelControls } from './WorkPanelLayout';
import { isAvailableWorkspacePreviewMode, resolveAvailableWorkspacePreviewMode, WORKSPACE_PREVIEW_MODES } from './workspacePreviewModes';
import { SchedulerSurface } from './SchedulerSurface';
import { TerminalPane } from './TerminalPane';
import { WorkspaceObjectsPane } from './WorkspaceObjectsPane';
import { useSessionTodos } from '../lib/useSessionTodos';
import { navigateTabs } from '../lib/tabNavigation';

const EDITING_ONLY_CTRL_KEYS = new Set(['a', 'v', 'x', 'y', 'z']);
const BLOCKED_BROWSER_CTRL_KEYS = new Set(['d', 'h', 'j', 'l', 'n', 'o', 'r', 't', 'u', 'w', '+', '-', '0']);
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null;
}

function PreviewPane({ controls }: { controls?: WorkPanelControls }) {
  const tabId = useId();
  const mode = useWorkspaceStore(s => s.mode);
  const setMode = useWorkspaceStore(s => s.setMode);
  const terminalOpen = useWorkspaceStore(s => s.terminalOpen);
  const terminalAttention = useWorkspaceStore(s => s.terminalAttention);
  const terminalBusy = useWorkspaceStore(s => s.terminalBusy);
  const setTerminalOpen = useWorkspaceStore(s => s.setTerminalOpen);
  const refreshExplorer = useWorkspaceStore(s => s.refreshExplorer);
  const activeSessionId = useWorkspaceStore(s => s.activeSessionId);
  const busy = useWorkspaceStore(s => s.busy);
  const { items: todoItems, error: todoError } = useSessionTodos(activeSessionId, busy);
  useEffect(() => { void refreshExplorer(); }, [refreshExplorer]);
  useEffect(() => {
    const availableMode = resolveAvailableWorkspacePreviewMode(mode);
    if (availableMode !== mode) setMode(availableMode);
  }, [mode, setMode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const editing = isTextEditingTarget(e.target);
      if ((e.ctrlKey || e.metaKey) && EDITING_ONLY_CTRL_KEYS.has(key) && !editing) {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if (((e.ctrlKey || e.metaKey) && BLOCKED_BROWSER_CTRL_KEYS.has(key))
        || (!editing && (e.key === 'BrowserBack' || e.key === 'BrowserForward' || e.key === 'Backspace'))
        || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) || e.key === 'F5' || e.key === 'F12') {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault(); setTerminalOpen(!useWorkspaceStore.getState().terminalOpen);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setTerminalOpen]);
  const body = <div id={`${tabId}-body`} role="tabpanel" aria-labelledby={`${tabId}-${mode}`} className="relative h-full min-h-0" data-work-panel-body>
    {mode === 'objects' && <WorkspaceObjectsPane showDownloadActions todoItems={todoItems} todoError={todoError} />}
    {(mode === 'document' || mode === 'canvas') && <MarkdownDocument />}
    {mode === 'codocument' && <div className="h-full min-h-0 overflow-auto"><DocumentPane /></div>}
    {mode === 'media' && <MediaPane />}
    {mode === 'browser' && <BrowserPane />}
  </div>;
  return <section className="flex h-full min-h-0 min-w-0 flex-col bg-panel" aria-label="작업 패널" data-preview-pane tabIndex={-1}>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-line px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-0.5" role="tablist" aria-label="작업 패널 보기" onKeyDown={navigateTabs}>
        {WORKSPACE_PREVIEW_MODES.map(({ id, label, icon: Icon, disabled, disabledReason }) => <button
          key={id} type="button" onClick={() => { if (isAvailableWorkspacePreviewMode(id)) setMode(id); }}
          disabled={disabled} title={disabledReason} role="tab" id={`${tabId}-${id}`} aria-controls={`${tabId}-body`} aria-selected={mode === id} tabIndex={mode === id ? 0 : -1}
          className="ui-tab"
        ><Icon size={14} />{label}</button>)}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => setTerminalOpen(!terminalOpen)} aria-label="터미널" aria-pressed={terminalOpen}
          title={terminalOpen ? '터미널 접기 (Ctrl+`)' : '터미널 열기 (Ctrl+`)'}
          className={`inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs ${terminalOpen || terminalAttention || terminalBusy ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-hover'}`}>
          <TerminalWindow size={16} />{terminalBusy ? '실행 중' : '터미널'}
        </button>
        {controls && <>
          {!controls.narrow && <button type="button" onClick={controls.toggleExpanded} aria-label={controls.expanded ? '분할 보기로 복원' : '작업 패널 확대'} title={controls.expanded ? '분할 보기로 복원' : '작업 패널 확대'} className="rounded-md p-2 text-muted hover:bg-hover">
            {controls.expanded ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
          </button>}
          <button type="button" onClick={controls.close} aria-label={controls.narrow ? '채팅으로 돌아가기' : '작업 패널 닫기'} title="채팅으로 돌아가기" className="rounded-md p-2 text-muted hover:bg-hover"><X size={16} /></button>
        </>}
      </div>
    </div>
    <div className="min-h-0 flex-1">
      <ResizableSplit axis="vertical" reverse initial={200} min={120} max={520} className="h-full"
        collapsedSecond={!terminalOpen} collapsedSize={38} first={body} second={<TerminalPane />} />
    </div>
  </section>;
}

export function MainWorkspaceContainer() {
  const previewPaneOpen = useWorkspaceStore(s => s.previewPaneOpen);
  const setPreviewPaneOpen = useWorkspaceStore(s => s.setPreviewPaneOpen);
  const setMode = useWorkspaceStore(s => s.setMode);
  const [activeSurface, setActiveSurface] = useState<AppSurface>('chat');
  const [automationUnread, setAutomationUnread] = useState(0);
  const detachedMode = new URLSearchParams(window.location.search).get('preview') as WorkspaceMode | null;
  useEffect(() => {
    const syncPreference = () => syncMinimizeToTrayOnClose();
    syncPreference();
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, syncPreference);
    return () => window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, syncPreference);
  }, []);
  useEffect(() => {
    if (isAvailableWorkspacePreviewMode(detachedMode)) setMode(detachedMode);
  }, [detachedMode, setMode]);
  useEffect(() => subscribeInAppBrowserActivation(url => {
    const store = useWorkspaceStore.getState();
    store.navigateBrowser(url); store.setMode('browser'); store.setPreviewPaneOpen(true); setActiveSurface('chat');
  }), []);
  useEffect(() => {
    const onNav = () => setActiveSurface('chat');
    window.addEventListener('my-agent:navigate-chat', onNav);
    return () => window.removeEventListener('my-agent:navigate-chat', onNav);
  }, []);
  // Poll unread automation results/errors every 10s for the dock badge.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const feed = await listAutomationFeed(100);
        if (active) {
          setAutomationUnread(feed.filter(
            (item) => (item.kind === 'result' || item.kind === 'error') && item.read_at === null,
          ).length);
        }
      } catch { /* ignore transient feed errors */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  // Entering the automation surface marks the feed read and clears the badge.
  useEffect(() => {
    if (activeSurface !== 'scheduler') return;
    let active = true;
    void markAutomationFeedRead().then(() => { if (active) setAutomationUnread(0); }).catch(() => { /* ignore */ });
    return () => { active = false; };
  }, [activeSurface]);
  // Hide the reserved surface without stopping the page or losing its history.
  const closePanel = () => setPreviewPaneOpen(false);
  if (isAvailableWorkspacePreviewMode(detachedMode)) return <div className="h-full min-h-0 bg-ink text-text"><PreviewPane /><ImagePreviewModal /><ConfirmModal /></div>;
  return <div className="flex h-full min-h-0 flex-col bg-ink text-text">
    <div className="flex min-h-0 flex-1">
      <GeminiNavSidebar activeSurface={activeSurface} onSurfaceChange={setActiveSurface} automationUnreadCount={automationUnread} />
      <div className="min-h-0 min-w-0 flex-1">
        <div className={activeSurface === 'chat' ? 'h-full min-h-0' : 'hidden'} aria-hidden={activeSurface !== 'chat'}>
          <WorkPanelLayout open={previewPaneOpen} onClose={closePanel} chat={<ChatPane />} panel={controls => <PreviewPane controls={controls} />} />
        </div>
        <div className={activeSurface === 'scheduler' ? 'h-full min-h-0' : 'hidden'} aria-hidden={activeSurface !== 'scheduler'}><SchedulerSurface /></div>
      </div>
    </div>
    <ImagePreviewModal /><ConfirmModal />
  </div>;
}
