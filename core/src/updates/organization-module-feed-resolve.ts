import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { loadUserOverrides } from '../config/user-overrides.js';

function readInstalledFeedUrl(cqrRoot: string): string | null {
  const moduleJson = path.join(cqrRoot, 'modules', 'organization', 'module.json');
  if (!existsSync(moduleJson)) return null;
  try {
    const doc = JSON.parse(readFileSync(moduleJson, 'utf8')) as {
      kind?: string;
      update_feed_url?: unknown;
    };
    if (doc.kind && doc.kind !== 'organization-module') return null;
    const url = typeof doc.update_feed_url === 'string' ? doc.update_feed_url.trim() : '';
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Feed URL for org module check/download.
 * Priority: installed module.json → env → user-overrides → deploy-defaults.
 * Never invent a host; empty means remote check unavailable.
 */
export function resolveOrganizationModuleFeedUrl(cqrRoot: string): string | null {
  const fromInstalled = readInstalledFeedUrl(cqrRoot);
  if (fromInstalled) return fromInstalled;

  const fromEnv = process.env.MY_AGENT_ORGANIZATION_MODULE_FEED_URL?.trim();
  if (fromEnv) return fromEnv;

  try {
    const overrides = loadUserOverrides(path.join(cqrRoot, 'data', 'config', 'user-overrides.json'));
    const fromUser = overrides.organization_module_feed_url?.trim();
    if (fromUser) return fromUser;
  } catch {
    /* optional */
  }

  try {
    const fromDeploy = loadDeployDefaults(cqrRoot).organization_module_feed_url?.trim();
    if (fromDeploy) return fromDeploy;
  } catch {
    /* optional */
  }

  return null;
}
