import { checkWorkKitCatalogUpdateRemote } from '../updates/work-kit-catalog-feed.js';

export interface WorkEnvironmentPendingResult {
  catalog: Awaited<ReturnType<typeof checkWorkKitCatalogUpdateRemote>>;
  any_pending: boolean;
}

export async function evaluateWorkEnvironmentPending(
  cqrRoot: string,
  opts?: { signal?: AbortSignal },
): Promise<WorkEnvironmentPendingResult> {
  const catalog = await checkWorkKitCatalogUpdateRemote(cqrRoot, opts);
  return {
    catalog,
    any_pending: catalog.update_available,
  };
}
