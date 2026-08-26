import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  return (
    <div className="group relative">
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
          role="menu"
          className="invisible absolute left-full top-0 z-[301] min-w-[210px] rounded-xl border border-line bg-panel py-1 opacity-0 shadow-[0_16px_48px_rgba(0,0,0,0.45)] group-hover:visible group-hover:opacity-100"
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
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const el = ref.current;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(menu.x, window.innerWidth - w - pad);
    const top = Math.min(menu.y, window.innerHeight - h - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [menu]);

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
      style={{ left: pos.left, top: pos.top }}
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
