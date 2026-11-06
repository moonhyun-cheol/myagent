import { BROWSER_AGENT_TOOLS, CODE_AGENT_TOOLS } from './agent-tool-definitions.js';
import type { AgentToolDefinition } from './agent-tool-types.js';
import { readOnlyToolNames } from './agent-runtime-facts.js';

export type AgentToolPack = 'files' | 'browser' | 'files+browser' | 'read_only' | 'web';

/**
 * Non-browser tools allowed when the chat has no bound work folder. None of them read or
 * write user files; outputs stay in app data (data/outputs/web|browser/<session>).
 * Browser schemas (BROWSER_AGENT_TOOLS) are always included in this pack.
 */
export const WEB_PACK_CODE_TOOL_NAMES: readonly string[] = [
  'save_web_asset',
  'image_get',
  'conversation_image_get',
  'scheduler_list',
  'scheduler_feed',
  'scheduler_upsert',
  'scheduler_set_state',
  'task_history_search',
  'task_history_detail',
  'memory_propose',
  'active_task',
  'todo_update',
  'evidence_read',
];

export function getCodeAgentToolsForPack(
  pack: AgentToolPack,
  _browserRuntimeAvailable: boolean,
  cqrRoot?: string,
): AgentToolDefinition[] {
  if (pack === 'read_only') {
    const allow = cqrRoot ? readOnlyToolNames(cqrRoot) : new Set(CODE_AGENT_TOOLS.map((t) => t.function.name));
    return CODE_AGENT_TOOLS.filter((t) => allow.has(t.function.name));
  }

  // Browser schemas describe the host capability, not a momentary shell or
  // Chromium connection state. Visible actions go through the shell pipe; others
  // use a separate Chromium, and a runtime error is reported only when none opens.
  switch (pack) {
    case 'browser':
      return [...BROWSER_AGENT_TOOLS];
    case 'web': {
      const allow = new Set(WEB_PACK_CODE_TOOL_NAMES);
      return [...CODE_AGENT_TOOLS.filter((t) => allow.has(t.function.name)), ...BROWSER_AGENT_TOOLS];
    }
    case 'files+browser':
      return [...CODE_AGENT_TOOLS, ...BROWSER_AGENT_TOOLS];
    case 'files':
    default:
      return [...CODE_AGENT_TOOLS];
  }
}

export function packIncludesBrowser(pack: AgentToolPack): boolean {
  return pack === 'browser' || pack === 'files+browser' || pack === 'web';
}

/** Packs whose tool list is enforced at execution time (calls outside the schema fail). */
export function packEnforcesToolAllowlist(pack: AgentToolPack): boolean {
  return pack === 'web';
}

export function formatToolNotInPack(name: string, fileAccess?: 'workspace' | 'none'): string {
  return fileAccess === 'none'
    ? `ERROR: TOOL_NOT_IN_PACK — ${name} is not available: this chat has no bound work folder, so file/terminal/git/plugin tools are disabled. Answer with the available web tools, or tell the user to connect a work folder to this chat.`
    : `ERROR: TOOL_NOT_IN_PACK — ${name} is not in this run's tool set.`;
}
