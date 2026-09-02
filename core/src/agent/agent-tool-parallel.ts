import type { AgentToolCall } from './agent-tool-types.js';

/**
 * Read-only tools that may execute concurrently within one model round.
 * CPU-heavy converters, browser state, approvals, mutations and shell commands
 * intentionally remain serial.
 */
const PARALLEL_READ_ONLY_TOOLS = new Set([
  'task_history_search',
  'task_history_detail',
  'list_directory',
  'read_file',
  'search_files',
  'query_repo_map',
  'search_embeddings',
  'git_status',
  'git_diff',
  'git_log',
  'git_history_tree',
  'git_show',
  'git_blame',
  'plugin_list',
]);

export const DEFAULT_AGENT_READ_PARALLELISM = 4;
export const MAX_AGENT_READ_PARALLELISM = 8;

export function isParallelReadOnlyTool(name: string): boolean {
  return PARALLEL_READ_ONLY_TOOLS.has(name);
}

/** Default 4; operators may tune 1..8 without allowing unbounded fan-out. */
export function resolveAgentReadParallelism(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number.parseInt(env.MY_AGENT_READ_PARALLELISM ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_READ_PARALLELISM;
  return Math.max(1, Math.min(MAX_AGENT_READ_PARALLELISM, parsed));
}

export interface ParallelToolResult {
  call: AgentToolCall;
  output: string;
  durationMs: number;
}

/** Bounded worker pool; output order always matches input order. */
export async function runParallelToolCalls(
  calls: AgentToolCall[],
  concurrency: number,
  execute: (call: AgentToolCall) => Promise<{ output: string }>,
): Promise<ParallelToolResult[]> {
  const results = new Array<ParallelToolResult>(calls.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), calls.length);

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= calls.length) return;
      const call = calls[index];
      const started = Date.now();
      try {
        const { output } = await execute(call);
        results[index] = { call, output, durationMs: Date.now() - started };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[index] = {
          call,
          output: `ERROR: tool_execution_failed\n${message}`,
          durationMs: Date.now() - started,
        };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
