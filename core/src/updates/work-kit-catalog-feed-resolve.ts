import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import path from 'node:path';

/**
 * Feed URL for work-kit catalog refresh / per-shelf install.
 * Priority: env → user-overrides → deploy-defaults.
 * Never invent a host; empty means remote catalog unavailable.
 */
export function resolveWorkKitCatalogFeedUrl(cqrRoot: string): string | null {
  const fromEnv = process.env.MY_AGENT_WORK_KIT_CATALOG_FEED_URL?.trim();
  if (fromEnv) return fromEnv;

  try {
    const overrides = loadUserOverrides(path.join(cqrRoot, 'data', 'config', 'user-overrides.json'));
    const fromUser = overrides.work_kit_catalog_feed_url?.trim();
    if (fromUser) return fromUser;
  } catch {
    /* optional */
  }

  try {
    const fromDeploy = loadDeployDefaults(cqrRoot).work_kit_catalog_feed_url?.trim();
    if (fromDeploy) return fromDeploy;
  } catch {
    /* optional */
  }

  return null;
}
