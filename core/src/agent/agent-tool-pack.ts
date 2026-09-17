import { BROWSER_AGENT_TOOLS, CODE_AGENT_TOOLS } from './agent-tool-definitions.js';
import type { AgentToolDefinition } from './agent-tool-types.js';
import { readOnlyToolNames } from './agent-runtime-facts.js';

export type AgentToolPack = 'files' | 'browser' | 'files+browser' | 'read_only';

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
  // Chromium connection state. Execution attaches to shared WebView2 first
  // and reports a runtime error only when no backend can be opened.
  switch (pack) {
    case 'browser':
      return [...BROWSER_AGENT_TOOLS];
    case 'files+browser':
      return [...CODE_AGENT_TOOLS, ...BROWSER_AGENT_TOOLS];
    case 'files':
    default:
      return [...CODE_AGENT_TOOLS];
  }
}

export function packIncludesBrowser(pack: AgentToolPack): boolean {
  return pack === 'browser' || pack === 'files+browser';
}
