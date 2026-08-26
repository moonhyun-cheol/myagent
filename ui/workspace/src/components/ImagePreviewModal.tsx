import { X } from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  copyImageToClipboard,
  copyImageUrl,
  downloadImageUrl,
  guessImageFilename,
} from '../lib/mediaActions';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

/** Body portal — must NOT render inside React Flow transformed nodes */
export function ImagePreviewModal() {
  const preview = useWorkspaceStore((s) => s.imagePreview);
  const closeImagePreview = useWorkspaceStore((s) => s.closeImagePreview);
  const { menu, openAt, close } = useContextMenu();
  const [hint, setHint] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint(null), 2500);
  }, []);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menu) close();
        else closeImagePreview();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, closeImagePreview, menu, close]);

  if (!preview) return null;

  const openPreviewMenu = (e: ReactMouseEvent) => {
    const items: ContextMenuItem[] = [
      {
        id: 'copy-url',
        label: '이미지 주소 복사',
        onSelect: async () => {
          await copyImageUrl(preview.src);
          flash('이미지 주소를 복사했습니다.');
        },
      },
      {
        id: 'copy-image',
        label: '이미지 복사',
        onSelect: async () => {
          const kind = await copyImageToClipboard(preview.src);
          flash(kind === 'image' ? '이미지를 복사했습니다.' : '이미지 주소를 복사했습니다.');
        },
      },
      {
        id: 'save',
        label: '이미지 저장',
        onSelect: () =>
          downloadImageUrl(preview.src, guessImageFilename(preview.title, preview.src)),
      },
    ];
    openAt(e, items);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="이미지 미리보기"
      onClick={closeImagePreview}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="relative flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{preview.title || '미리보기'}</p>
            {preview.prompt ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">{preview.prompt}</p>
            ) : null}
            {hint ? <p className="mt-1 text-[11px] text-accent">{hint}</p> : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-line p-1.5 text-muted hover:border-accent hover:text-text"
            onClick={closeImagePreview}
            aria-label="닫기"
          >
            <X size={16} weight="bold" />
          </button>
        </div>
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-ink p-4"
          onContextMenu={openPreviewMenu}
        >
          <img
            src={preview.src}
            alt=""
            className="max-h-[min(75dvh,720px)] max-w-full object-contain"
          />
        </div>
      </div>
      <ContextMenuPortal menu={menu} onClose={close} />
    </div>,
    document.body,
  );
}
