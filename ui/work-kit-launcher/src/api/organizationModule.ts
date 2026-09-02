import { apiFetch } from './http';

export interface OrganizationModuleStatus {
  can_check_remote?: boolean;
}

export interface OrganizationModuleUpdate {
  sequence: number;
  version: string;
}

export async function fetchOrganizationModule(): Promise<OrganizationModuleStatus> {
  const res = await apiFetch('/organization-module');
  if (!res.ok) throw new Error(`조직 모듈 상태 실패 (${res.status})`);
  return (await res.json()) as OrganizationModuleStatus;
}

export async function checkOrganizationModule(): Promise<OrganizationModuleUpdate | null> {
  const res = await apiFetch('/organization-module/check', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { message?: string }).message || `조직 모듈 확인 실패 (${res.status})`,
    );
  }
  return (data.update ?? null) as OrganizationModuleUpdate | null;
}

export async function applyOrganizationModule(): Promise<void> {
  const res = await apiFetch('/organization-module/apply', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { message?: string }).message || `조직 모듈 업데이트 실패 (${res.status})`,
    );
  }
}

/** Optional pre-apply sync when remote org module feed is available. */
export async function syncOrganizationModuleIfNeeded(): Promise<void> {
  try {
    const status = await fetchOrganizationModule();
    if (status.can_check_remote !== true) return;
    const update = await checkOrganizationModule();
    if (!update) return;
    await applyOrganizationModule();
  } catch {
    /* background — apply may still warn via Core */
  }
}
