import type { AgentToolCall } from './agent-tool-types.js';

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const doc = JSON.parse(raw || '{}') as Record<string, unknown>;
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  list_dir: 'list_directory',
  listdirectory: 'list_directory',
  ls: 'list_directory',
  glob: 'search_files',
  find: 'search_files',
  read: 'read_file',
  readfile: 'read_file',
  open: 'read_file',
  cat: 'read_file',
  write: 'write_file',
  writefile: 'write_file',
  create: 'write_file',
  create_file: 'write_file',
  edit: 'edit_file',
  editfile: 'edit_file',
  search_replace: 'edit_file',
  str_replace: 'edit_file',
  strreplace: 'edit_file',
  replace_in_file: 'edit_file',
  apply_patch: 'apply_patch',
  patch: 'apply_patch',
  delete: 'delete_file',
  delete_file: 'delete_file',
  unlink: 'delete_file',
  rm: 'delete_file',
  rename_file: 'rename_file',
  move_file: 'rename_file',
  mv: 'rename_file',
  grep: 'search_files',
  search: 'search_files',
  codebase_search: 'search_embeddings',
  file_search: 'search_files',
  query_repo_map: 'query_repo_map',
  repo_map: 'query_repo_map',
  find_symbol: 'query_repo_map',
  symbols: 'query_repo_map',
  search_embeddings: 'search_embeddings',
  embedding_search: 'search_embeddings',
  semantic_search: 'search_embeddings',
  shell: 'run_terminal',
  terminal: 'run_terminal',
  run_command: 'run_terminal',
  run_terminal_cmd: 'run_terminal',
  bash: 'run_terminal',
  cmd: 'run_terminal',
  powershell: 'run_terminal',
  run_tests: 'run_tests',
  test: 'run_tests',
  npm_test: 'run_tests',
  run_diagnostics: 'run_diagnostics',
  diagnostics: 'run_diagnostics',
  lint: 'run_diagnostics',
  typecheck: 'run_diagnostics',
  workspace_checkpoint: 'workspace_checkpoint',
  checkpoint: 'workspace_checkpoint',
  workspace_rollback: 'workspace_rollback',
  rollback: 'workspace_rollback',
  git_status: 'git_status',
  git_sync_preview: 'git_sync_preview',
  git_diff: 'git_diff',
  git_log: 'git_log',
  git_history_tree: 'git_history_tree',
  history_tree: 'git_history_tree',
  git_graph: 'git_history_tree',
  remote_git_inspect: 'remote_git_inspect',
  remote_git: 'remote_git_inspect',
  git_remote_inspect: 'remote_git_inspect',
  repomix_pack: 'repomix_pack',
  repomix: 'repomix_pack',
  ast_grep_search: 'ast_grep_search',
  ast_grep: 'ast_grep_search',
  markitdown_convert: 'markitdown_convert',
  markitdown: 'markitdown_convert',
  git_show: 'git_show',
  git_blame: 'git_blame',
  git_branch: 'git_branch',
  git_switch: 'git_switch',
  git_init: 'git_init',
  git_stage: 'git_stage',
  git_restore: 'git_restore',
  git_stash: 'git_stash',
  git_fetch: 'git_fetch',
  git_pull: 'git_pull',
  git_push: 'git_push',
  git_commit: 'git_commit',
  commit: 'git_commit',
  pull: 'git_pull',
  push: 'git_push',
  fetch: 'git_fetch',
  stash: 'git_stash',
  blame: 'git_blame',
  show: 'git_show',
  checkout: 'git_switch',
  switch: 'git_switch',
  plugin_list: 'plugin_list',
  plugin_scaffold: 'plugin_scaffold',
  plugin_install: 'plugin_install',
  plugin_set_enabled: 'plugin_set_enabled',
  save_web_asset: 'save_web_asset',
  download_url: 'save_web_asset',
  save_url: 'save_web_asset',
  fetch_file: 'save_web_asset',
  browser_navigate: 'browser_navigate',
  browser_screenshot: 'browser_screenshot',
  browser_click: 'browser_click',
  browser_fill: 'browser_fill',
  browser_evaluate: 'browser_evaluate',
};

/** Map provider-specific tool names to MY Agent workspace tools. */
export function normalizeToolName(raw: string): string {
  const trimmed = raw.trim();
  const base = trimmed.includes('.') ? trimmed.split('.').pop() ?? trimmed : trimmed;
  const key = base.replace(/-/g, '_').toLowerCase();
  return TOOL_NAME_ALIASES[key] ?? key;
}

export function normalizeToolCall(call: AgentToolCall): AgentToolCall {
  return {
    ...call,
    function: {
      ...call.function,
      name: normalizeToolName(call.function.name),
    },
  };
}

/** Parse TOOL_CALL: {"name":"read_file","arguments":{...}} lines when OWUI blocks API tool_calls.
 * Also accepts Qwen/Hermes/Cursor-like XML and JSON tool mimetics so the loop actually executes.
 */
export function parseClientToolCalls(content: string): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  const seen = new Set<string>();

  const push = (name: string, args: Record<string, unknown>) => {
    const n = name.trim();
    if (!n) return;
    const key = `${n}:${JSON.stringify(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({
      id: `client_${calls.length + 1}`,
      type: 'function',
      function: {
        name: n,
        arguments: JSON.stringify(args && typeof args === 'object' ? args : {}),
      },
    });
  };

  const tryParseJsonObject = (raw: string): { name?: string; arguments?: Record<string, unknown> } | null => {
    try {
      const doc = JSON.parse(raw) as {
        name?: string;
        tool?: string;
        arguments?: Record<string, unknown> | string;
        parameters?: Record<string, unknown>;
        args?: Record<string, unknown>;
        [key: string]: unknown;
      };
      const name = String(doc.name ?? doc.tool ?? '').trim();
      if (!name) return null;
      let args: Record<string, unknown> = {};
      if (doc.arguments && typeof doc.arguments === 'object') args = doc.arguments;
      else if (typeof doc.arguments === 'string') {
        try {
          const parsed = JSON.parse(doc.arguments) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object') args = parsed;
        } catch {
          args = { value: doc.arguments };
        }
      } else if (doc.parameters && typeof doc.parameters === 'object') args = doc.parameters;
      else if (doc.args && typeof doc.args === 'object') args = doc.args;
      else {
        // Flat slip: TOOL_CALL {"tool":"read_file","path":"..."} (no arguments wrapper)
        for (const [k, v] of Object.entries(doc)) {
          if (k === 'name' || k === 'tool' || k === 'arguments' || k === 'parameters' || k === 'args') {
            continue;
          }
          args[k] = v;
        }
      }
      return { name, arguments: args };
    } catch {
      return null;
    }
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Colon optional — models often emit `TOOL_CALL {"tool":...}` without `:`.
    const match = trimmed.match(/^TOOL_CALL:?\s*(\{.+)\s*$/i);
    if (!match) continue;
    const doc = tryParseJsonObject(match[1]);
    if (doc?.name) push(doc.name, doc.arguments ?? {});
  }

  for (const block of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    const inner = block[1].trim();
    const asJson = tryParseJsonObject(inner);
    if (asJson?.name) {
      push(asJson.name, asJson.arguments ?? {});
      continue;
    }
    const name =
      inner.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim()
      ?? inner.match(/name\s*=\s*["']([^"']+)["']/i)?.[1]?.trim()
      ?? '';
    const argsRaw = inner.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/i)?.[1]?.trim();
    let args: Record<string, unknown> = {};
    if (argsRaw) {
      const parsed = tryParseJsonObject(`{"name":"_","arguments":${argsRaw.startsWith('{') ? argsRaw : `{${argsRaw}}`}}`);
      if (parsed?.arguments) args = parsed.arguments;
      else {
        try {
          args = JSON.parse(argsRaw) as Record<string, unknown>;
        } catch {
          /* keep empty */
        }
      }
    }
    for (const p of inner.matchAll(/<parameter\s+name=["']([^"']+)["'][^>]*>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
      args[p[1]] = p[2].trim();
    }
    if (name) push(name, args);
  }

  for (const block of content.matchAll(/<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi)) {
    const name = block[1].trim();
    const args: Record<string, unknown> = {};
    for (const p of block[2].matchAll(/<parameter\s+name=["']([^"']+)["'][^>]*>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
      args[p[1]] = p[2].trim();
    }
    // loose "path: foo" lines inside invoke
    for (const line of block[2].split('\n')) {
      const kv = line.trim().match(/^([a-zA-Z_][\w]*)\s*[:=]\s*(.+)$/);
      if (kv && !(kv[1] in args)) args[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    if (name) push(name, args);
  }

  // Bare invoke without closing tags (model truncated XML)
  if (!calls.length) {
    const bare = content.match(/<invoke\s+name=["']([^"']+)["']/i);
    if (bare) {
      const args: Record<string, unknown> = {};
      for (const p of content.matchAll(/<parameter\s+name=["']([^"']+)["'][^>]*>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
        args[p[1]] = p[2].trim();
      }
      const pathLine = content.match(/\bpath\s*[:=]\s*["']?([^\s"'<>]+)["']?/i);
      if (pathLine && !args.path) args.path = pathLine[1];
      push(bare[1], args);
    }
  }

  const takeJsonArgsAfter = (start: number): Record<string, unknown> | null => {
    let i = start;
    while (i < content.length && /\s/.test(content[i]!)) i += 1;
    if (content[i] !== '{') return null;
    let depth = 0;
    let end = -1;
    for (let j = i; j < content.length; j += 1) {
      const ch = content[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end < 0) return null;
    try {
      const args = JSON.parse(content.slice(i, end)) as Record<string, unknown>;
      return args && typeof args === 'object' ? args : null;
    } catch {
      return null;
    }
  };

  // Bracket headers: [Tool call: read_file] / [TOOL_CALL: read_file] then {"path":"..."}
  // (same-line or next-line JSON — common OWUI/Qwen slip that previously stalled the loop)
  {
    const headerRe = /\[\s*(?:TOOL[_ ]?CALL|Tool\s*call)\s*:\s*([^\]]+?)\s*\]/gi;
    let hm: RegExpExecArray | null;
    while ((hm = headerRe.exec(content)) !== null) {
      const name = hm[1].trim().split(/[\s(/]/)[0] ?? '';
      if (!name) continue;
      const args = takeJsonArgsAfter(hm.index + hm[0].length);
      if (args) push(name, args);
    }
  }

  // Same without brackets: Tool call: read_file / TOOL_CALL: read_file\n{"path":"..."}
  {
    const headerRe = /(?:^|\n)\s*(?:TOOL[_ ]?CALL|Tool\s*call)\s*:\s*([a-zA-Z_][\w]*)\s*(?:\n|$)/gi;
    let hm: RegExpExecArray | null;
    while ((hm = headerRe.exec(content)) !== null) {
      const name = hm[1].trim();
      const args = takeJsonArgsAfter(hm.index + hm[0].length);
      if (args) push(name, args);
    }
  }

  // read_file("path") / write_file("path", ...)
  for (const m of content.matchAll(
    /\b(read_file|write_file|edit_file|list_directory|search_files|run_terminal|apply_patch|git_init|git_status|git_sync_preview|git_diff|git_log|git_history_tree|git_show|git_blame|git_branch|git_switch|git_stage|git_restore|git_stash|git_fetch|git_pull|git_push|git_commit|plugin_list|plugin_scaffold|plugin_install|plugin_set_enabled|run_tests|run_diagnostics|workspace_checkpoint|workspace_rollback)\s*\(\s*["']([^"']+)["']/gi,
  )) {
    const name = m[1];
    const first = m[2];
    if (name === 'read_file' || name === 'list_directory' || name === 'search_files') {
      push(name, name === 'search_files' ? { query: first } : { path: first });
    } else if (name === 'write_file' || name === 'edit_file') {
      push(name, { path: first });
    } else {
      push(name, { path: first });
    }
  }

  return calls;
}

/** Fill missing write_file content from a fenced code block in the same assistant message. */
export function enrichClientToolCalls(calls: AgentToolCall[], fullContent: string): AgentToolCall[] {
  const body = fullContent
    .split('\n')
    .filter((line) => !line.trim().startsWith('TOOL_CALL:'))
    .join('\n');
  const fenceMatch = body.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);

  return calls.map((call) => {
    const normalized = normalizeToolCall(call);
    if (normalized.function.name !== 'write_file') return normalized;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(normalized.function.arguments) as Record<string, unknown>;
    } catch {
      return normalized;
    }
    const existing = typeof args.content === 'string' ? args.content : '';
    if (existing.length > 0) return normalized;
    if (fenceMatch?.[1]) {
      args.content = fenceMatch[1].replace(/\n$/, '');
      return {
        ...normalized,
        function: { ...normalized.function, arguments: JSON.stringify(args) },
      };
    }
    return normalized;
  });
}

export function toolStatusLabel(call: AgentToolCall): string {
  try {
    const args = parseToolArgs(call.function.arguments);
    const name = normalizeToolName(call.function.name);
    if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
      return `${name}: ${args.path ?? ''}`;
    }
    if (name === 'list_directory') return `${name}: ${args.path ?? '.'}`;
    if (name === 'search_files') return `${name}: ${args.query ?? ''}`;
    if (name === 'query_repo_map') return `${name}: ${args.query ?? ''}`;
    if (name === 'search_embeddings') return `${name}: ${args.query ?? ''}`;
    if (name === 'browser_navigate') return `${name}: ${args.url ?? ''}`;
    if (name === 'browser_screenshot') return `${name}: ${args.path ?? 'auto'}`;
    if (name === 'save_web_asset') return `${name}: ${args.url ?? ''}`;
    if (name === 'browser_click' || name === 'browser_fill') return `${name}: ${args.selector ?? ''}`;
    return name;
  } catch {
    return call.function.name;
  }
}

