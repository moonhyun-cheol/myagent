import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveOrganizationModuleRoot } from '../skills/organization-module-root.js';
import { loadFeatureOpenClawWorkflows } from '../features/organization-feature-loader.js';
import type { OpenClawWorkflowPayload } from './openclaw-workflow-map.js';

interface OpenClawWorkflowMapDoc {
  version?: number;
  workflows?: Record<string, OpenClawWorkflowPayload>;
}

function loadLegacyOrganizationOpenClawWorkflows(cqrRoot: string): Record<string, OpenClawWorkflowPayload> {
  const orgRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!orgRoot) return {};
  const mapPath = path.join(orgRoot, 'openclaw-workflow-map.json');
  if (!existsSync(mapPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(mapPath, 'utf8')) as OpenClawWorkflowMapDoc;
    return raw.workflows ?? {};
  } catch {
    return {};
  }
}

/** Legacy modules/organization + enabled Organization Feature roots. */
export function loadOrganizationOpenClawWorkflows(cqrRoot: string): Record<string, OpenClawWorkflowPayload> {
  return {
    ...loadLegacyOrganizationOpenClawWorkflows(cqrRoot),
    ...loadFeatureOpenClawWorkflows(cqrRoot),
  };
}
