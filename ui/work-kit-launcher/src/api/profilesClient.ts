import { apiFetch } from './http';

export interface AgentProfile {
  id: string;
  label: string;
  description?: string;
  version: 2;
  ui: { default_skill_mode?: string; pinned_skill_ids: string[] };
  plugins: { enable: Record<string, boolean> };
  created_at: string;
  updated_at: string;
}

export type ShelfInstallStatus =
  | 'available'
  | 'installed'
  | 'update_available'
  | 'missing_asset';

export interface WorkKitShelf {
  schema_version: 1;
  id: string;
  group: string;
  label: string;
  description?: string;
  pull: Array<'agent-plugins' | 'skills'>;
  plugins: { enable: Record<string, boolean> };
  ui: { default_skill_mode?: string; pinned_skill_ids: string[] };
  hints?: { needs_organization_module?: boolean };
  origin: 'locker' | 'bundled' | 'catalog';
  install_status?: ShelfInstallStatus;
  feed_asset_sequence?: number;
}

export interface WorkKitCatalogGroup {
  id: string;
  label: string;
  order: number;
  shelves: WorkKitShelf[];
}

export interface AgentProfileApplied {
  profile_id: string;
  group?: string;
  kit_id?: string;
  origin?: 'locker' | 'bundled' | 'overlay';
  ui: AgentProfile['ui'];
  applied_at: string;
}

export interface ProfileApplyResult {
  ok: boolean;
  profile_id: string;
  group?: string;
  kit_id?: string;
  toggled: Array<{ id: string; enabled: boolean }>;
  warnings: string[];
}

export interface WorkKitCatalogCheckResult {
  feed_url: string | null;
  feed_sequence: number | null;
  cached_sequence: number | null;
  update_available: boolean;
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  throw new Error(
    (data as { message?: string; error?: string }).message
      || (data as { message?: string; error?: string }).error
      || `${fallback} (${res.status})`,
  );
}

export async function fetchProfiles(): Promise<{
  locker_root: string;
  feed_sequence: number | null;
  groups: WorkKitCatalogGroup[];
  applied: AgentProfileApplied | null;
  applied_kits: AgentProfileApplied[];
  can_restore: boolean;
}> {
  const res = await apiFetch('/profiles');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) await parseError(res, '프로필 조회 실패');
  return {
    locker_root: typeof data.locker_root === 'string' ? data.locker_root : '',
    feed_sequence: typeof data.feed_sequence === 'number' ? data.feed_sequence : null,
    groups: Array.isArray(data.groups) ? data.groups : [],
    applied: data.applied ?? null,
    applied_kits: Array.isArray(data.applied_kits) ? data.applied_kits : (data.applied ? [data.applied] : []),
    can_restore: data.can_restore === true,
  };
}

export async function checkWorkKitCatalog(): Promise<WorkKitCatalogCheckResult> {
  const res = await apiFetch('/profiles/catalog/check');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) await parseError(res, '카탈로그 확인 실패');
  return data as WorkKitCatalogCheckResult;
}

export async function refreshWorkKitCatalog(): Promise<{ ok: boolean; sequence: number }> {
  const res = await apiFetch('/profiles/catalog/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) await parseError(res, '카탈로그 동기화 실패');
  return { ok: data.ok === true, sequence: Number(data.sequence) || 0 };
}

export async function installWorkKitShelf(group: string, id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(
    `/profiles/shelves/${encodeURIComponent(group)}/${encodeURIComponent(id)}/install`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) await parseError(res, '키트 받기 실패');
  return { ok: data.ok === true };
}

export async function applyWorkKitProfile(group: string, id: string): Promise<ProfileApplyResult> {
  const res = await apiFetch('/profiles/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group, id, confirm: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) await parseError(res, '프로필 적용 실패');
  return data as ProfileApplyResult;
}

export async function restoreProfileLastState(): Promise<void> {
  const res = await apiFetch('/profiles/restore-last', { method: 'POST' });
  if (!res.ok) await parseError(res, '되돌리기 실패');
}
