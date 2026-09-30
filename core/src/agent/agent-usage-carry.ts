/**
 * Carry LLM token usage across abnormal agent exits (throw / abort / infra retry).
 *
 * The normal path records usage in finish() → lastPerf. A thrown error skips
 * finish(), so the agent loop attaches the live counters to the error object and
 * the orchestrator sums them into the persisted assistant message / SSE event.
 */
import type { LlmUsageCounters } from './llm-usage-cost.js';

export type AgentUsageTotals = {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
};

type PartialUsage = Partial<LlmUsageCounters> | null | undefined;

const CARRY_KEY = '__agentLlmUsage';

export function emptyAgentUsage(): AgentUsageTotals {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 };
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Mutates `target` by adding provider-reported usage. */
export function addAgentUsage(target: AgentUsageTotals, usage: PartialUsage): AgentUsageTotals {
  if (!usage) return target;
  target.prompt_tokens += n(usage.prompt_tokens);
  target.completion_tokens += n(usage.completion_tokens);
  target.reasoning_tokens += n(usage.reasoning_tokens);
  target.cached_tokens += n(usage.cached_tokens);
  target.cache_write_tokens += n(usage.cache_write_tokens);
  return target;
}

export function sumAgentUsage(...parts: PartialUsage[]): AgentUsageTotals {
  const out = emptyAgentUsage();
  for (const p of parts) addAgentUsage(out, p);
  return out;
}

export function hasAgentUsage(usage: PartialUsage): boolean {
  return Boolean(usage && (n(usage.prompt_tokens) > 0 || n(usage.completion_tokens) > 0));
}

/** Attach a snapshot of usage to a thrown error (objects only; primitives are left alone). */
export function attachAgentUsage(err: unknown, usage: PartialUsage): void {
  if (!err || typeof err !== 'object' || !hasAgentUsage(usage)) return;
  try {
    Object.defineProperty(err, CARRY_KEY, {
      value: sumAgentUsage(usage),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* frozen error objects: usage is best-effort */
  }
}

export function agentUsageFromError(err: unknown): AgentUsageTotals | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const raw = (err as Record<string, unknown>)[CARRY_KEY] as PartialUsage;
  return hasAgentUsage(raw) ? sumAgentUsage(raw) : undefined;
}

/** Session-message / SSE shape (`input_tokens` / `output_tokens`). */
export function toMessageUsage(usage: PartialUsage): { input_tokens: number; output_tokens: number } | undefined {
  if (!hasAgentUsage(usage)) return undefined;
  return { input_tokens: n(usage!.prompt_tokens), output_tokens: n(usage!.completion_tokens) };
}
