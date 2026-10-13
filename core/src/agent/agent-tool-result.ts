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

/**
 * Command tools whose process actually ran (call OK) but exited non-zero.
 * That is a code/test/build miss, not a tool-invocation failure.
 */
export const COMMAND_RESULT_TOOLS = new Set(['run_terminal', 'run_tests', 'run_diagnostics']);

export type CommandFailureKind = 'command_failed' | 'call_failed';

/** Structured kind for a finished command result (undefined when ok). */
export function commandFailureKind(result: {
  ok: boolean;
  exit_code: number | null;
  cancelled?: boolean;
  termination_unconfirmed?: boolean;
  spawn_error?: boolean;
}): CommandFailureKind | undefined {
  if (result.ok) return undefined;
  if (
    typeof result.exit_code === 'number'
    && result.exit_code !== 0
    && !result.cancelled
    && !result.termination_unconfirmed
    && !result.spawn_error
  ) {
    return 'command_failed';
  }
  return 'call_failed';
}

/** True only when a command tool reported `failure_kind: "command_failed"`. */
export function isCommandFailureOutput(toolName: string, output: string): boolean {
  if (!COMMAND_RESULT_TOOLS.has(toolName)) return false;
  const text = String(output ?? '').trim();
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed.failure_kind === 'command_failed' && parsed.cancelled !== true;
  } catch {
    return false;
  }
}

/** Tools whose success payload is arbitrary text (file body, hits, diffs). */
const BODY_RESULT_TOOLS = new Set([
  'read_file', 'search_files', 'list_directory', 'query_repo_map', 'search_embeddings',
  'evidence_read', 'git_show', 'git_diff', 'git_log', 'git_blame', 'git_history_tree',
  'markitdown_convert', 'task_history_search', 'task_history_detail',
]);

/**
 * Successful body payloads may contain words like "not found" / `"ok": false`
 * (source code, search hits). Never re-label them as call failures.
 */
export function isBodyToolSuccess(toolName: string, output: string): boolean {
  return BODY_RESULT_TOOLS.has(toolName) && agentToolOutputOk(output);
}

export type AgentToolOutcome = 'ok' | 'command_failed' | 'call_failed';

/** ok / command ran but failed (code miss) / tool call itself failed. */
export function classifyAgentToolOutcome(toolName: string, output: string): AgentToolOutcome {
  if (agentToolOutputOk(output)) return 'ok';
  return isCommandFailureOutput(toolName, output) ? 'command_failed' : 'call_failed';
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
  // Command output (stderr/stdout) may contain "not found" etc.; trust the structured kind.
  if (parsed?.failure_kind === 'command_failed') {
    return { ok: false, failure_type: 'command_exit_nonzero', exit_code: exitCode, skipped, weak };
  }

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
