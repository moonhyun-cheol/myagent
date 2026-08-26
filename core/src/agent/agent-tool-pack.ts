import { BROWSER_AGENT_TOOLS, CODE_AGENT_TOOLS } from './agent-tool-definitions.js';
import type { AgentToolDefinition } from './agent-tool-types.js';

export type AgentToolPack = 'files' | 'browser' | 'files+browser';

export function getCodeAgentToolsForPack(
  pack: AgentToolPack,
  playwrightAvailable: boolean,
): AgentToolDefinition[] {
  if (!playwrightAvailable) return [...CODE_AGENT_TOOLS];

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
