import { useEffect, useRef, useState, type ReactNode } from 'react';

const WIDTH_KEY = 'my-agent.work-panel-width.v1';
const MIN_PANEL = 360;
const MIN_CHAT = 420;
const HANDLE = 6;
export type WorkPanelControls = { expanded: boolean; narrow: boolean; toggleExpanded: () => void; close: () => void };

/** Keep both children mounted: resizing/closing must not reset drafts, pages or running jobs. */
export function WorkPanelLayout({ open, onClose, chat, panel }: {
  open: boolean; onClose: () => void; chat: ReactNode;
  panel: (controls: WorkPanelControls) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const chatRoot = useRef<HTMLDivElement>(null);
  const panelRoot = useRef<HTMLDivElement>(null);
  const lastChatFocus = useRef<HTMLElement | null>(null);
  const lastPanelFocus = useRef<HTMLElement | null>(null);
  const [narrowView, setNarrowView] = useState<'chat' | 'panel'>('chat');
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState<number | null>(() => {
    try { const n = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(n) && n >= MIN_PANEL ? n : null; }
    catch { return null; }
  });
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const narrow = available < MIN_CHAT + MIN_PANEL + HANDLE;
  const max = Math.max(MIN_PANEL, available - MIN_CHAT - HANDLE);
  const width = Math.min(max, Math.max(MIN_PANEL, preferred ?? available * .45));
  const resize = (value: number | null) => {
    const next = value === null ? null : Math.min(max, Math.max(MIN_PANEL, value));
    setPreferred(next);
    try { if (next === null) localStorage.removeItem(WIDTH_KEY); else localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* optional preference */ }
  };
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const update = () => {
      setAvailable(el.clientWidth);
      // Resizing never silently hides the pane the user is currently reading.
      if (panelRoot.current?.contains(document.activeElement)) setNarrowView('panel');
      else if (chatRoot.current?.contains(document.activeElement)) setNarrowView('chat');
    };
    const observer = new ResizeObserver(update);
    observer.observe(el); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) { setExpanded(false); setDragging(false); setNarrowView('chat'); }
    else setNarrowView('panel');
  }, [open]);
  // Shrinking the window into narrow mode should surface exploration + chat first,
  // not the work panel — unless the user is actively reading the panel.
  const wasNarrow = useRef(narrow);
  useEffect(() => {
    if (narrow && !wasNarrow.current && !panelRoot.current?.contains(document.activeElement)) {
      setNarrowView('chat');
    }
    wasNarrow.current = narrow;
  }, [narrow]);
  useEffect(() => {
    if (!dragging) return;
    document.body.dataset.panelResizing = 'true';
    const stop = () => setDragging(false);
    window.addEventListener('blur', stop);
    return () => { delete document.body.dataset.panelResizing; window.removeEventListener('blur', stop); };
  }, [dragging]);
  const single = open && (expanded || narrow);
  const showChat = !open || (narrow ? narrowView === 'chat' : !expanded);
  const showPanel = open && (!narrow || narrowView === 'panel');
  const restoreFocus = (pane: 'chat' | 'panel') => requestAnimationFrame(() => {
    const last = pane === 'chat' ? lastChatFocus.current : lastPanelFocus.current;
    const container = pane === 'chat' ? chatRoot.current : panelRoot.current;
    (last?.isConnected && container?.contains(last) ? last : container)?.focus({ preventScroll: true });
  });
  const close = () => { onClose(); restoreFocus('chat'); };
  return (
    <div ref={root} className="flex h-full min-h-0 min-w-0 flex-col" data-work-panel-layout data-single-panel={single} data-panel-open={open}>
      {open && narrow && <nav className="narrow-surface-switch" aria-label="대화와 작업 화면 전환">
        <button type="button" className="ui-secondary" aria-pressed={showChat} onClick={() => { setNarrowView('chat'); restoreFocus('chat'); }}>대화</button>
        <button type="button" className="ui-secondary" aria-pressed={showPanel} onClick={() => { setNarrowView('panel'); restoreFocus('panel'); }}>작업 화면</button>
      </nav>}
      <div className="flex min-h-0 min-w-0 flex-1">
      <div ref={chatRoot} tabIndex={-1} aria-label="대화 화면" onFocusCapture={e => { lastChatFocus.current = e.target; }} className="h-full min-h-0 min-w-0 flex-1" style={{ display: showChat ? undefined : 'none' }}>{chat}</div>
      {open && !single && <div
        role="separator" aria-label="작업 패널 너비" aria-orientation="vertical"
        aria-valuemin={MIN_PANEL} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(width)}
        tabIndex={0} title="드래그: 너비 조절 · 더블클릭: 기본 비율 · 방향키: 조절"
        className="relative z-30 w-[6px] shrink-0 cursor-col-resize touch-none bg-line/40 hover:bg-accent focus-visible:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onDoubleClick={() => resize(null)}
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
        onPointerMove={e => { if (dragging && root.current) resize(root.current.getBoundingClientRect().right - e.clientX); }}
        onPointerUp={e => { setDragging(false); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
        onKeyDown={e => {
          const step = e.shiftKey ? 40 : 16;
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key)) return;
          e.preventDefault();
          resize(e.key === 'Home' ? MIN_PANEL : e.key === 'End' ? max : e.key === 'Enter' ? null : width + (e.key === 'ArrowLeft' ? step : -step));
        }}
      />}
      <div ref={panelRoot} tabIndex={-1} aria-label="작업 화면" onFocusCapture={e => { lastPanelFocus.current = e.target; }} className="h-full min-h-0 min-w-0 overflow-hidden" data-work-panel style={{ display: showPanel ? undefined : 'none', width: single ? '100%' : width, flex: '0 0 auto' }}>
        {panel({ expanded, narrow, toggleExpanded: () => { setExpanded(v => !v); if (expanded) restoreFocus('chat'); }, close })}
      </div>
      </div>
    </div>
  );
}
