import { Code, FileText, Image as ImageIcon } from '@phosphor-icons/react';
import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ASSET_MIME, useWorkspaceStore } from '../store/workspaceStore';
import type { AssetKind, WorkspaceAsset } from '../types';
import { isCanvasAsset } from '../types';
import {
  copyImageToClipboard,
  copyImageUrl,
  copyText,
  downloadImageUrl,
  guessImageFilename,
} from '../lib/mediaActions';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

function KindIcon({ kind }: { kind: AssetKind }) {
  if (kind === 'image') return <ImageIcon size={16} weight="duotone" className="text-accent" />;
  if (kind === 'code') return <Code size={16} weight="duotone" className="text-accent" />;
  return <FileText size={16} weight="duotone" className="text-accent" />;
}

export function AssetGallery() {
  const assets = useWorkspaceStore((s) => s.assets).filter(
    (asset) => Boolean(asset.sourcePath || asset.imageUrl),
  );
  const placeAssetOnCanvas = useWorkspaceStore((s) => s.placeAssetOnCanvas);
  const openAssetInEditor = useWorkspaceStore((s) => s.openAssetInEditor);
  const openImagePreview = useWorkspaceStore((s) => s.openImagePreview);
  const downloadAsset = useWorkspaceStore((s) => s.downloadAsset);
  const { menu, openAt, close } = useContextMenu();
  const [hint, setHint] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint(null), 2500);
  }, []);

  const openAssetMenu = useCallback(
    (e: ReactMouseEvent, asset: WorkspaceAsset) => {
      const items: ContextMenuItem[] = [
        ...(isCanvasAsset(asset)
          ? [{
              id: 'canvas',
              label: asset.kind === 'image' ? '이미지 캔버스에서 열기' : '워크플로 캔버스에서 열기',
              onSelect: () => placeAssetOnCanvas(asset.id),
            }]
          : []),
        {
          id: 'editor',
          label: asset.kind === 'image' ? '캔버스에서 열기' : '에디터에서 열기',
          onSelect: () => openAssetInEditor(asset.id),
        },
      ];
      if (asset.kind === 'image' && asset.imageUrl) {
        const url = asset.imageUrl;
        items.unshift(
          {
            id: 'preview',
            label: '크게 보기',
            onSelect: () =>
              openImagePreview({ src: url, title: asset.title, prompt: asset.prompt || '' }),
          },
          {
            id: 'copy-url',
            label: '이미지 주소 복사',
            onSelect: async () => {
              await copyImageUrl(url);
              flash('이미지 주소를 복사했습니다.');
            },
          },
          {
            id: 'copy-image',
            label: '이미지 복사',
            onSelect: async () => {
              const kind = await copyImageToClipboard(url);
              flash(kind === 'image' ? '이미지를 복사했습니다.' : '이미지 주소를 복사했습니다.');
            },
          },
          {
            id: 'save',
            label: '이미지 저장',
            onSelect: () => downloadImageUrl(url, guessImageFilename(asset.title, url)),
          },
        );
      } else if (asset.content?.trim()) {
        items.push({
          id: 'copy',
          label: '내용 복사',
          onSelect: async () => {
            await copyText(asset.content || '');
            flash('내용을 복사했습니다.');
          },
        });
        items.push({
          id: 'download',
          label: '파일로 저장',
          onSelect: () => downloadAsset(asset.id),
        });
      }
      openAt(e, items);
    },
    [downloadAsset, flash, openAssetInEditor, openAt, openImagePreview, placeAssetOnCanvas],
  );

  return (
    <div className="flex h-full flex-col border-t border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Library</p>
          <p className="text-sm font-medium">결과물</p>
          {hint ? <p className="text-[10px] text-accent">{hint}</p> : null}
        </div>
        <span className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted">
          {assets.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {assets.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted">결과물 없음</p>
        ) : (
          assets.map((asset) => (
            <div
              key={asset.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_MIME, asset.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onContextMenu={(e) => openAssetMenu(e, asset)}
              className="cursor-grab rounded-lg border border-line bg-panel-2 p-2 active:cursor-grabbing"
            >
              <div className="mb-2 flex items-start gap-2">
                <KindIcon kind={asset.kind} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{asset.title}</p>
                  <p className="truncate text-[10px] text-muted">
                  {asset.kind === 'image' ? '이미지' : isCanvasAsset(asset) ? '워크플로' : asset.language || '파일'}
                </p>
                </div>
              </div>
              {asset.kind === 'image' && asset.imageUrl ? (
                <img src={asset.imageUrl} alt="" className="mb-2 h-20 w-full rounded-md object-cover" />
              ) : (
                <pre className="mb-2 max-h-16 overflow-hidden rounded-md bg-ink/70 p-2 font-mono text-[9px] text-muted">
                  {(asset.content ?? '').slice(0, 160)}
                </pre>
              )}
              <div className="flex gap-1">
                <button
                  type="button"
                  className="flex-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-text"
                  onClick={() => placeAssetOnCanvas(asset.id)}
                >
                  캔버스
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-text"
                  onClick={() => openAssetInEditor(asset.id)}
                >
                  에디터
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <ContextMenuPortal menu={menu} onClose={close} />
    </div>
  );
}
