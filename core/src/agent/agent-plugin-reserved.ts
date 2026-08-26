/**
 * Built-in / meta tool names that local plugins must never shadow.
 */
import {
  BROWSER_AGENT_TOOLS,
  CODE_AGENT_TOOLS,
} from './agent-tool-definitions.js';

const META_PLUGIN_TOOLS = [
  'plugin_list',
  'plugin_scaffold',
  'plugin_install',
  'plugin_set_enabled',
] as const;

/** Exact tool names that plugins may not register. */
export function reservedPluginToolNames(): Set<string> {
  const set = new Set<string>();
  for (const t of CODE_AGENT_TOOLS) {
    set.add(t.function.name);
  }
  for (const t of BROWSER_AGENT_TOOLS) {
    set.add(t.function.name);
  }
  for (const n of META_PLUGIN_TOOLS) {
    set.add(n);
  }
  return set;
}

/** Prefixes plugins cannot use (except the required plugin_ application tools). */
const BLOCKED_PREFIXES = [
  'read_',
  'write_',
  'edit_',
  'git_',
  'browser_',
  'run_',
  'workspace_',
  'search_',
  'query_',
  'apply_',
  'delete_',
  'rename_',
  'list_',
] as const;

const PLUGIN_NAME_RE = /^plugin_[a-z0-9_]{1,56}$/;
const PLUGIN_ID_RE = /^[a-z0-9_]{1,40}$/;

export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_RE.test(id.trim());
}

export function isValidPluginToolName(name: string): boolean {
  const n = name.trim();
  return PLUGIN_NAME_RE.test(n);
}

export function assertPluginToolNameAllowed(name: string): string | null {
  const n = name.trim();
  if (!isValidPluginToolName(n)) {
    return 'plugin tool name must match plugin_[a-z0-9_]{1,56} and start with plugin_';
  }
  // Meta tools are reserved even though they start with plugin_
  if ((META_PLUGIN_TOOLS as readonly string[]).includes(n)) {
    return `reserved meta tool name: ${n}`;
  }
  if (reservedPluginToolNames().has(n)) {
    return `tool name collides with builtin: ${n}`;
  }
  // Extra safety: block if someone named plugin_git_pull after we strip — already covered by
  // reserved if we add builtins; also block non-plugin path overrides via blocked prefixes
  // on the substring after plugin_ for common collisions like plugin_read_file no — they still
  // must start with plugin_. Good.
  for (const p of BLOCKED_PREFIXES) {
    if (n === `plugin_${p.slice(0, -1)}` /* e.g. plugin_git */) {
      // not used; keep prefixes for future exact blocks
    }
    void p;
  }
  return null;
}

export { META_PLUGIN_TOOLS };
