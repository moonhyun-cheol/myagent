/**
 * Code-agent tool registry surface (definitions + pack getters + local plugins).
 * Definitions live in agent-tool-definitions.ts; plugins in data/agent-plugins.
 */
import { isPlaywrightAvailable } from '../browser/playwright-probe.js';
import {
  BROWSER_AGENT_TOOLS,
  CODE_AGENT_TOOL_NAMES,
  CODE_AGENT_TOOLS,
} from './agent-tool-definitions.js';
import { getCodeAgentToolsForPack, type AgentToolPack } from './agent-tool-pack.js';
import { listEnabledPluginToolDefinitions } from './agent-plugin-store.js';
import { listUserMcpToolDefinitions } from './user-mcp.js';
import type { AgentToolDefinition } from './agent-tool-types.js';

export {
  BROWSER_AGENT_TOOLS,
  CODE_AGENT_TOOL_NAMES,
  CODE_AGENT_TOOLS,
};
export type { AgentToolCall, AgentToolContext, AgentToolDefinition } from './agent-tool-types.js';

function mergePluginTools(cqrRoot: string, base: AgentToolDefinition[]): AgentToolDefinition[] {
  try {
    const plugins = listEnabledPluginToolDefinitions(cqrRoot);
    if (!plugins.length) return base;
    const names = new Set(base.map((t) => t.function.name));
    const extra = plugins.filter((t) => !names.has(t.function.name));
    return extra.length ? [...base, ...extra] : base;
  } catch {
    return base;
  }
}

/** Sync merge of last-known empty; async enrich happens when listing for a run. */
export function getCodeAgentTools(cqrRoot: string): AgentToolDefinition[] {
  const base = !isPlaywrightAvailable(cqrRoot)
    ? [...CODE_AGENT_TOOLS]
    : [...CODE_AGENT_TOOLS, ...BROWSER_AGENT_TOOLS];
  return mergePluginTools(cqrRoot, base);
}

/** Prefer this at run start — includes user MCP tools (may spawn/list). */
export async function getCodeAgentToolsAsync(cqrRoot: string): Promise<AgentToolDefinition[]> {
  const base = getCodeAgentTools(cqrRoot);
  try {
    const mcpTools = await listUserMcpToolDefinitions(cqrRoot);
    if (!mcpTools.length) return base;
    const names = new Set(base.map((t) => t.function.name));
    const extra = mcpTools.filter((t) => !names.has(t.function.name));
    return extra.length ? [...base, ...extra] : base;
  } catch {
    return base;
  }
}

export function getCodeAgentToolsByPack(
  cqrRoot: string,
  pack: AgentToolPack,
): AgentToolDefinition[] {
  const base = getCodeAgentToolsForPack(pack, isPlaywrightAvailable(cqrRoot));
  return mergePluginTools(cqrRoot, base);
}

export async function getCodeAgentToolsByPackAsync(
  cqrRoot: string,
  pack: AgentToolPack,
): Promise<AgentToolDefinition[]> {
  const base = getCodeAgentToolsByPack(cqrRoot, pack);
  try {
    const mcpTools = await listUserMcpToolDefinitions(cqrRoot);
    if (!mcpTools.length) return base;
    const names = new Set(base.map((t) => t.function.name));
    const extra = mcpTools.filter((t) => !names.has(t.function.name));
    return extra.length ? [...base, ...extra] : base;
  } catch {
    return base;
  }
}

export function getCodeAgentToolNamesFromTools(tools: AgentToolDefinition[]): string[] {
  return tools.map((t) => t.function.name);
}

export function getCodeAgentToolNames(cqrRoot: string): string[] {
  return getCodeAgentTools(cqrRoot).map((t) => t.function.name);
}

export { executeAgentTool } from './agent-tool-execute.js';
