import { FilmStrip, Image as ImageIcon } from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { WorkspaceAsset } from '../types';
import { openWorkspaceFileWithDefaultApp } from '../lib/applicationAssociations';

function mediaFileName(asset: WorkspaceAsset): string {
  const path = asset.sourcePath?.trim();
  if (path) return path.split(/[\\/]/).pop() || asset.title;
  return asset.title;
}

export function MediaPane() {
  const allAssets = useWorkspaceStore((state) => state.assets);
  const assets = useMemo(() => allAssets.filter((asset) => asset.kind === 'image'), [allAssets]);
  const [hint, setHint] = useState<string | null>(null);

  const openAsset = useCallback(async (asset: WorkspaceAsset) => {
    if (!asset.sourcePath) {
      setHint('이 미디어에는 로컬 파일 경로가 없습니다.');
      return;
    }
    try {
      await openWorkspaceFileWithDefaultApp(asset.sourcePath);
    } catch (error) {
      setHint(error instanceof Error ? error.message : 'Windows 기본 앱을 실행하지 못했습니다.');
    }
  }, []);

  if (!assets.length) {
    return (
      <div className="flex h-full overflow-auto bg-ink">
        <div className="ui-empty">
          <FilmStrip size={36} className="text-accent" aria-hidden="true" />
          <h2>아직 이미지가 없습니다</h2>
          <p>이 대화에서 생성하거나 작업 결과로 등록된 이미지를 모아 보여줍니다.</p>
          <p>대화에서 이미지 생성을 요청하거나 작업 패널의 파일 목록을 확인하세요.</p>
          <button type="button" className="ui-secondary" onClick={() => useWorkspaceStore.getState().setMode('objects')}>작업 내역 보기</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-ink p-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">미디어</h2>
          <p className="text-sm text-muted">파일명을 누르면 Windows 기본 앱으로 엽니다.</p>
          {hint ? <p className="mt-1 text-xs text-accent">{hint}</p> : null}
        </div>
        <ImageIcon size={22} className="text-accent" weight="duotone" />
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() => void openAsset(asset)}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-panel2 disabled:cursor-not-allowed disabled:text-muted"
            disabled={!asset.sourcePath}
            title={asset.sourcePath ? `${asset.sourcePath} 열기` : '로컬 파일 경로 없음'}
          >
            <ImageIcon size={16} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">{mediaFileName(asset)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
