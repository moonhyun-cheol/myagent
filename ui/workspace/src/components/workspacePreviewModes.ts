import { ArticleNyTimes, Briefcase, Browser, ImageSquare, type Icon } from '@phosphor-icons/react';
import type { WorkspaceMode } from '../types';

export type WorkspacePreviewMode = Exclude<WorkspaceMode, 'editor' | 'canvas'>;

export interface WorkspacePreviewDefinition {
  id: WorkspacePreviewMode;
  label: string;
  icon: Icon;
  disabled?: boolean;
  disabledReason?: string;
}

/** 우측 Preview 탭의 순서, 표시, 가용성은 이 목록에서만 관리한다. */
export const WORKSPACE_PREVIEW_MODES: readonly WorkspacePreviewDefinition[] = [
  { id: 'objects', label: '작업', icon: Briefcase },
  { id: 'document', label: '문서', icon: ArticleNyTimes },
  { id: 'media', label: '미디어', icon: ImageSquare },
  { id: 'browser', label: '웹', icon: Browser },
];

export function isAvailableWorkspacePreviewMode(value: string | null): value is WorkspacePreviewMode {
  return WORKSPACE_PREVIEW_MODES.some((definition) => definition.id === value && !definition.disabled);
}

export function resolveAvailableWorkspacePreviewMode(mode: WorkspaceMode): WorkspacePreviewMode {
  if (mode === 'editor') return 'browser';
  if (mode === 'canvas') return 'document';
  const definition = WORKSPACE_PREVIEW_MODES.find((item) => item.id === mode);
  return definition?.disabled ? 'objects' : (mode as WorkspacePreviewMode);
}

/** Persist/load: legacy canvas → document */
export function normalizeWorkspaceMode(mode: string | null | undefined): WorkspaceMode {
  if (mode === 'canvas') return 'document';
  if (mode === 'editor' || mode === 'objects' || mode === 'document' || mode === 'media' || mode === 'browser') {
    return mode;
  }
  return 'objects';
}
