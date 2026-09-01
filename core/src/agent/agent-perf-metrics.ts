/**
 * Host / run performance snapshots for bakeoff + session run-meta (P2).
 * Does not claim speedups — only records measurable fields.
 */
import { cpus, freemem, platform, totalmem, arch, release } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { softRpmLimit, softStepLatencyWarnMs } from '../providers/harness-policy.js';
import type { ProviderWireApi } from '../providers/types.js';
import type { ResponsesContinuationState } from '../sessions/types.js';
import type { LlmUsageCost } from './llm-usage-cost.js';

export interface ResponsesPerfState {
  mode: 'provider_state' | 'client_replay';
  has_previous_response_id: boolean;
  next_message_index: number;
  replay_item_count: number;
  reasoning_context?: string;
  usage?: ResponsesContinuationState['usage'];
}

export function summarizeResponsesPerfState(
  state: ResponsesContinuationState | undefined,
): ResponsesPerfState | undefined {
  if (!state) return undefined;
  return {
    mode: state.mode,
    has_previous_response_id: Boolean(state.previous_response_id),
    next_message_index: state.next_message_index,
    replay_item_count: state.replay_items?.length ?? 0,
    reasoning_context: state.reasoning_context,
    usage: state.usage ? { ...state.usage } : undefined,
  };
}

export interface PerfEnvSnapshot {
  os: string;
  arch: string;
  release: string;
  cpuModel: string;
  cpuCores: number;
  totalMemMb: number;
  freeMemMb: number;
  node: string;
  modelId?: string;
  providerId?: string;
  baseUrlHost?: string;
  protocol?: 'api' | 'client' | string;
  /** Actual LLM HTTP transport selected from the encrypted provider config. */
  wire_api?: ProviderWireApi;
  /** Native/API vs locally parsed TEXT TOOL_CALL. */
  tool_protocol?: 'api' | 'client' | string;
  /** From MY_AGENT_REASONING_EFFORT (null/omit when off). */
  reasoning_effort?: string | null;
  /** Effective Autopilot (env or user override). */
  autopilot?: boolean;
  /** From MY_AGENT_OWUI_PROTOCOL. */
  owui_protocol?: string;
}

export interface AgentPerfSnapshot {
  at: string;
  wall_ms: number;
  llm_round_trips: number;
  tool_calls: number;
  /** Sum of observed LLM wait intervals (ms); excludes pure tool execution when separable. */
  llm_completion_ms?: number;
  approval_wait_ms?: number;
  orchestration_ms?: number;
  /** First-token style wait if streamed; optional. */
  llm_ttft_ms?: number;
  /**
   * Wall ms from run start to first successful tool-call booking (execute path).
   * Product latency RCA (not model TTFT alone).
   */
  first_tool_ms?: number;
  /**
   * Autopilot force-TOOL_CALL count this run (empty-after-mutate branch).
   * 0 is healthy greenfield; spikes mean residual spin.
   */
  autopilot_force_count?: number;
  /** Mutate path count this run. */
  mutated_count?: number;
  /** Agent step count. */
  steps?: number;
  /**
   * Coarse stop reason for harness RCA (ok | unparsed_tool_call | hitl_block |
   * retrieval_block | wiring_smoke | refuse | abort | unknown).
   */
  early_exit_reason?: string;
  /** Safe per-round timing only; never includes prompts or tool arguments. */
  llm_trace?: Array<{
    step: number;
    label: string;
    duration_ms: number;
    wire_api: ProviderWireApi;
    responses_before?: ResponsesPerfState;
    responses_after?: ResponsesPerfState;
    responses_chain_advanced?: boolean;
  }>;
  /** Safe tool timing/outcome only; never includes file paths, args, or output. */
  tool_trace?: Array<{
    step: number;
    name: string;
    ok: boolean;
    duration_ms: number;
    failure_type?: string;
    exit_code?: number;
    skipped?: boolean;
    weak?: boolean;
  }>;
  approval_trace?: Array<{
    step: number;
    name: string;
    duration_ms: number;
    approved: boolean;
    delegable: boolean;
    access?: import('./tool-approval.js').ToolApprovalAccess;
  }>;
  responses_state?: ResponsesPerfState;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
  };
  /** Host-side estimate derived after the response; never injected into the prompt. */
  cost?: LlmUsageCost;
  env: PerfEnvSnapshot;
}

/** Infer harness stop reason from final answer + counters (best-effort). */
export function inferEarlyExitReason(input: {
  content: string;
  mutatedCount: number;
  retrievalGateBlocks?: number;
  hitlDenied?: boolean;
  aborted?: boolean;
  refused?: boolean;
  diagnostics?: true | false | 'weak' | null;
  claimsIncomplete?: boolean;
}): string {
  if (input.refused) return 'refuse';
  if (input.aborted) return 'abort';
  if (input.hitlDenied) return 'hitl_block';
  if (input.claimsIncomplete) return 'incomplete';
  if (input.diagnostics === false) return 'verification_failed';
  if (input.diagnostics === 'weak') return 'verification_weak';
  if ((input.retrievalGateBlocks ?? 0) > 0 && input.mutatedCount === 0) return 'retrieval_block';
  const t = String(input.content || '');
  if (/HTML\/JS\s*런타임\s*배선|dom_id:#|wiring smoke/i.test(t)) return 'wiring_smoke';
  if (
    /(?:^|\n)\s*TOOL_CALL:?\s*\{/im.test(t)
    && !/(?:완료했|반영했|해결\s*완료|변경 증거)/i.test(t)
  ) {
    return 'unparsed_tool_call';
  }
  return 'ok';
}

export function collectPerfEnv(partial?: Partial<PerfEnvSnapshot>): PerfEnvSnapshot {
  const list = cpus();
  let host = partial?.baseUrlHost;
  if (!host && partial && 'baseUrl' in (partial as object)) {
    /* ignore */
  }
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    cpuModel: list[0]?.model?.trim() || 'unknown',
    cpuCores: list.length,
    totalMemMb: Math.round(totalmem() / (1024 * 1024)),
    freeMemMb: Math.round(freemem() / (1024 * 1024)),
    node: process.version,
    modelId: partial?.modelId,
    providerId: partial?.providerId,
    baseUrlHost: host ?? partial?.baseUrlHost,
    protocol: partial?.protocol,
    wire_api: partial?.wire_api,
    tool_protocol: partial?.tool_protocol ?? partial?.protocol,
    reasoning_effort: partial?.reasoning_effort,
    autopilot: partial?.autopilot,
    owui_protocol: partial?.owui_protocol,
  };
}

export function hostFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//i, '').split('/')[0] || undefined;
  }
}

/** True when a bakeoff/summary-style object has required perf fields. */
export function isValidPerfReport(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Record<string, unknown>;
  const env = d.env;
  if (!env || typeof env !== 'object') return false;
  const e = env as Record<string, unknown>;
  const need = ['os', 'cpuCores', 'totalMemMb', 'node'] as const;
  for (const k of need) {
    if (e[k] == null) return false;
  }
  if (typeof d.wall_ms !== 'number' && !Array.isArray(d.ranking)) return false;
  return true;
}

export function writePerfJsonl(
  cqrRoot: string,
  snap: AgentPerfSnapshot,
): void {
  const dir = path.join(cqrRoot, 'data', 'logs');
  mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'agent-perf.jsonl');
  const soft = evaluateSoftCostWarnings({
    wall_ms: snap.wall_ms,
    llm_round_trips: snap.llm_round_trips,
  });
  const row = soft.length ? { ...snap, soft_cost_warns: soft } : snap;
  if (soft.length) rememberSoftCostWarns(soft);
  appendFileSync(fp, `${JSON.stringify(row)}\n`, 'utf8');
}

const softWarnRing: { at: string; warns: string[] }[] = [];

export function rememberSoftCostWarns(warns: string[]): void {
  if (!warns.length) return;
  softWarnRing.push({ at: new Date().toISOString(), warns: warns.slice(0, 8) });
  while (softWarnRing.length > 20) softWarnRing.shift();
}

export function listRecentSoftCostWarns(): { at: string; warns: string[] }[] {
  return softWarnRing.slice(-10);
}

/** Soft cost budget warnings (never hard-kill). */
export function evaluateSoftCostWarnings(input: {
  wall_ms: number;
  llm_round_trips: number;
  windowMs?: number;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = input.env ?? process.env;
  const warns: string[] = [];
  const rpm = softRpmLimit(env);
  if (rpm && input.llm_round_trips > 0) {
    const window = Math.max(1, input.windowMs ?? input.wall_ms);
    const estimatedRpm = (input.llm_round_trips / window) * 60_000;
    if (estimatedRpm > rpm) {
      warns.push(`soft_rpm_warn: ~${estimatedRpm.toFixed(1)} > ${rpm}`);
    }
  }
  const lat = softStepLatencyWarnMs(env);
  if (input.wall_ms > lat) {
    warns.push(`soft_latency_warn: wall_ms=${input.wall_ms} > ${lat}`);
  }
  return warns;
}

export function writePerfSnapshotFile(
  cqrRoot: string,
  relativeName: string,
  snap: AgentPerfSnapshot | Record<string, unknown>,
): string {
  const dir = path.join(cqrRoot, 'data', '_model_bakeoff');
  mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, relativeName);
  writeFileSync(fp, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
  return fp;
}

export function ensurePerfLogDir(cqrRoot: string): void {
  const dir = path.join(cqrRoot, 'data', 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
