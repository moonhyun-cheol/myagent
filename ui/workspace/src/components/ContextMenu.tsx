import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { overlayViewport, usePointOverlay } from '../lib/useAnchoredOverlay';

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void | Promise<void>;
  children?: ContextMenuItem[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const openAt = (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const close = () => setMenu(null);

  return { menu, openAt, close, setMenu };
}

function ContextMenuEntry({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const hasChildren = !item.disabled && Boolean(item.children?.length);
  const entryRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!hasChildren) return;
    const entry = entryRef.current;
    const submenu = submenuRef.current;
    if (!entry || !submenu) return;
    let frame = 0;
    let remainingFrames = 0;
    const position = () => {
      const viewport = overlayViewport();
      const rect = entry.getBoundingClientRect();
      const openLeft = rect.right + submenu.offsetWidth + 8 > viewport.right;
      const top = Math.max(viewport.top - rect.top + 8, Math.min(0, viewport.bottom - rect.top - submenu.offsetHeight - 8));
      // Mutate both horizontal sides in the same layout pass. A state update can
      // leave the initial right-opening position visible for one frame while a
      // WebView2 window is settling after a mixed-DPI resize.
      submenu.style.left = openLeft ? 'auto' : '100%';
      submenu.style.right = openLeft ? '100%' : 'auto';
      submenu.style.top = `${Math.round(top)}px`;
    };
    const tick = () => {
      position();
      remainingFrames -= 1;
      if (remainingFrames > 0) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      remainingFrames = 4;
      frame = requestAnimationFrame(tick);
    };
    schedule();
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [hasChildren]);
  return (
    <div ref={entryRef} className="group relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup={hasChildren ? 'menu' : undefined}
        disabled={item.disabled}
        className={`flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-[13px] outline-none disabled:opacity-40 ${
          item.danger
            ? 'text-red-300 hover:bg-red-950/50'
            : 'text-text hover:bg-ink hover:text-accent'
        }`}
        onClick={() => {
          if (hasChildren || !item.onSelect) return;
          void Promise.resolve(item.onSelect()).finally(onClose);
        }}
      >
        <span>{item.label}</span>
        {hasChildren ? <span className="text-[11px] text-muted">›</span> : null}
      </button>
      {hasChildren ? (
        <div
          ref={submenuRef}
          role="menu"
          className="invisible absolute z-[301] min-w-[210px] rounded-xl border border-line bg-panel py-1 opacity-0 shadow-[0_16px_48px_rgba(0,0,0,0.45)] group-hover:visible group-hover:opacity-100"
          style={{ left: '100%', top: 0 }}
        >
          {item.children!.map((child) => (
            <ContextMenuEntry key={child.id} item={child} onClose={onClose} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ContextMenuPortal({
  menu,
  onClose,
  footer,
}: {
  menu: ContextMenuState | null;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = usePointOverlay(Boolean(menu), menu?.x ?? 0, menu?.y ?? 0, ref);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer, true);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[300] min-w-[210px] overflow-visible rounded-xl border border-line bg-panel py-1 shadow-[0_16px_48px_rgba(0,0,0,0.45)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item) => (
        <ContextMenuEntry key={item.id} item={item} onClose={onClose} />
      ))}
      {footer ? <div className="border-t border-line px-3 py-1.5 text-[10px] text-muted">{footer}</div> : null}
    </div>,
    document.body,
  );
}
