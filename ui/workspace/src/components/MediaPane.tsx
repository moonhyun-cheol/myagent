import {
  ArrowsOutSimple,
  Camera,
  DotsThreeVertical,
  DownloadSimple,
  FilmStrip,
  FolderSimple,
  Image as ImageIcon,
  Paperclip,
  Play,
  Sparkle,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { openWorkspaceFileWithDefaultApp } from '../lib/applicationAssociations';
import {
  copyImageToClipboard,
  copyImageUrl,
  copyText,
  downloadMediaItem,
  guessImageFilename,
  guessVideoFilename,
} from '../lib/mediaActions';
import {
  selectMediaItems,
  type MediaCatalogItem,
  type MediaFilter,
  type MediaOrigin,
} from '../lib/mediaCatalog';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

const FILTER_OPTIONS: ReadonlyArray<{ id: MediaFilter; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'generated', label: '생성됨' },
  { id: 'screenshot', label: '스크린샷' },
  { id: 'attachment', label: '첨부' },
  { id: 'workspace_file', label: '파일' },
  { id: 'video', label: '동영상' },
];

function originBadgeLabel(origin: MediaOrigin, kind: 'image' | 'video'): string {
  if (kind === 'video') return '동영상';
  switch (origin) {
    case 'generated':
      return '생성됨';
    case 'screenshot':
      return '스크린샷';
    case 'attachment':
      return '첨부';
    case 'workspace_file':
      return '파일';
    case 'video':
      return '동영상';
  }
}

function OriginIcon({ origin, kind }: { origin: MediaOrigin; kind: 'image' | 'video' }) {
  if (kind === 'video') return <FilmStrip size={11} weight="fill" />;
  switch (origin) {
    case 'generated':
      return <Sparkle size={11} weight="fill" />;
    case 'screenshot':
      return <Camera size={11} weight="fill" />;
    case 'attachment':
      return <Paperclip size={11} weight="bold" />;
    case 'workspace_file':
      return <FolderSimple size={11} weight="fill" />;
    case 'video':
      return <FilmStrip size={11} weight="fill" />;
  }
}

export function MediaPane() {
  const assets = useWorkspaceStore((state) => state.assets);
  const chat = useWorkspaceStore((state) => state.chat);
  const files = useWorkspaceStore((state) => state.files);
  const filesRoot = useWorkspaceStore((state) => state.filesRoot);
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const openImagePreview = useWorkspaceStore((state) => state.openImagePreview);
  const downloadAsset = useWorkspaceStore((state) => state.downloadAsset);
  const attachAssetToComposer = useWorkspaceStore((state) => state.attachAssetToComposer);
  const attachMediaUrlToComposer = useWorkspaceStore((state) => state.attachMediaUrlToComposer);
  const scrollToChatTurn = useWorkspaceStore((state) => state.scrollToChatTurn);
  const setMode = useWorkspaceStore((state) => state.setMode);

  const items = useMemo(
    () => selectMediaItems({ assets, chat, files, filesRoot, activeSessionId }),
    [assets, chat, files, filesRoot, activeSessionId],
  );

  const [filter, setFilter] = useState<MediaFilter>('all');
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hint, setHint] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const { menu, openAt, close } = useContextMenu();

  const flash = useCallback((msg: string) => {
    setHint(msg);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setHint(null);
      timerRef.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const counts = useMemo(() => {
    const map: Record<MediaFilter, number> = {
      all: items.length,
      generated: 0,
      screenshot: 0,
      attachment: 0,
      workspace_file: 0,
      video: 0,
    };
    for (const item of items) {
      if (item.kind === 'video') {
        map.video += 1;
      } else {
        map[item.origin] += 1;
      }
    }
    return map;
  }, [items]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'video') return items.filter((item) => item.kind === 'video');
    return items.filter((item) => item.origin === filter);
  }, [items, filter]);

  const markBroken = useCallback((id: string) => {
    setBrokenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const openExternal = useCallback(
    async (item: MediaCatalogItem) => {
      if (!item.sourcePath) {
        flash('이 미디어에는 로컬 파일 경로가 없습니다.');
        return;
      }
      try {
        await openWorkspaceFileWithDefaultApp(item.sourcePath);
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Windows 기본 앱을 실행하지 못했습니다.');
      }
    },
    [flash],
  );

  const handleDownload = useCallback(
    async (item: MediaCatalogItem) => {
      if (item.assetId) {
        downloadAsset(item.assetId);
        return;
      }
      const filename =
        item.kind === 'video'
          ? guessVideoFilename(item.title, item.previewUrl, item.sourcePath)
          : guessImageFilename(item.title, item.previewUrl, item.sourcePath);
      const ok = await downloadMediaItem({
        url: item.previewUrl,
        sourcePath: item.sourcePath,
        filename,
      });
      if (!ok) {
        flash('미디어를 다운로드하지 못했습니다.');
      }
    },
    [downloadAsset, flash],
  );

  const handleOpenPreview = useCallback(
    (item: MediaCatalogItem) => {
      if (item.previewUrl && !brokenIds.has(item.id)) {
        const previewable = filteredItems.filter((candidate) => candidate.previewUrl && !brokenIds.has(candidate.id));
        const idx = previewable.findIndex((candidate) => candidate.id === item.id);
        const galleryItems = previewable.map((candidate) => ({
          id: candidate.id,
          src: candidate.previewUrl!,
          title: candidate.title,
          prompt: candidate.prompt || '',
          kind: candidate.kind,
          origin: candidate.origin,
          sourcePath: candidate.sourcePath,
          assetId: candidate.assetId,
          turnId: candidate.turnId,
        }));
        openImagePreview({
          id: item.id,
          src: item.previewUrl,
          title: item.title,
          prompt: item.prompt || '',
          kind: item.kind,
          origin: item.origin,
          sourcePath: item.sourcePath,
          assetId: item.assetId,
          turnId: item.turnId,
          items: galleryItems,
          index: idx >= 0 ? idx : 0,
        });
        return;
      }
      if (item.sourcePath) {
        void openExternal(item);
        return;
      }
      flash('미리보기할 수 없는 미디어입니다.');
    },
    [brokenIds, filteredItems, openExternal, openImagePreview, flash],
  );

  const openItemMenu = useCallback(
    (e: ReactMouseEvent, item: MediaCatalogItem) => {
      e.preventDefault();
      e.stopPropagation();
      const menuItems: ContextMenuItem[] = [];

      if (item.previewUrl && !brokenIds.has(item.id)) {
        menuItems.push({
          id: 'preview',
          label: item.kind === 'video' ? '모달에서 재생' : '확대 미리보기',
          onSelect: () => handleOpenPreview(item),
        });
      }

      if (item.previewUrl || item.sourcePath) {
        menuItems.push({
          id: 'download',
          label: '다운로드',
          onSelect: () => void handleDownload(item),
        });
      }

      if (item.previewUrl && item.kind === 'image' && !brokenIds.has(item.id)) {
        menuItems.push({
          id: 'copy-image',
          label: '이미지 복사',
          onSelect: async () => {
            const kind = await copyImageToClipboard(item.previewUrl!);
            flash(kind === 'image' ? '이미지를 클립보드에 복사했습니다.' : '이미지 주소를 복사했습니다.');
          },
        });
      }

      if (item.previewUrl) {
        menuItems.push({
          id: 'copy-url',
          label: item.kind === 'video' ? '동영상 주소 복사' : '이미지 주소 복사',
          onSelect: async () => {
            await copyImageUrl(item.previewUrl!);
            flash('주소를 복사했습니다.');
          },
        });
      }

      if ((item.assetId || item.previewUrl || item.sourcePath) && item.kind === 'image') {
        menuItems.push({
          id: 'attach-chat',
          label: '채팅 입력창에 첨부',
          onSelect: async () => {
            let ok = true;
            if (item.assetId) {
              await attachAssetToComposer(item.assetId);
            } else {
              ok = await attachMediaUrlToComposer(item.previewUrl, item.title, item.sourcePath);
            }
            flash(ok ? '채팅 입력창에 첨부했습니다.' : '첨부하지 못했습니다. 원본을 불러올 수 없습니다.');
          },
        });
      }

      if (item.turnId) {
        menuItems.push({
          id: 'goto-turn',
          label: '대화 메시지로 이동',
          onSelect: () => scrollToChatTurn(item.turnId!),
        });
      }

      if (item.sourcePath) {
        menuItems.push({
          id: 'open-external',
          label: 'Windows 기본 앱으로 열기',
          onSelect: () => void openExternal(item),
        });
        menuItems.push({
          id: 'copy-path',
          label: '로컬 파일 경로 복사',
          onSelect: async () => {
            await copyText(item.sourcePath!);
            flash('로컬 파일 경로를 복사했습니다.');
          },
        });
      }

      if (menuItems.length > 0) {
        openAt(e, menuItems);
      }
    },
    [
      attachAssetToComposer,
      attachMediaUrlToComposer,
      brokenIds,
      flash,
      handleDownload,
      handleOpenPreview,
      openAt,
      openExternal,
      scrollToChatTurn,
    ],
  );

  if (!items.length) {
    return (
      <div className="flex h-full overflow-auto bg-panel">
        <div className="ui-empty">
          <FilmStrip size={36} className="text-accent" aria-hidden="true" />
          <h2>아직 미디어가 없습니다</h2>
          <p>대화에서 생성·첨부한 이미지와 동영상, 브라우저 캡처, 작업 폴더의 미디어 파일을 한곳에서 모아 봅니다.</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              className="ui-secondary"
              onClick={() => setMode('objects')}
            >
              작업 폴더 보기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="미디어 갤러리">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ImageIcon size={16} className="shrink-0 text-accent" weight="duotone" />
          <h2 className="truncate text-xs font-semibold text-text">미디어</h2>
          <span className="rounded bg-ink px-1.5 py-0.5 text-[10px] text-muted">{filteredItems.length}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="미디어 필터">
          {FILTER_OPTIONS.map((opt) => {
            const count = counts[opt.id];
            if (opt.id !== 'all' && count === 0) return null;
            const active = filter === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(opt.id)}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition ${
                  active
                    ? 'bg-accent/15 font-semibold text-accent ring-1 ring-accent/40'
                    : 'text-muted hover:bg-ink hover:text-text'
                }`}
              >
                <span>{opt.label}</span>
                <span className="text-[10px] opacity-75">{count}</span>
              </button>
            );
          })}
        </div>
      </header>
      {hint ? (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel-2/60 px-3 py-1.5 text-[11px] text-accent"
        >
          <span className="truncate">{hint}</span>
          <button
            type="button"
            onClick={() => setHint(null)}
            className="shrink-0 text-[10px] text-muted hover:text-text"
          >
            닫기
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {filteredItems.length === 0 ? (
          <div className="flex h-44 flex-col items-center justify-center gap-2 text-center text-xs text-muted">
            <p>선택한 분류에 해당하는 미디어가 없습니다.</p>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className="rounded border border-line px-2.5 py-1 text-[11px] text-text hover:border-accent/60"
            >
              전체 보기
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(175px,1fr))] gap-3">
            {filteredItems.map((item) => {
              const isBroken = brokenIds.has(item.id);
              const canOpen = Boolean((item.previewUrl && !isBroken) || item.sourcePath);
              const badge = originBadgeLabel(item.origin, item.kind);
              const subtitle =
                item.sourcePath ||
                (item.prompt ? `프롬프트 · ${item.prompt}` : item.subtitle || badge);

              return (
                <article
                  key={item.id}
                  onContextMenu={(e) => openItemMenu(e, item)}
                  onClick={() => {
                    if (canOpen) handleOpenPreview(item);
                  }}
                  role={canOpen ? 'button' : undefined}
                  tabIndex={canOpen ? 0 : -1}
                  onKeyDown={(e) => {
                    if (!canOpen) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleOpenPreview(item);
                    }
                  }}
                  title={
                    item.previewUrl && !isBroken
                      ? `${item.title} 미리보기`
                      : item.sourcePath
                        ? `${item.sourcePath} 열기`
                        : item.title
                  }
                  className={`group relative flex flex-col overflow-hidden rounded-lg border border-line bg-ink transition hover:border-accent/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                    canOpen ? 'cursor-pointer' : 'opacity-65'
                  }`}
                >
                  <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-panel-2">
                    {item.previewUrl && !isBroken ? (
                      item.kind === 'video' ? (
                        <>
                          <video
                            src={item.previewUrl}
                            preload="metadata"
                            muted
                            playsInline
                            onError={() => markBroken(item.id)}
                            className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                          />
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 transition group-hover:bg-black/35">
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-panel/90 text-text shadow">
                              <Play size={16} weight="fill" />
                            </span>
                          </span>
                        </>
                      ) : (
                        <img
                          src={item.previewUrl}
                          alt={item.title}
                          loading="lazy"
                          onError={() => markBroken(item.id)}
                          className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                        />
                      )
                    ) : isBroken ? (
                      <div className="flex flex-col items-center gap-1 px-2 text-center text-muted">
                        <WarningCircle size={24} className="text-amber-400/80" />
                        <span className="text-[11px]">미리보기를 불러올 수 없음</span>
                        {item.sourcePath ? (
                          <span className="text-[10px] text-accent">클릭하여 외부 앱으로 열기</span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1.5 text-muted">
                        <ImageIcon size={28} weight="duotone" className="text-accent/80" />
                        <span className="text-[11px]">로컬 미디어 파일</span>
                      </div>
                    )}

                    <span className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-panel/85 px-1.5 py-0.5 text-[10px] font-medium text-text shadow-sm backdrop-blur-sm">
                      <OriginIcon origin={item.origin} kind={item.kind} />
                      {badge}
                    </span>

                    {item.previewUrl && !isBroken && item.kind === 'image' ? (
                      <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-panel/85 px-1.5 py-0.5 text-[10px] text-text opacity-0 shadow backdrop-blur-sm transition-opacity group-hover:opacity-100">
                        <ArrowsOutSimple size={11} />
                        확대
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-1.5 border-t border-line/70 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-text">{item.title}</span>
                      <span className="block truncate text-[10px] text-muted">{subtitle}</span>
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {item.previewUrl || item.sourcePath ? (
                        <button
                          type="button"
                          title="다운로드"
                          aria-label={`${item.title} 다운로드`}
                          onClick={() => void handleDownload(item)}
                          className="rounded p-1 text-muted hover:bg-panel hover:text-text"
                        >
                          <DownloadSimple size={14} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title="더보기"
                        aria-label={`${item.title} 작업 메뉴`}
                        onClick={(e) => openItemMenu(e, item)}
                        className="rounded p-1 text-muted hover:bg-panel hover:text-text"
                      >
                        <DotsThreeVertical size={14} weight="bold" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      <ContextMenuPortal menu={menu} onClose={close} />
    </section>
  );
}
