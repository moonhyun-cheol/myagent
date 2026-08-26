/**
 * Canonical success check for agent tool output.
 * Several built-ins return structured JSON rather than an `ERROR:` prefix.
 */
export function agentToolOutputOk(output: string): boolean {
  const text = String(output ?? '').trim();
  if (!text) return true;
  if (text.startsWith('ERROR:') || text.includes('ERROR: tool_call_failed')) return false;
  if (!text.startsWith('{')) return true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.ok === false) return false;
    if (typeof parsed.exit_code === 'number' && parsed.exit_code !== 0) return false;
  } catch {
    // Non-JSON tool output is judged by the explicit error markers above.
  }
  return true;
}

export type AgentToolFailureType =
  | 'not_found'
  | 'permission_denied'
  | 'workspace_guard'
  | 'approval_required'
  | 'approval_rejected'
  | 'timeout'
  | 'command_exit_nonzero'
  | 'diagnostics_skipped'
  | 'syntax_error'
  | 'tool_call_failed'
  | 'invalid_arguments'
  | 'tool_failed';

export interface AgentToolResultSummary {
  ok: boolean;
  failure_type?: AgentToolFailureType;
  exit_code?: number;
  skipped?: boolean;
  weak?: boolean;
}

/** Privacy-safe failure taxonomy: no output, paths, command, or arguments. */
export function summarizeAgentToolResult(output: string): AgentToolResultSummary {
  const text = String(output ?? '').trim();
  const lower = text.toLowerCase();
  let parsed: Record<string, unknown> | null = null;
  if (text.startsWith('{')) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  const embeddedExit = text.match(/["']?exit_code["']?\s*[:=]\s*(-?\d+)/i)?.[1];
  const exitCode = typeof parsed?.exit_code === 'number'
    ? parsed.exit_code
    : embeddedExit != null ? Number.parseInt(embeddedExit, 10) : undefined;
  const skipped = parsed?.skipped === true || /["']?skipped["']?\s*[:=]\s*true/i.test(text);
  const weak = parsed?.weak === true || /["']?weak["']?\s*[:=]\s*true/i.test(text) || skipped;
  if (agentToolOutputOk(text)) return { ok: true, exit_code: exitCode, skipped, weak };

  const failure_type: AgentToolFailureType =
    skipped ? 'diagnostics_skipped'
      : /human_approval_required|approval.*required|confirm_required/.test(lower) ? 'approval_required'
        : /user_rejected|approval.*reject|거절/.test(lower) ? 'approval_rejected'
          : /permission denied|access is denied|unauthorized|eacces|eperm|권한/.test(lower) ? 'permission_denied'
            : /outside.*workspace|workspace.*guard|path.*blocked|허용.*경로|워크스페이스.*밖/.test(lower) ? 'workspace_guard'
              : /not found|enoent|does not exist|찾을 수 없|없습니다/.test(lower) ? 'not_found'
                : /timed?\s*out|timeout|시간.*초과/.test(lower) ? 'timeout'
                  : /syntax_broken|syntaxerror|parse error|문법/.test(lower) ? 'syntax_error'
                    : /invalid.*arg|argument.*required|인자/.test(lower) ? 'invalid_arguments'
                      : exitCode != null && exitCode !== 0 ? 'command_exit_nonzero'
                        : /tool_call_failed/.test(lower) ? 'tool_call_failed'
                          : 'tool_failed';
  return { ok: false, failure_type, exit_code: exitCode, skipped, weak };
}
