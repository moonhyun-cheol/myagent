/** MCP tools/call timeout — direct command 는 10분+ 걸릴 수 있음. */
const DEFAULT_MS = 3_600_000; // 1 hour

const TOOL_TIMEOUT_MS: Record<string, number> = {
  amazon_return_manager_direct: 3_600_000,
  downloadtable_ctr: 3_600_000,
  downloadtable_po_review: 3_600_000,
  livesi_base_source: 3_600_000,
  po_bms_workfile: 3_600_000,
  po_prep_adv: 1_800_000,
  return_chi_squared: 7_200_000,
  us_sample_stock_lookup: 1_800_000,
};

export function resolveAutomatonToolTimeoutMs(toolId: string): number {
  const envRaw = process.env.MY_AGENT_MCP_TOOL_TIMEOUT_MS?.trim();
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TOOL_TIMEOUT_MS[toolId] ?? DEFAULT_MS;
}
