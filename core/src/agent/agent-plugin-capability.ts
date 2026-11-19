/**
 * Local plugin install approval policy.
 * Which tool/plugin to use is the model's choice; the runtime only gates installs.
 */

/**
 * Whether plugin_install args require UI Accept (HITL).
 * Template installs that map to read templates stay confirm-gate only;
 * freeform tool_json installs always need Accept when UI is available.
 */
export function pluginInstallNeedsHitl(args: Record<string, unknown>): {
  needed: boolean;
  danger: boolean;
  summary: string;
} {
  const templateId =
    typeof args.template_id === 'string' ? args.template_id.trim() : '';
  if (templateId) {
    // Known blueprints are low-risk; confirm=true is enough (no UI unless write template later)
    return { needed: false, danger: false, summary: '' };
  }
  // Freeform: tool_json + run_source on this PC
  const id = typeof args.id === 'string' ? args.id : '(id?)';
  const riskRaw =
    args.tool_json && typeof args.tool_json === 'object'
      ? String((args.tool_json as { risk?: string }).risk || 'read')
      : 'read';
  const danger = riskRaw === 'write' || riskRaw === 'network';
  return {
    needed: true,
    danger,
    summary: danger
      ? `로컬 freeform 플러그인 설치 (${id}, risk=${riskRaw}) — Accept 필요`
      : `로컬 freeform 플러그인 설치 (${id}) — Accept 필요`,
  };
}
