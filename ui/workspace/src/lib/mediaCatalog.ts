import type { ChatTurn, FileNode, ImagePreviewPayload, MediaOrigin, WorkspaceAsset } from '../types';
import { guessImageFilename } from './mediaActions';
import { buildWorkspaceRawUrl, isVideoMediaUrl } from './mediaUrl';

export type { MediaOrigin };
export type MediaFilter = 'all' | 'generated' | 'screenshot' | 'attachment' | 'workspace_file' | 'video';

export interface MediaItem {
  id: string;
  assetId?: string;
  title: string;
  src: string;
  previewUrl: string;
  prompt?: string;
  subtitle?: string;
  sourcePath?: string;
  turnId?: string;
  createdAt: string;
  updatedAt?: string;
  modificationCount?: number;
  origin: MediaOrigin;
  mediaKind: 'image' | 'video';
  kind: 'image' | 'video';
}

export type MediaCatalogItem = MediaItem;

export const MEDIA_FILTER_LABELS: Record<MediaFilter, string> = {
  all: '전체',
  generated: '생성됨',
  screenshot: '스크린샷',
  attachment: '첨부',
  workspace_file: '작업 파일',
  video: '영상',
};

export const MEDIA_ORIGIN_BADGES: Record<MediaOrigin, string> = {
  generated: '생성됨',
  screenshot: '스크린샷',
  attachment: '첨부',
  workspace_file: '파일',
  video: '영상',
};

export function inferMediaOrigin(opts: {
  url?: string;
  sourcePath?: string;
  role?: 'user' | 'assistant';
  prompt?: string;
}): MediaOrigin {
  const url = opts.url || '';
  const path = opts.sourcePath || '';
  if (isVideoMediaUrl(url) || /\.(mp4|webm)$/i.test(path)) {
    return 'video';
  }
  if (opts.role === 'user' || url.startsWith('/attachments/')) {
    return 'attachment';
  }
  if (
    /\.playwright[\\/]/i.test(path) ||
    /\/outputs\/browser\//i.test(url) ||
    /screenshot/i.test(path) ||
    /screenshot/i.test(url) ||
    /스크린샷|화면\s*캡처|브라우저\s*캡처/i.test(opts.prompt || '')
  ) {
    return 'screenshot';
  }
  if (path && !url.startsWith('/outputs/images/')) {
    return 'workspace_file';
  }
  return 'generated';
}

function cleanDisplayTitle(rawTitle: string | undefined, url: string, sourcePath?: string, prompt?: string): string {
  if (sourcePath?.trim()) {
    const base = sourcePath.trim().split(/[\\/]/).pop();
    if (base) return base;
  }
  const trimmed = (rawTitle || '').trim();
  if (trimmed && trimmed !== 'From chat' && trimmed !== '세션 이미지' && trimmed !== '미리보기') {
    return trimmed;
  }
  if (prompt?.trim()) {
    const firstLine = prompt.trim().split(/\r?\n/)[0].trim();
    if (firstLine) {
      return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
    }
  }
  return guessImageFilename(undefined, url);
}

export interface SelectMediaItemsInput {
  assets: WorkspaceAsset[];
  chat: ChatTurn[];
  files?: FileNode[];
  filesRoot?: string | null;
  activeSessionId?: string | null;
}

const WORKSPACE_MEDIA_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm)$/i;

function collectWorkspaceMediaFiles(nodes: FileNode[] | undefined, out: FileNode[] = [], limit = 60): FileNode[] {
  if (!nodes || out.length >= limit) return out;
  for (const node of nodes) {
    if (out.length >= limit) break;
    if (node.kind === 'file') {
      if (WORKSPACE_MEDIA_FILE_RE.test(node.name)) {
        out.push(node);
      }
    } else if (node.children?.length) {
      collectWorkspaceMediaFiles(node.children, out, limit);
    }
  }
  return out;
}

/**
 * Derive a unified, deduplicated, newest-first media list from session assets, chat turns, and workspace files.
 */
export function selectMediaItems(
  assetsOrInput: WorkspaceAsset[] | SelectMediaItemsInput,
  chatArg?: ChatTurn[],
  activeSessionIdArg?: string | null,
): MediaItem[] {
  const assets = Array.isArray(assetsOrInput) ? assetsOrInput : assetsOrInput.assets;
  const chat = Array.isArray(assetsOrInput) ? (chatArg ?? []) : assetsOrInput.chat;
  const files = Array.isArray(assetsOrInput) ? undefined : assetsOrInput.files;
  const activeSessionId = Array.isArray(assetsOrInput) ? activeSessionIdArg : assetsOrInput.activeSessionId;

  const byKey = new Map<string, MediaItem>();

  const upsert = (key: string, candidate: MediaItem) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      return;
    }
    byKey.set(key, {
      ...existing,
      ...candidate,
      assetId: existing.assetId || candidate.assetId,
      sourcePath: existing.sourcePath || candidate.sourcePath,
      turnId: existing.turnId || candidate.turnId,
      prompt:
        existing.prompt && existing.prompt.length >= (candidate.prompt?.length ?? 0)
          ? existing.prompt
          : candidate.prompt || existing.prompt,
      title:
        existing.title && existing.title !== 'From chat' && existing.title !== '세션 이미지'
          ? existing.title
          : candidate.title,
      updatedAt: candidate.updatedAt || existing.updatedAt,
      modificationCount: candidate.modificationCount ?? existing.modificationCount,
    });
  };

  // 1. Collect image assets from workspaceStore.assets
  for (const asset of assets) {
    if (asset.kind !== 'image') continue;
    const canonicalPath = asset.sourcePath?.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    const resolvedSrc =
      asset.imageUrl?.trim() ||
      (canonicalPath ? buildWorkspaceRawUrl(canonicalPath, activeSessionId) : '');
    if (!resolvedSrc) continue;

    const mediaKind: 'image' | 'video' =
      asset.mediaKind || (isVideoMediaUrl(resolvedSrc) ? 'video' : 'image');
    const origin: MediaOrigin =
      asset.origin ||
      inferMediaOrigin({
        url: resolvedSrc,
        sourcePath: canonicalPath,
        prompt: asset.prompt,
      });
    const key = canonicalPath ? `path:${canonicalPath.toLowerCase()}` : `url:${resolvedSrc}`;
    upsert(key, {
      id: canonicalPath ? `file:${canonicalPath}` : `img:${resolvedSrc}`,
      assetId: asset.id,
      title: cleanDisplayTitle(asset.title, resolvedSrc, canonicalPath, asset.prompt),
      src: resolvedSrc,
      previewUrl: resolvedSrc,
      prompt: asset.prompt,
      sourcePath: canonicalPath,
      turnId: asset.turnId,
      createdAt: asset.createdAt || new Date().toISOString(),
      updatedAt: asset.updatedAt,
      modificationCount: asset.modificationCount,
      origin,
      mediaKind,
      kind: mediaKind,
    });
  }

  // 2. Collect media from chat turns (user image attachments, assistant generated images & videos)
  for (let i = 0; i < chat.length; i += 1) {
    const turn = chat[i];
    if (turn.uiHidden) continue;
    const prevUserPrompt =
      turn.role === 'assistant' && i > 0 && chat[i - 1]?.role === 'user'
        ? chat[i - 1].text
        : undefined;
    const turnCreatedAt = turn.completedAt || turn.startedAt || new Date(0).toISOString();
    const urls = Array.isArray(turn.imageUrls) ? turn.imageUrls : [];

    for (let uIdx = 0; uIdx < urls.length; uIdx += 1) {
      const url = urls[uIdx]?.trim();
      if (!url) continue;
      const mediaKind: 'image' | 'video' = isVideoMediaUrl(url) ? 'video' : 'image';
      const origin = inferMediaOrigin({
        url,
        role: turn.role,
        prompt: prevUserPrompt || turn.text,
      });
      const attachmentName =
        turn.role === 'user' && turn.attachmentNames?.[uIdx]
          ? turn.attachmentNames[uIdx]
          : undefined;
      const promptText =
        turn.role === 'user'
          ? turn.text
          : prevUserPrompt || turn.text;
      const key = `url:${url}`;
      upsert(key, {
        id: mediaKind === 'video' ? `vid:${url}` : `img:${url}`,
        assetId: turn.assetId,
        title: cleanDisplayTitle(attachmentName, url, undefined, promptText),
        src: url,
        previewUrl: url,
        prompt: promptText?.slice(0, 160),
        turnId: turn.id,
        createdAt: turnCreatedAt,
        origin,
        mediaKind,
        kind: mediaKind,
      });
    }
  }

  // 3. Collect media files from workspace explorer tree (if not already present)
  if (files?.length) {
    const mediaNodes = collectWorkspaceMediaFiles(files);
    for (const node of mediaNodes) {
      const canonicalPath = node.id.replace(/\\/g, '/').replace(/^\.\//, '').trim();
      if (!canonicalPath) continue;
      const key = `path:${canonicalPath.toLowerCase()}`;
      if (byKey.has(key)) continue;
      const resolvedSrc = buildWorkspaceRawUrl(canonicalPath, activeSessionId);
      const mediaKind: 'image' | 'video' = /\.(mp4|webm)$/i.test(canonicalPath) ? 'video' : 'image';
      const origin = inferMediaOrigin({ url: resolvedSrc, sourcePath: canonicalPath });
      upsert(key, {
        id: `file:${canonicalPath}`,
        title: node.name || canonicalPath.split('/').pop() || canonicalPath,
        src: resolvedSrc,
        previewUrl: resolvedSrc,
        sourcePath: canonicalPath,
        createdAt: new Date(0).toISOString(),
        origin,
        mediaKind,
        kind: mediaKind,
      });
    }
  }

  const list = Array.from(byKey.values());
  list.sort((a, b) => {
    const timeA = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const timeB = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    return timeB - timeA;
  });
  return list;
}

export function mediaItemToPreviewPayload(
  item: MediaItem,
  allItems?: MediaItem[],
): ImagePreviewPayload {
  const toSingle = (m: MediaItem): ImagePreviewPayload => ({
    id: m.id,
    assetId: m.assetId,
    src: m.src,
    title: m.title,
    prompt: m.prompt || '',
    mediaKind: m.mediaKind,
    origin: m.origin,
    sourcePath: m.sourcePath,
    turnId: m.turnId,
    createdAt: m.updatedAt || m.createdAt,
  });
  return {
    ...toSingle(item),
    items: allItems?.map(toSingle),
  };
}
