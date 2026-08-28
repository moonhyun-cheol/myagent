export type WorkspaceMode = 'editor' | 'objects' | 'canvas' | 'media' | 'browser';

export type AiWorkMode = 'text' | 'code' | 'image';

export type AssetKind = 'image' | 'code' | 'document';

export interface FileNode {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  children?: FileNode[];
  language?: string;
}

export interface WorkspaceAsset {
  id: string;
  kind: AssetKind;
  title: string;
  prompt?: string;
  createdAt: string;
  /** Final workspace-relative path for a file result. Never use the display id as a path. */
  sourcePath?: string;
  updatedAt?: string;
  modificationCount?: number;
  imageUrl?: string;
  content?: string;
  language?: string;
}

/** 캔버스는 시각 자료와 워크플로 문서만 받는다. 일반 코드는 에디터에서 연다. */
export function isCanvasAsset(asset: Pick<WorkspaceAsset, 'kind' | 'language' | 'title' | 'content'>): boolean {
  if (asset.kind === 'image') return true;
  const language = (asset.language ?? '').toLowerCase();
  const title = asset.title.toLowerCase();
  const content = asset.content ?? '';
  return (
    language === 'mermaid' ||
    /\.(mmd|mermaid)$/i.test(title) ||
    /```mermaid\b/i.test(content) ||
    /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b/m.test(content)
  );
}

export interface PendingAttachment {
  id: string;
  name: string;
  mime?: string;
  /** Local object URL for chip preview (revoked on remove/send) */
  previewUrl?: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  mode: AiWorkMode;
  text: string;
  /** Model id/name used for this specific assistant response. */
  model?: string;
  /** ISO timestamp when this assistant execution started. */
  startedAt?: string;
  /** ISO timestamp when this assistant execution finished. */
  completedAt?: string;
  /** Transient per-call progress shown only while this response is running. */
  progressSteps?: string[];
  /** Agent status / model thought stream (SSE `thought`) */
  thought?: string;
  /**
   * Live model token stream while tools/agent run (not the final answer).
   * Cleared when final content_replace / done arrives. Code agent only.
   */
  streamPreview?: string;
  assetId?: string;
  /** Generated / restored image URLs shown inline in the chat bubble */
  imageUrls?: string[];
  /** User-turn attachment labels (display only) */
  attachmentNames?: string[];
}

export interface CanvasCardData extends Record<string, unknown> {
  assetId: string;
  label: string;
  kind: AssetKind;
  prompt: string;
  imageUrl?: string;
  content?: string;
  cardWidth?: number;
  cardHeight?: number;
}

