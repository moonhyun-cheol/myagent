import { Image as ImageIcon, FilmStrip } from '@phosphor-icons/react';
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { WorkspaceAsset } from '../types';
import {
  copyImageToClipboard,
  copyImageUrl,
  downloadImageUrl,
  guessImageFilename,
} from '../lib/mediaActions';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

export function MediaPane() {
  const allAssets = useWorkspaceStore((s) => s.assets);
  const placeAssetOnCanvas = useWorkspaceStore((s) => s.placeAssetOnCanvas);
  const openImagePreview = useWorkspaceStore((s) => s.openImagePreview);
  const assets = useMemo(
    () => allAssets.filter((a) => a.kind === 'image'),
    [allAssets],
  );
  const { menu, openAt, close } = useContextMenu();
  const [hint, setHint] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint(null), 2500);
  }, []);

  const openAssetMenu = useCallback(
    (e: ReactMouseEvent, asset: WorkspaceAsset) => {
      if (!asset.imageUrl) return;
      const url = asset.imageUrl;
      const items: ContextMenuItem[] = [
        {
          id: 'preview',
          label: '크게 보기',
          onSelect: () =>
            openImagePreview({ src: url, title: asset.title, prompt: asset.prompt || '' }),
        },
        {
          id: 'canvas',
          label: '캔버스에 배치',
          onSelect: () => placeAssetOnCanvas(asset.id),
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
      ];
      openAt(e, items);
    },
    [flash, openAt, openImagePreview, placeAssetOnCanvas],
  );

  if (!assets.length) {
    return (
      <div className="grid h-full place-items-center bg-ink text-sm text-muted">
        <div className="flex flex-col items-center gap-3">
          <FilmStrip size={36} className="text-line" />
          <p>이미지 없음 · 채팅에서 요청</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-ink p-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">미디어</h2>
          <p className="text-sm text-muted">클릭 · 우클릭</p>
          {hint ? <p className="mt-1 text-xs text-accent">{hint}</p> : null}
        </div>
        <ImageIcon size={22} className="text-accent" weight="duotone" />
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() => placeAssetOnCanvas(asset.id)}
            onContextMenu={(e) => openAssetMenu(e, asset)}
            className="group overflow-hidden rounded-xl border border-line bg-panel text-left transition hover:border-accent"
          >
            <img
              src={asset.imageUrl}
              alt=""
              className="aspect-[16/10] w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            />
            <div className="space-y-1 p-3">
              <p className="text-sm font-medium">{asset.title}</p>
              <p className="line-clamp-2 text-xs text-muted">{asset.prompt}</p>
            </div>
          </button>
        ))}
      </div>
      <ContextMenuPortal menu={menu} onClose={close} />
    </div>
  );
}
