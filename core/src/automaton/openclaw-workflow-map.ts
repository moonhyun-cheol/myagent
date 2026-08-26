/** Optional OpenClaw workflow payload supplied by an organization module. */
export interface OpenClawWorkflowPayload {
  task_profile_id: string;
  tool_id: string;
  args: Record<string, unknown>;
}

const BY_TOOL_ID: Record<string, OpenClawWorkflowPayload> = {};

export function resolveOpenClawWorkflow(toolId: string): OpenClawWorkflowPayload | null {
  return BY_TOOL_ID[toolId] ?? null;
}

export function isOpenClawRemoteTool(toolId: string): boolean {
  return Boolean(BY_TOOL_ID[toolId]);
}
