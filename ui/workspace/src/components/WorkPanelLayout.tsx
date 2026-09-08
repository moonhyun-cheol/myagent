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
    const observer = new ResizeObserver(() => setAvailable(el.clientWidth));
    observer.observe(el); setAvailable(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) { setExpanded(false); setDragging(false); }
  }, [open]);
  useEffect(() => {
    if (!dragging) return;
    document.body.dataset.panelResizing = 'true';
    const stop = () => setDragging(false);
    window.addEventListener('blur', stop);
    return () => { delete document.body.dataset.panelResizing; window.removeEventListener('blur', stop); };
  }, [dragging]);
  const single = open && (expanded || narrow);
  return (
    <div ref={root} className="flex h-full min-h-0 min-w-0" data-work-panel-layout data-single-panel={single}>
      <div className="h-full min-h-0 min-w-0 flex-1" style={{ display: single ? 'none' : undefined }}>{chat}</div>
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
      <div className="h-full min-h-0 min-w-0 overflow-hidden" data-work-panel style={{ display: open ? undefined : 'none', width: single ? '100%' : width, flex: '0 0 auto' }}>
        {panel({ expanded, narrow, toggleExpanded: () => setExpanded(v => !v), close: onClose })}
      </div>
    </div>
  );
}
