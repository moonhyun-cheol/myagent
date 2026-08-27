import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadDeployDefaults } from '../config/deploy-defaults.js';

export function resolveOrganizationModuleRoot(cqrRoot: string): string | null {
  const env = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT?.trim();
  if (env && existsSync(env)) return path.resolve(env);

  const bundled = path.join(cqrRoot, 'modules', 'organization');
  if (existsSync(bundled)) return path.resolve(bundled);

  const deploy = loadDeployDefaults(cqrRoot);
  const configured = deploy.organization_module_root?.trim();
  if (configured && existsSync(configured)) return path.resolve(configured);

  return null;
}

export function resolveOrganizationBrandManualUrl(cqrRoot: string): string | undefined {
  const root = resolveOrganizationModuleRoot(cqrRoot);
  if (!root) return undefined;
  const moduleJsonPath = path.join(root, 'module.json');
  if (!existsSync(moduleJsonPath)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(moduleJsonPath, 'utf8')) as { brand_manual_url?: unknown };
    const url = typeof doc.brand_manual_url === 'string' ? doc.brand_manual_url.trim() : '';
    return url || undefined;
  } catch {
    return undefined;
  }
}
