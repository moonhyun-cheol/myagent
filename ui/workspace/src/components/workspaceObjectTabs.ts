import {
  CheckSquareOffset,
  ClockCounterClockwise,
  FolderOpen,
  type Icon,
} from '@phosphor-icons/react';

export type WorkspaceObjectTabId = 'recent' | 'files' | 'todo';

export interface WorkspaceObjectTabDefinition {
  id: WorkspaceObjectTabId;
  label: string;
  description: string;
  icon: Icon;
}

/** 작업 오브젝트 패널의 상위 탭은 이 레지스트리에서만 추가·정렬한다. */
export const WORKSPACE_OBJECT_TABS: readonly WorkspaceObjectTabDefinition[] = [
  {
    id: 'recent',
    label: '최근 작업물',
    description: '최근 참조 링크와 생성·변경된 파일을 확인합니다.',
    icon: ClockCounterClockwise,
  },
  {
    id: 'files',
    label: '파일',
    description: '연결된 작업 폴더의 파일 구조를 확인합니다.',
    icon: FolderOpen,
  },
  {
    id: 'todo',
    label: 'Todo',
    description: '현재 작업에서 인식된 할 일과 고정 지침을 확인합니다.',
    icon: CheckSquareOffset,
  },
];

export function getWorkspaceObjectTab(id: WorkspaceObjectTabId): WorkspaceObjectTabDefinition {
  return WORKSPACE_OBJECT_TABS.find((tab) => tab.id === id) ?? WORKSPACE_OBJECT_TABS[0];
}
