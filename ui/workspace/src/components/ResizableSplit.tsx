import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Axis = 'horizontal' | 'vertical';

interface ResizableSplitProps {
  axis?: Axis;
  /** Initial size of the first pane in px */
  initial?: number;
  min?: number;
  max?: number;
  /** When true, `initial` applies to the second pane instead */
  reverse?: boolean;
  className?: string;
  collapsedSecond?: boolean;
  collapsedSize?: number;
  first: ReactNode;
  second: ReactNode;
}

export function ResizableSplit({
  axis = 'horizontal',
  initial = 360,
  min = 200,
  max = 720,
  reverse = false,
  className = '',
  collapsedSecond = false,
  collapsedSize = 0,
  first,
  second,
}: ResizableSplitProps) {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMove = useCallback(
    (client: number) => {
      const el = containerRef.current;
      if (!el || !dragging.current) return;
      const rect = el.getBoundingClientRect();
      const total = axis === 'horizontal' ? rect.width : rect.height;
      const raw = axis === 'horizontal' ? client - rect.left : client - rect.top;
      const next = reverse ? total - raw : raw;
      setSize(Math.min(max, Math.max(min, Math.min(total - 120, next))));
    },
    [axis, min, max, reverse],
  );

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      onMove(axis === 'horizontal' ? e.clientX : e.clientY);
    };
    const onPointerUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      delete document.body.dataset.panelResizing;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
    return () => {
      onPointerUp();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
    };
  }, [axis, onMove]);

  const startDrag = () => {
    dragging.current = true;
    document.body.dataset.panelResizing = 'true';
    document.body.style.cursor = axis === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const firstStyle =
    axis === 'horizontal'
      ? reverse
        ? { flex: '1 1 0%', minWidth: 0 }
        : { width: size, flex: '0 0 auto', minWidth: 0 }
      : reverse
        ? { flex: '1 1 0%', minHeight: 0 }
        : { height: size, flex: '0 0 auto', minHeight: 0 };

  const secondStyle =
    axis === 'horizontal'
      ? reverse
        ? { width: size, flex: '0 0 auto', minWidth: 0 }
        : { flex: '1 1 0%', minWidth: 0 }
      : reverse
        ? { height: size, flex: '0 0 auto', minHeight: 0 }
        : { flex: '1 1 0%', minHeight: 0 };

  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 min-w-0 ${axis === 'horizontal' ? 'flex-row' : 'flex-col'} ${className}`}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={firstStyle}>
        {first}
      </div>

      <div
        role="separator"
        aria-orientation={axis === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-label={axis === 'horizontal' ? '패널 너비' : '터미널 높이'}
        aria-valuemin={min} aria-valuemax={max}
        style={{ display: collapsedSecond ? 'none' : undefined }}
        aria-valuenow={Math.round(size)}
        tabIndex={0}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); startDrag(); }}
        onKeyDown={(e) => {
          const keys = axis === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
          if (!keys.includes(e.key)) return;
          e.preventDefault();
          const step = (e.shiftKey ? 40 : 16) * (reverse ? -1 : 1) * (e.key === keys[0] ? -1 : 1);
          setSize(s => Math.min(max, Math.max(min, s + step)));
        }}
        className={`group relative z-10 shrink-0 bg-line/40 transition hover:bg-accent ${
          axis === 'horizontal'
            ? 'w-1 cursor-col-resize hover:w-1.5'
            : 'h-1 cursor-row-resize hover:h-1.5'
        }`}
        title="드래그해서 너비 조절"
      >
        <span
          className={`pointer-events-none absolute rounded-full bg-accent/0 transition group-hover:bg-accent ${
            axis === 'horizontal'
              ? 'left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2'
              : 'left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2'
          }`}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ ...secondStyle, ...(collapsedSecond ? collapsedSize ? { height: collapsedSize, flex: '0 0 auto' } : { display: 'none' } : {}), maxHeight: axis === 'vertical' && !collapsedSecond ? '60%' : undefined }}>
        {second}
      </div>
    </div>
  );
}
