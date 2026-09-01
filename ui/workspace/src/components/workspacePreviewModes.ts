import { Briefcase, Browser, ImageSquare, SquaresFour, type Icon } from '@phosphor-icons/react';
import type { WorkspaceMode } from '../types';

export type WorkspacePreviewMode = Exclude<WorkspaceMode, 'editor'>;

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
  {
    id: 'canvas',
    label: '캔버스',
    icon: SquaresFour,
    disabled: true,
    disabledReason: '캔버스 기능을 정비 중입니다.',
  },
  { id: 'media', label: '미디어', icon: ImageSquare },
  { id: 'browser', label: '웹', icon: Browser },
];

export function isAvailableWorkspacePreviewMode(value: string | null): value is WorkspacePreviewMode {
  return WORKSPACE_PREVIEW_MODES.some((definition) => definition.id === value && !definition.disabled);
}

export function resolveAvailableWorkspacePreviewMode(mode: WorkspaceMode): WorkspacePreviewMode {
  if (mode === 'editor') return 'browser';
  const definition = WORKSPACE_PREVIEW_MODES.find((item) => item.id === mode);
  return definition?.disabled ? 'objects' : mode;
}
