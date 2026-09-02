import { checkLauncherUpdateRemote } from '../updates/launcher-update-feed.js';
import { checkWorkKitCatalogUpdateRemote } from '../updates/work-kit-catalog-feed.js';

export interface WorkEnvironmentPendingResult {
  launcher: Awaited<ReturnType<typeof checkLauncherUpdateRemote>>;
  catalog: Awaited<ReturnType<typeof checkWorkKitCatalogUpdateRemote>>;
  any_pending: boolean;
}

export async function evaluateWorkEnvironmentPending(
  cqrRoot: string,
  opts?: { signal?: AbortSignal },
): Promise<WorkEnvironmentPendingResult> {
  const [launcher, catalog] = await Promise.all([
    checkLauncherUpdateRemote(cqrRoot, opts),
    checkWorkKitCatalogUpdateRemote(cqrRoot, opts),
  ]);
  return {
    launcher,
    catalog,
    any_pending: launcher.update_available || catalog.update_available,
  };
}
