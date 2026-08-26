import {
  ArrowClockwise,
  DownloadSimple,
  PencilSimple,
} from '@phosphor-icons/react';
import {
  Handle,
  NodeResizer,
  Position,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { CanvasCardData } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  copyImageToClipboard,
  copyImageUrl,
  copyText,
  downloadImageUrl,
  guessImageFilename,
} from '../lib/mediaActions';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

type AssetCardNodeType = Node<CanvasCardData, 'assetCard'>;

const MIN_W = 200;
const MIN_H = 200;

function AssetCardInner({ id, data, selected }: NodeProps<AssetCardNodeType>) {
  const regenerateAsset = useWorkspaceStore((s) => s.regenerateAsset);
  const updateAssetPrompt = useWorkspaceStore((s) => s.updateAssetPrompt);
  const downloadAsset = useWorkspaceStore((s) => s.downloadAsset);
  const updateCanvasNodeSize = useWorkspaceStore((s) => s.updateCanvasNodeSize);
  const openImagePreview = useWorkspaceStore((s) => s.openImagePreview);
  const removeCanvasNode = useWorkspaceStore((s) => s.removeCanvasNode);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.prompt);
  const [hint, setHint] = useState<string | null>(null);
  const { menu, openAt, close } = useContextMenu();

  const isImage = data.kind === 'image' && Boolean(data.imageUrl);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint(null), 2500);
  }, []);

  const openCardMenu = useCallback(
    (e: ReactMouseEvent) => {
      const items: ContextMenuItem[] = [];
      if (isImage && data.imageUrl) {
        items.push(
          {
            id: 'preview',
            label: '크게 보기',
            onSelect: () =>
              openImagePreview({
                src: data.imageUrl!,
                title: data.label,
                prompt: data.prompt,
              }),
          },
          {
            id: 'copy-url',
            label: '이미지 주소 복사',
            onSelect: async () => {
              await copyImageUrl(data.imageUrl!);
              flash('이미지 주소를 복사했습니다.');
            },
          },
          {
            id: 'copy-image',
            label: '이미지 복사',
            onSelect: async () => {
              const kind = await copyImageToClipboard(data.imageUrl!);
              flash(kind === 'image' ? '이미지를 복사했습니다.' : '이미지 주소를 복사했습니다.');
            },
          },
          {
            id: 'save',
            label: '이미지 저장',
            onSelect: () =>
              downloadImageUrl(data.imageUrl!, guessImageFilename(data.label, data.imageUrl)),
          },
        );
      } else if (data.content?.trim()) {
        items.push({
          id: 'copy-text',
          label: '내용 복사',
          onSelect: async () => {
            await copyText(data.content || '');
            flash('내용을 복사했습니다.');
          },
        });
      }
      items.push({
        id: 'remove',
        label: '캔버스에서 제거',
        danger: true,
        onSelect: () => removeCanvasNode(id),
      });
      openAt(e, items);
    },
    [data, flash, id, isImage, openAt, openImagePreview, removeCanvasNode],
  );

  return (
    <>
      <NodeResizer
        minWidth={MIN_W}
        minHeight={MIN_H}
        isVisible={selected}
        color="#0f8f83"
        handleClassName="!size-2.5 !rounded-sm !border !border-accent !bg-ink"
        lineClassName="!border-accent/60"
        onResizeEnd={(_e, params) => {
          updateCanvasNodeSize(id, Math.round(params.width), Math.round(params.height));
        }}
      />

      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
        onContextMenu={openCardMenu}
      >
        <Handle type="target" position={Position.Left} className="!bg-accent !size-2.5 !border-0" />
        <Handle type="source" position={Position.Right} className="!bg-accent !size-2.5 !border-0" />

        <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            {data.kind}
          </span>
          <span className="truncate text-xs text-text/80">{data.label}</span>
        </div>

        {isImage ? (
          <button
            type="button"
            className="nodrag nopan relative min-h-0 flex-1 overflow-hidden bg-ink/40 text-left outline-none ring-inset focus-visible:ring-2 focus-visible:ring-accent"
            title="미리보기 · 우클릭"
            onClick={(e) => {
              e.stopPropagation();
              if (!data.imageUrl) return;
              openImagePreview({
                src: data.imageUrl,
                title: data.label,
                prompt: data.prompt,
              });
            }}
            onContextMenu={openCardMenu}
          >
            <img
              src={data.imageUrl}
              alt=""
              className="pointer-events-none h-full w-full object-cover transition hover:brightness-110"
              draggable={false}
            />
            <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-ink/70 px-2 py-0.5 text-[10px] text-muted backdrop-blur">
              미리보기
            </span>
          </button>
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto bg-ink/60 p-3 font-mono text-[10px] leading-relaxed text-muted">
            {(data.content ?? '').slice(0, 800)}
          </pre>
        )}

        <div className="shrink-0 space-y-2 border-t border-line p-3">
          {hint ? <p className="text-[10px] text-accent">{hint}</p> : null}
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                className="nodrag nowheel w-full resize-none rounded-lg border border-line bg-ink px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="nodrag rounded-md bg-accent px-2 py-1 text-xs font-semibold text-ink"
                  onClick={() => {
                    updateAssetPrompt(data.assetId, draft);
                    setEditing(false);
                  }}
                >
                  저장
                </button>
                <button
                  type="button"
                  className="nodrag rounded-md border border-line px-2 py-1 text-xs text-muted"
                  onClick={() => {
                    setDraft(data.prompt);
                    setEditing(false);
                  }}
                >
                  취소
                </button>
              </div>
            </div>
          ) : (
            <p className="line-clamp-2 text-[11px] text-muted">{data.prompt || '프롬프트 없음'}</p>
          )}

          <div className="flex gap-1">
            <button
              type="button"
              title={isImage ? '다시 생성' : '스탬프만'}
              className="nodrag inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[11px] text-text hover:border-accent"
              onClick={() => regenerateAsset(data.assetId)}
            >
              <ArrowClockwise size={14} weight="bold" />
              {isImage ? '재생성' : '스탬프'}
            </button>
            <button
              type="button"
              title="프롬프트 수정"
              className="nodrag inline-flex items-center justify-center rounded-md border border-line bg-panel-2 px-2 py-1.5 text-text hover:border-accent"
              onClick={() => setEditing(true)}
            >
              <PencilSimple size={14} weight="bold" />
            </button>
            <button
              type="button"
              title="다운로드"
              className="nodrag inline-flex items-center justify-center rounded-md border border-line bg-panel-2 px-2 py-1.5 text-text hover:border-accent"
              onClick={() => downloadAsset(data.assetId)}
            >
              <DownloadSimple size={14} weight="bold" />
            </button>
          </div>
        </div>
      </div>
      <ContextMenuPortal menu={menu} onClose={close} />
    </>
  );
}

export const AssetCardNode = memo(AssetCardInner);
