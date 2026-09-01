/** Model-directed workspace-agent entry with no local role orchestration. */
import { runCodeAgent } from './agent-run-loop.js';
import type { CodeAgentOptions, CodeAgentResult } from './agent-run-types.js';

export interface MarRuntimeOptions extends CodeAgentOptions {
  configPath: string;
}

export function runMarOrCodeAgent(opts: MarRuntimeOptions): Promise<CodeAgentResult> {
  return runCodeAgent(opts);
}
