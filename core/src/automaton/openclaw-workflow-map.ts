import { loadOrganizationOpenClawWorkflows } from './organization-openclaw-workflow.js';

/** Optional OpenClaw workflow payload supplied by an organization module. */
export interface OpenClawWorkflowPayload {
  task_profile_id: string;
  tool_id: string;
  args: Record<string, unknown>;
}

const CORE_BY_TOOL_ID: Record<string, OpenClawWorkflowPayload> = {};

let cachedKey: string | null = null;
let cachedByToolId: Record<string, OpenClawWorkflowPayload> = CORE_BY_TOOL_ID;

function mergeWorkflowMaps(
  core: Record<string, OpenClawWorkflowPayload>,
  org: Record<string, OpenClawWorkflowPayload>,
): Record<string, OpenClawWorkflowPayload> {
  return { ...core, ...org };
}

export function resetOpenClawWorkflowMapCache(): void {
  cachedKey = null;
  cachedByToolId = CORE_BY_TOOL_ID;
}

function resolveWorkflowMap(cqrRoot?: string): Record<string, OpenClawWorkflowPayload> {
  const key = cqrRoot?.trim() || '';
  if (cachedKey === key) return cachedByToolId;
  const org = key ? loadOrganizationOpenClawWorkflows(key) : {};
  cachedKey = key;
  cachedByToolId = mergeWorkflowMaps(CORE_BY_TOOL_ID, org);
  return cachedByToolId;
}

export function resolveOpenClawWorkflow(toolId: string, cqrRoot?: string): OpenClawWorkflowPayload | null {
  return resolveWorkflowMap(cqrRoot)[toolId] ?? null;
}

export function isOpenClawRemoteTool(toolId: string, cqrRoot?: string): boolean {
  return Boolean(resolveWorkflowMap(cqrRoot)[toolId]);
}
