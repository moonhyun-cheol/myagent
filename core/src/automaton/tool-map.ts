import { getAutomatonToolIds, isAutomatonToolId } from './tool-catalog.js';

export const AUTOMATON_TOOL_IDS = getAutomatonToolIds();

export interface AutomatonCommandConfig {
  commandId: string;
  scriptRelativePath: string;
  longRunning: boolean;
  timeoutSec: number;
  stallTimeoutMin: number;
}

/** Bulbasaur agent_tasks 와 동기화 — async spawn 은 longRunning 만 */
export const AUTOMATON_COMMAND_REGISTRY: Record<string, AutomatonCommandConfig> = {
  amazon_return_manager_direct: {
    commandId: 'amazon_return_manager_direct',
    scriptRelativePath: '00_python_file/_70_direct_commands/amazon_return_manager.py',
    longRunning: true,
    timeoutSec: 14_400,
    stallTimeoutMin: 15,
  },
};

export function getAutomatonCommandConfig(toolId: string): AutomatonCommandConfig | null {
  return AUTOMATON_COMMAND_REGISTRY[toolId] ?? null;
}

/** 기본 async. MY_AGENT_AUTOMATON_ASYNC=0 이면 MCP 동기 경로로 롤백 */
export function isAutomatonAsyncEnabled(): boolean {
  return process.env.MY_AGENT_AUTOMATON_ASYNC !== '0';
}

export function buildCliArguments(
  toolId: string,
  mcpArgs: Record<string, unknown>,
  paths: { jsonOutput: string; progressFile: string },
): string[] {
  const cli: string[] = [];

  switch (toolId) {
    case 'amazon_return_manager_direct':
      cli.push(
        '--action', 'manager_direct',
        '--manager-request-text', String(mcpArgs.manager_request_text ?? ''),
        '--json-output', paths.jsonOutput,
        '--progress-file', paths.progressFile,
      );
      break;
    default:
      throw new Error(`CLI spawn not configured for tool: ${toolId}`);
  }

  return cli;
}

export function isAutomatonTool(toolId: string | undefined): toolId is string {
  return isAutomatonToolId(toolId);
}

export function buildAutomatonToolArgs(
  toolId: string,
  message: string,
  progressFile?: string,
): Record<string, unknown> {
  const progress = progressFile?.trim();
  const withProgress = (args: Record<string, unknown>) => (
    progress ? { ...args, progress_file: progress } : args
  );
  const text = message.trim();

  switch (toolId) {
    case 'amazon_return_manager_direct':
      return withProgress({ manager_request_text: normalizeManagerRequestMessage(message) });
    case 'return_chi_squared':
      return withProgress({
        manager_request_text: text || '/반품율분석',
        requested_text: text,
      });
    case 'po_prep_adv':
      return withProgress({ requested_text: text || '/발주정보용판매' });
    case 'livesi_base_source':
      return withProgress({ requested_text: text || '/라이브계절지수' });
    case 'downloadtable_ctr':
    case 'downloadtable_po_review':
    case 'po_bms_workfile':
    case 'us_sample_stock_lookup':
      return withProgress({ requested_text: text });
    default:
      return withProgress({ requested_text: text });
  }
}

/** MY Agent UI "text: CODE" / bare codes → slash parser 호환 */
export function normalizeManagerRequestMessage(message: string): string {
  let t = message.trim();
  if (!t) return '/반품율분석';
  t = t.replace(/^\/?반품율(?:분석|검토|조회)?\s*/i, '');
  t = t.replace(/^text:\s*/i, '');
  t = t.replace(/\s+text:\s*/gi, ' ');
  t = t.trim();
  if (!t.startsWith('/')) {
    return `/반품율분석 ${t}`;
  }
  return t.startsWith('반품율') ? `/${t}` : t;
}
