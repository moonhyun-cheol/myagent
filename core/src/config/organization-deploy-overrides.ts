import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeployDefaults } from './deploy-defaults.js';

function resolveOrganizationModuleRootForOverrides(cqrRoot: string): string | null {
  const env = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT?.trim();
  if (env && existsSync(env)) return path.resolve(env);

  const bundled = path.join(cqrRoot, 'modules', 'organization');
  if (existsSync(bundled)) return path.resolve(bundled);

  return null;
}

export function loadOrganizationDeployOverrides(cqrRoot: string): Partial<DeployDefaults> {
  const orgRoot = resolveOrganizationModuleRootForOverrides(cqrRoot);
  if (!orgRoot) return {};
  const overridesPath = path.join(orgRoot, 'deploy-overrides.json');
  if (!existsSync(overridesPath)) return {};
  try {
    return JSON.parse(readFileSync(overridesPath, 'utf8')) as Partial<DeployDefaults>;
  } catch {
    return {};
  }
}
