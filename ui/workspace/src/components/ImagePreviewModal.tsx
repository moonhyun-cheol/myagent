import {
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  ChatCircleText,
  CopySimple,
  DownloadSimple,
  LinkSimple,
  Paperclip,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  copyImageToClipboard,
  copyImageUrl,
  copyText,
  downloadMediaItem,
  guessImageFilename,
  guessVideoFilename,
} from '../lib/mediaActions';
import { isVideoMediaUrl } from '../lib/mediaUrl';
import { openWorkspaceFileWithDefaultApp } from '../lib/applicationAssociations';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

/** Body portal — must NOT render inside React Flow transformed nodes */
export function ImagePreviewModal() {
  const preview = useWorkspaceStore((s) => s.imagePreview);
  const closeImagePreview = useWorkspaceStore((s) => s.closeImagePreview);
  const stepImagePreview = useWorkspaceStore((s) => s.stepImagePreview);
  const attachAssetToComposer = useWorkspaceStore((s) => s.attachAssetToComposer);
  const scrollToChatTurn = useWorkspaceStore((s) => s.scrollToChatTurn);
  const { menu, openAt, close } = useContextMenu();
  const [hint, setHint] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const timerRef = useRef<number | null>(null);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setHint(null);
      timerRef.current = null;
    }, 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    setLoadError(false);
  }, [preview?.src]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menu) close();
        else closeImagePreview();
        return;
      }
      if (preview.items && preview.items.length > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepImagePreview(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepImagePreview(1);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, closeImagePreview, stepImagePreview, menu, close]);

  if (!preview) return null;

  const isVideo = preview.kind === 'video' || isVideoMediaUrl(preview.src);
  const items = preview.items ?? [];
  const currentIndex = typeof preview.index === 'number' ? preview.index : -1;
  const hasMultiple = items.length > 1 && currentIndex >= 0;
  const currentItem = hasMultiple ? items[currentIndex] : undefined;

  const handleDownload = async () => {
    const filename = isVideo
      ? guessVideoFilename(preview.title, preview.src, preview.sourcePath)
      : guessImageFilename(preview.title, preview.src, preview.sourcePath);
    const ok = await downloadMediaItem({
      url: preview.src,
      sourcePath: preview.sourcePath,
      filename,
    });
    if (!ok) {
      flash('미디어를 저장하지 못했습니다.');
    }
  };

  const handleCopyImage = async () => {
    if (isVideo) {
      await copyImageUrl(preview.src);
      flash('동영상 주소를 복사했습니다.');
      return;
    }
    const kind = await copyImageToClipboard(preview.src);
    flash(kind === 'image' ? '이미지를 클립보드에 복사했습니다.' : '이미지 주소를 복사했습니다.');
  };

  const handleOpenExternal = async () => {
    if (!preview.sourcePath) return;
    try {
      await openWorkspaceFileWithDefaultApp(preview.sourcePath);
    } catch (error) {
      flash(error instanceof Error ? error.message : '기본 앱을 실행하지 못했습니다.');
    }
  };

  const handleAttachToChat = async () => {
    if (!currentItem?.assetId) return;
    await attachAssetToComposer(currentItem.assetId);
    flash('채팅 입력창에 첨부했습니다.');
  };

  const handleGoToTurn = () => {
    if (!preview.turnId) return;
    closeImagePreview();
    scrollToChatTurn(preview.turnId);
  };

  const openPreviewMenu = (e: ReactMouseEvent) => {
    const menuItems: ContextMenuItem[] = [
      {
        id: 'copy-url',
        label: isVideo ? '동영상 주소 복사' : '이미지 주소 복사',
        onSelect: async () => {
          await copyImageUrl(preview.src);
          flash('주소를 복사했습니다.');
        },
      },
      ...(!isVideo
        ? [
            {
              id: 'copy-image',
              label: '이미지 복사',
              onSelect: () => void handleCopyImage(),
            },
          ]
        : []),
      {
        id: 'save',
        label: isVideo ? '동영상 저장' : '이미지 저장',
        onSelect: () => void handleDownload(),
      },
      ...(preview.sourcePath
        ? [
            {
              id: 'open-external',
              label: '기본 앱으로 열기',
              onSelect: () => void handleOpenExternal(),
            },
            {
              id: 'copy-path',
              label: '로컬 경로 복사',
              onSelect: async () => {
                await copyText(preview.sourcePath!);
                flash('로컬 경로를 복사했습니다.');
              },
            },
          ]
        : []),
    ];
    openAt(e, menuItems);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4 sm:p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="미디어 미리보기"
      onClick={closeImagePreview}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="relative flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-text">
                {preview.title || '미리보기'}
              </p>
              {hasMultiple ? (
                <span className="shrink-0 rounded bg-ink px-1.5 py-0.5 text-[11px] text-muted">
                  {currentIndex + 1} / {items.length}
                </span>
              ) : null}
            </div>
            {preview.sourcePath ? (
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{preview.sourcePath}</p>
            ) : null}
            {preview.prompt ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">{preview.prompt}</p>
            ) : null}
            {hint ? (
              <p role="status" className="mt-1 text-[11px] font-medium text-accent">
                {hint}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!isVideo ? (
              <button
                type="button"
                onClick={() => void handleCopyImage()}
                title="이미지 복사"
                aria-label="이미지 복사"
                className=" inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-text"
              >
                <CopySimple size={14} />
                <span className="hidden sm:inline">복사</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await copyImageUrl(preview.src);
                  flash('주소를 복사했습니다.');
                }}
                title="주소 복사"
                aria-label="주소 복사"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-text"
              >
                <LinkSimple size={14} />
                <span className="hidden sm:inline">주소</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleDownload()}
              title="저장"
              aria-label="저장"
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-text"
            >
              <DownloadSimple size={14} />
              <span className="hidden sm:inline">저장</span>
            </button>
            {currentItem?.assetId && !isVideo ? (
              <button
                type="button"
                onClick={() => void handleAttachToChat()}
                title="채팅에 첨부"
                aria-label="채팅에 첨부"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-text"
              >
                <Paperclip size={14} />
                <span className="hidden sm:inline">첨부</span>
              </button>
            ) : null}
            {preview.turnId ? (
              <button
                type="button"
                onClick={handleGoToTurn}
                title="대화 메시지로 이동"
                aria-label="대화 메시지로 이동"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-text"
              >
                <ChatCircleText size={14} />
                <span className="hidden sm:inline">대화 위치</span>
              </button>
            ) : null}
            {preview.sourcePath ? (
              <button
                type="button"
                onClick={() => void handleOpenExternal()}
                title="Windows 기본 앱으로 열기"
                aria-label="Windows 기본 앱으로 열기"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-text"
              >
                <ArrowSquareOut size={14} />
                <span className="hidden sm:inline">외부 앱</span>
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-lg border border-line p-1.5 text-muted hover:border-accent hover:text-text"
              onClick={closeImagePreview}
              aria-label="닫기"
              title="닫기 (Esc)"
            >
              <X size={16} weight="bold" />
            </button>
          </div>
        </div>
        <div
          className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-auto bg-ink p-4"
          onContextMenu={openPreviewMenu}
        >
          {hasMultiple ? (
            <button
              type="button"
              onClick={() => stepImagePreview(-1)}
              aria-label="이전 미디어"
              title="이전 (←)"
              className="absolute left-3 z-10 rounded-full border border-line/80 bg-panel/85 p-2 text-text shadow-lg backdrop-blur-sm transition hover:border-accent hover:bg-panel"
            >
              <CaretLeft size={18} weight="bold" />
            </button>
          ) : null}

          {loadError ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-muted">
              <WarningCircle size={36} className="text-amber-400/90" />
              <p className="text-sm font-medium text-text">미디어를 불러올 수 없습니다</p>
              <p className="max-w-md break-all text-xs text-muted">
                {preview.sourcePath || preview.src}
              </p>
              {preview.sourcePath ? (
                <button
                  type="button"
                  onClick={() => void handleOpenExternal()}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs text-text hover:border-accent/60"
                >
                  <ArrowSquareOut size={14} />
                  Windows 기본 앱으로 열기
                </button>
              ) : null}
            </div>
          ) : isVideo ? (
            <video
              key={preview.src}
              src={preview.src}
              controls
              playsInline
              onError={() => setLoadError(true)}
              className="max-h-[min(75dvh,720px)] max-w-full rounded bg-black object-contain"
            />
          ) : (
            <img
              key={preview.src}
              src={preview.src}
              alt={preview.title || ''}
              onError={() => setLoadError(true)}
              className="max-h-[min(75dvh,720px)] max-w-full object-contain"
            />
          )}

          {hasMultiple ? (
            <button
              type="button"
              onClick={() => stepImagePreview(1)}
              aria-label="다음 미디어"
              title="다음 (→)"
              className="absolute right-3 z-10 rounded-full border border-line/80 bg-panel/85 p-2 text-text shadow-lg backdrop-blur-sm transition hover:border-accent hover:bg-panel"
            >
              <CaretRight size={18} weight="bold" />
            </button>
          ) : null}
        </div>
      </div>
      <ContextMenuPortal menu={menu} onClose={close} />
    </div>,
    document.body,
  );
}
