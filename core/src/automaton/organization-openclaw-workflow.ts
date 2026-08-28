import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveOrganizationModuleRoot } from '../skills/organization-module-root.js';
import type { OpenClawWorkflowPayload } from './openclaw-workflow-map.js';

interface OpenClawWorkflowMapDoc {
  version?: number;
  workflows?: Record<string, OpenClawWorkflowPayload>;
}

export function loadOrganizationOpenClawWorkflows(cqrRoot: string): Record<string, OpenClawWorkflowPayload> {
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
