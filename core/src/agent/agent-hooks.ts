/**
 * Cline-style agent lifecycle hooks: before/after model & tool steps.
 * Hooks may stop the run by returning { stop: true, reason }.
 */

export type AgentHookStop = { stop: true; reason: string };
export type AgentHookContinue = { stop?: false };

export interface AgentToolHookCtx {
  tool: string;
  args: Record<string, unknown>;
  step: number;
}

export interface AgentToolResultHookCtx extends AgentToolHookCtx {
  output: string;
  durationMs: number;
}

export interface AgentModelHookCtx {
  step: number;
  messageCount: number;
}

export interface AgentRuntimeHooks {
  beforeRun?: () => Promise<AgentHookStop | AgentHookContinue | void> | AgentHookStop | AgentHookContinue | void;
  afterRun?: (result: { content: string; steps: number }) => Promise<void> | void;
  beforeModel?: (
    ctx: AgentModelHookCtx,
  ) => Promise<AgentHookStop | AgentHookContinue | void> | AgentHookStop | AgentHookContinue | void;
  afterModel?: (ctx: AgentModelHookCtx & { hasToolCalls: boolean }) => Promise<void> | void;
  beforeTool?: (
    ctx: AgentToolHookCtx,
  ) => Promise<AgentHookStop | AgentHookContinue | void> | AgentHookStop | AgentHookContinue | void;
  afterTool?: (
    ctx: AgentToolResultHookCtx,
  ) => Promise<AgentHookStop | AgentHookContinue | void> | AgentHookStop | AgentHookContinue | void;
  onEvent?: (event: AgentRuntimeEvent) => void;
}

export type AgentRuntimeEvent =
  | { type: 'run_start' }
  | { type: 'run_end'; content: string; steps: number }
  | { type: 'model_start'; step: number }
  | { type: 'model_end'; step: number; hasToolCalls: boolean }
  | { type: 'tool_start'; tool: string; step: number }
  | { type: 'tool_end'; tool: string; step: number; ok: boolean; durationMs: number }
  | { type: 'thought'; text: string }
  | { type: 'hook_stop'; reason: string; phase: string }
  | { type: 'role_start'; role: string; agentId: string; parentRunId: string }
  | { type: 'role_end'; role: string; agentId: string; parentRunId: string; ok: boolean }
  | { type: 'handoff'; fromRole: string; toRole: string; parentRunId: string };

export function isHookStop(v: unknown): v is AgentHookStop {
  return Boolean(v && typeof v === 'object' && (v as AgentHookStop).stop === true);
}

/** Default hooks: emit structured events + block obvious secret exfil in tool args. */
export function createDefaultAgentHooks(
  emit?: (event: AgentRuntimeEvent) => void,
): AgentRuntimeHooks {
  return {
    beforeTool: (ctx) => {
      const raw = JSON.stringify(ctx.args);
      if (/(?:BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16})/.test(raw)) {
        return {
          stop: true,
          reason: 'Tool args appear to contain private keys or cloud access keys; blocked by guardrail.',
        };
      }
      return;
    },
    onEvent: emit,
  };
}

export function mergeAgentHooks(...parts: Array<AgentRuntimeHooks | undefined>): AgentRuntimeHooks {
  const list = parts.filter((h): h is AgentRuntimeHooks => Boolean(h));

  return {
    beforeRun: async () => {
      for (const h of list) {
        const r = await h.beforeRun?.();
        if (isHookStop(r)) return r;
      }
    },
    afterRun: async (result) => {
      for (const h of list) await h.afterRun?.(result);
    },
    beforeModel: async (ctx) => {
      for (const h of list) {
        const r = await h.beforeModel?.(ctx);
        if (isHookStop(r)) return r;
      }
    },
    afterModel: async (ctx) => {
      for (const h of list) await h.afterModel?.(ctx);
    },
    beforeTool: async (ctx) => {
      for (const h of list) {
        const r = await h.beforeTool?.(ctx);
        if (isHookStop(r)) return r;
      }
    },
    afterTool: async (ctx) => {
      for (const h of list) {
        const r = await h.afterTool?.(ctx);
        if (isHookStop(r)) return r;
      }
    },
    onEvent: (event) => {
      for (const h of list) h.onEvent?.(event);
    },
  };
}
