import type { PlaywrightSession } from '../browser/playwright-session.js';
import type { WorkspaceBehavior } from '../execution-policy.js';

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AgentToolContext {
  browserSession?: PlaywrightSession | null;
  cqrRoot?: string;
  sessionId?: string;
  allowLocalhost?: boolean;
  /** Cancel long-running tools (run_terminal). */
  signal?: AbortSignal;
  /** Plan mode blocks mutating tools at execute time. */
  workspaceBehavior?: WorkspaceBehavior;
  /** Live evidence callback used by model-authored task completion. */
  getRunEvidence?: () => {
    mutatedPaths: string[];
    /** A successful model-requested tests/terminal/browser tool after mutation. */
    acceptanceOk: boolean;
  };
}
