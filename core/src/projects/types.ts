import type { SessionSummary } from '../sessions/types.js';

export type ProjectKind = 'workspace_root' | 'folder' | 'project';
export type ProjectColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'pink';

export interface ProjectRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  kind?: ProjectKind;
  parent_id?: string | null;
  /** Absolute path — only for workspace_root */
  folder_path?: string | null;
  /** Scope default used when a conversation has no explicit model override. */
  preferred_model?: string;
  /** Optional write roots. The first entry is the relative-path workspace root; every entry is enforced. */
  allowed_paths?: string[];
  /** Accessible palette id used by workspace/project labels. */
  color?: ProjectColor | null;
}

export interface ProjectSummary extends ProjectRecord {
  session_count: number;
}

export interface WorkspaceNode {
  id: string;
  title: string;
  kind: ProjectKind;
  parent_id?: string | null;
  folder_path?: string | null;
  preferred_model?: string;
  allowed_paths?: string[];
  /** Accessible palette id used by workspace/project labels. */
  color?: ProjectColor | null;
  created_at: string;
  updated_at: string;
  sessions: SessionSummary[];
  children: WorkspaceNode[];
  session_count: number;
}

export interface MoveTarget {
  id: string | null;
  label: string;
  path: string;
  kind: ProjectKind | 'standalone';
}

export interface WorkspaceTree {
  dev_workspace_root: string | null;
  active_workspace_project_id: string | null;
  /** @deprecated use workspace_trees */
  workspace_tree: WorkspaceNode | null;
  workspace_trees: WorkspaceNode[];
  move_targets: MoveTarget[];
  projects: Array<ProjectSummary & { sessions: SessionSummary[] }>;
  standalone_sessions: SessionSummary[];
}
