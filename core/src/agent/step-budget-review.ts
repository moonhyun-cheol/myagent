import { chatCompletion, type ChatMessage } from '../providers/openai-compatible.js';
import type { ProviderStore } from '../providers/provider-store.js';
import { appendAgentAuditEvent } from './agent-audit-ledger.js';
import { APPROVAL_REVIEW_PROVIDER_ID } from './approval-auto-review.js';
import type { LlmUsageCost } from './llm-usage-cost.js';

/**
 * Step-budget review at the per-run cap (MAX_AGENT_STEPS).
 *
 * A general reasoning model (not a decision/classifier model) reads app-collected run facts
 * and the working model's last output, then chooses continue / redirect / stop_ask_user.
 * The host decides who grants the extra budget (「나 대신 승인」/Autopilot: automatic up to
 * STEP_BUDGET_MAX_AUTO_GRANTS times; otherwise the user is asked with an approval card).
 */
export const STEP_BUDGET_EXTENSION = 50;
export const STEP_BUDGET_MAX_AUTO_GRANTS = 2;
/**
 * Wall-time checkpoints: every 30 minutes of one run the same review runs even below the
 * step cap, so slow steps cannot keep a run going for hours unseen.
 */
export const STEP_BUDGET_TIME_CHECK_INTERVAL_MS = 30 * 60_000;
/** From this run age on, nothing is granted automatically; the user is asked. */
export const STEP_BUDGET_AUTO_GRANT_MAX_ELAPSED_MS = 60 * 60_000;

export type StepBudgetTrigger = 'steps' | 'time';

/**
 * Reviewer candidates in preference order (OpenRouter `~` aliases follow the newest release).
 * The first one from a different vendor than the working model is used, so the reviewer
 * never grades its own family's work. Live probe (prompt v2): Terra 6/6 real, 6/6 loop.
 */
export const STEP_BUDGET_REVIEWER_CANDIDATES: readonly string[] = [
  '~openai/gpt-terra-latest',
  '~anthropic/claude-sonnet-latest',
  '~google/gemini-pro-latest',
];

export type StepBudgetVerdict = 'continue' | 'redirect' | 'stop_ask_user';

export interface StepBudgetReview {
  verdict: StepBudgetVerdict;
  confidence: number;
  reason: string;
  /** Korean corrective instruction for redirect; empty otherwise. */
  instruction: string;
  reviewer: string;
}

export interface StepBudgetAction {
  step: number;
  tool: string;
  ok: boolean;
  target: string;
  failure?: string;
}

/** Tokens/cost this run has spent so far (host-computed from provider usage + price table). */
export interface StepBudgetResources {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** cached / input, 0..1. */
  cacheHitRate: number;
  /** USD so far; undefined when the model has no known price. */
  costUsd?: number;
  /** Estimated USD per step so far (costUsd / stepsUsed). */
  costPerStepUsd?: number;
}

export interface StepBudgetFacts {
  userRequest: string;
  stepsUsed: number;
  stepLimit: number;
  extensionsGranted: number;
  actions: readonly StepBudgetAction[];
  mutatedPaths: readonly string[];
  todoSummary?: string;
  lastModelOutput?: string;
  /** Spend of this run so far; lets the reviewer weigh progress against cost. */
  resources?: StepBudgetResources;
  /** Wall time of this run so far (ms). */
  elapsedMs?: number;
  /** Why the review runs: step cap reached, or a wall-time checkpoint. Default steps. */
  trigger?: StepBudgetTrigger;
}

/** Host decision passed back to the step loop. */
export interface StepBudgetGrant {
  extend: number;
  /** Message appended for the working model when extended. */
  note?: string;
  /** Shown in the stop notice when not extended. */
  stopReason?: string;
}

export type StepBudgetExhaustedHandler = (input: {
  facts: StepBudgetFacts;
  workingModelId: string;
  /** Extensions already granted automatically in this run. */
  autoGrantsUsed: number;
}) => Promise<StepBudgetGrant & { auto?: boolean }>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'reason', 'instruction'],
  properties: {
    decision: { type: 'string', enum: ['continue', 'redirect', 'stop_ask_user'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    instruction: { type: 'string' },
  },
} as const;

export function buildStepBudgetSystemPrompt(extension = STEP_BUDGET_EXTENSION): string {
  return [
    'You review an autonomous coding agent that has used its step budget for one user request.',
    'Decide what happens next:',
    `- continue: the work is on track and making progress toward the user's request; grant another ${extension} steps.`,
    `- redirect: the work drifted from the request, or is looping/repeating failures; give a concrete corrective instruction for the next ${extension} steps.`,
    '- stop_ask_user: the request is ambiguous, risky, or the agent is clearly stuck so that more steps would waste budget; ask the user.',
    'Judge only from the facts given. Reply with JSON {decision, confidence (0-1), reason (one sentence, Korean), instruction (Korean, empty for continue)}.',
    'Calibration: large tasks often spend the first 100 steps reading and searching before editing; that alone is progress, not drift.',
    'Choose redirect only with concrete evidence: the same failure repeating, or the touched files/commands clearly unrelated to the request.',
    'Choose stop_ask_user only when the request itself cannot be understood or continuing is risky.',
    'Resource usage (tokens, cache hit rate, USD so far) is context, not a verdict by itself: never stop only because a run is expensive.',
    `Use it to judge waste: high spend with repeated failures or no new files/progress supports redirect or stop_ask_user; high spend with steady progress is fine. The next ${extension} steps will cost roughly cost_per_step × ${extension}.`,
    'Elapsed wall time is also context: a long run with steady progress is fine, but a long run with few completed steps, repeated slow failures, or no new files supports redirect or stop_ask_user.',
    'When trigger is time, the step budget is not exhausted; decide whether the run should keep going at all (continue/redirect) or stop and ask the user.',
  ].join('\n');
}

function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

const oneLine = (value: string, max: number): string => redact(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);

/** Build reviewer resources from accumulated usage and the host cost estimate. */
export function buildStepBudgetResources(
  cost: Pick<LlmUsageCost, 'input_tokens' | 'output_tokens' | 'cached_input_tokens' | 'cache_write_input_tokens' | 'cache_hit_rate' | 'pricing_status' | 'total_cost_microusd'>,
  stepsUsed: number,
): StepBudgetResources {
  const priced = cost.pricing_status === 'priced' && typeof cost.total_cost_microusd === 'number';
  const costUsd = priced ? cost.total_cost_microusd! / 1_000_000 : undefined;
  return {
    inputTokens: cost.input_tokens,
    outputTokens: cost.output_tokens,
    cachedTokens: cost.cached_input_tokens,
    cacheWriteTokens: cost.cache_write_input_tokens,
    cacheHitRate: cost.cache_hit_rate,
    ...(costUsd === undefined ? {} : {
      costUsd,
      ...(stepsUsed > 0 ? { costPerStepUsd: costUsd / stepsUsed } : {}),
    }),
  };
}

const usd = (v: number): string => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const tokens = (v: number): string => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}K` : String(v));

/** Short Korean label for status lines / the approval card (e.g. 「입력 1.20M 토큰 (캐시 75%) · 약 $3.42 · 추가 50스텝 예상 약 $1.71」). */
export function formatStepBudgetResourceLabel(resources: StepBudgetResources | undefined, extension = STEP_BUDGET_EXTENSION): string {
  if (!resources || !(resources.inputTokens > 0 || resources.outputTokens > 0)) return '';
  const parts = [`입력 ${tokens(resources.inputTokens)} 토큰 (캐시 ${Math.round(resources.cacheHitRate * 100)}%)`, `출력 ${tokens(resources.outputTokens)}`];
  if (resources.costUsd !== undefined) {
    parts.push(`지금까지 약 ${usd(resources.costUsd)}`);
    if (resources.costPerStepUsd !== undefined) parts.push(`추가 ${extension}스텝 예상 약 ${usd(resources.costPerStepUsd * extension)}`);
  } else {
    parts.push('가격 정보 없음');
  }
  return parts.join(' · ');
}

export function buildStepBudgetFactsText(facts: StepBudgetFacts): string {
  const counts: Record<string, number> = {};
  let failed = 0;
  for (const a of facts.actions) {
    counts[a.tool] = (counts[a.tool] ?? 0) + 1;
    if (!a.ok) failed += 1;
  }
  const recent = facts.actions.slice(-30).map((a) =>
    `${a.step}. ${a.tool} [${a.ok ? 'success' : 'error'}] ${oneLine(a.target, 140)}${!a.ok && a.failure ? ` -> ${oneLine(a.failure, 100)}` : ''}`);
  const parts = [
    '## User request',
    redact(facts.userRequest.trim()).slice(-1200) || '(not recorded)',
    '',
    '## Run facts (app-collected)',
    `trigger: ${facts.trigger === 'time' ? 'time (wall-time checkpoint; step budget not exhausted)' : 'steps (step budget exhausted)'}`,
    `steps_used: ${facts.stepsUsed}/${facts.stepLimit}`,
    `extensions_already_granted: ${facts.extensionsGranted}`,
    `failed_steps: ${failed}`,
    `tool_counts: ${JSON.stringify(counts)}`,
    `files_mutated: ${facts.mutatedPaths.slice(0, 20).map((p) => oneLine(p, 80)).join(', ') || '(none)'}`,
  ];
  if (typeof facts.elapsedMs === 'number' && facts.elapsedMs >= 0) {
    const perStep = facts.stepsUsed > 0 ? facts.elapsedMs / facts.stepsUsed / 1000 : 0;
    parts.push(
      `elapsed_minutes: ${(facts.elapsedMs / 60_000).toFixed(1)}`,
      `avg_seconds_per_step: ${perStep.toFixed(1)}`,
    );
  }
  const r = facts.resources;
  if (r) {
    parts.push(
      '',
      '## Resource usage (this run, host-computed)',
      `input_tokens: ${r.inputTokens} (cached ${r.cachedTokens}, cache_write ${r.cacheWriteTokens}, cache_hit_rate ${(r.cacheHitRate * 100).toFixed(1)}%)`,
      `output_tokens: ${r.outputTokens}`,
      r.costUsd !== undefined
        ? `cost_usd_so_far: ${r.costUsd.toFixed(4)}; cost_per_step_usd: ${(r.costPerStepUsd ?? 0).toFixed(4)}`
        : 'cost_usd_so_far: unknown (no price for this model)',
    );
  }
  if (facts.todoSummary?.trim()) parts.push('', '## Agent TODO ledger', redact(facts.todoSummary.trim()).slice(0, 1500));
  if (facts.lastModelOutput?.trim()) parts.push('', '## Agent last message (its own progress note)', redact(facts.lastModelOutput.trim()).slice(-1200));
  parts.push('', `## Last ${recent.length} steps`, ...recent);
  return parts.join('\n');
}

/** Vendor of an OpenRouter-style id (`~openai/gpt-terra-latest` → openai); name heuristics for bare ids. */
export function modelVendor(modelId: string): string {
  const id = String(modelId || '').trim().toLowerCase().replace(/^~/, '');
  const slash = id.indexOf('/');
  if (slash > 0) return id.slice(0, slash);
  if (/^(gpt|o\d|chatgpt|codex)/.test(id)) return 'openai';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gemini') || id.startsWith('gemma')) return 'google';
  return id;
}

/** Candidates ordered so different-vendor models come first (same-vendor kept as last resort). */
export function pickStepBudgetReviewers(workingModelId: string): string[] {
  const vendor = modelVendor(workingModelId);
  const other = STEP_BUDGET_REVIEWER_CANDIDATES.filter((m) => modelVendor(m) !== vendor);
  const same = STEP_BUDGET_REVIEWER_CANDIDATES.filter((m) => modelVendor(m) === vendor);
  return [...other, ...same];
}

export function parseStepBudgetReview(content: string): Omit<StepBudgetReview, 'reviewer'> | null {
  const raw = String(content ?? '').trim().replace(/^```(?:json)?\s*|```\s*$/g, '');
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { row = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  }
  const verdict = row.decision;
  if (verdict !== 'continue' && verdict !== 'redirect' && verdict !== 'stop_ask_user') return null;
  const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
    ? Math.max(0, Math.min(1, row.confidence))
    : 0;
  return {
    verdict,
    confidence,
    reason: typeof row.reason === 'string' ? redact(row.reason.trim()).slice(0, 300) : '',
    instruction: verdict === 'redirect' && typeof row.instruction === 'string' ? redact(row.instruction.trim()).slice(0, 1200) : '',
  };
}

export type StepBudgetComplete = (request: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  wireApi: 'responses' | 'chat_completions';
  signal?: AbortSignal;
}) => Promise<{ content: string }>;

function defaultComplete(): StepBudgetComplete {
  return async (request) => chatCompletion(request.baseUrl, request.apiKey, request.model, request.messages, {
    wireApi: request.wireApi,
    timeoutMs: 90_000,
    signal: request.signal,
    reasoningEffort: 'medium',
    extraBody: request.wireApi === 'chat_completions'
      ? { max_tokens: 3000, response_format: { type: 'json_schema', json_schema: { name: 'step_budget_review', strict: true, schema: SCHEMA } } }
      : { max_output_tokens: 3000, text: { format: { type: 'json_schema', name: 'step_budget_review', strict: true, schema: SCHEMA } } },
  });
}

/**
 * Ask a reviewer model whether the run deserves more steps. Never throws: when every
 * reviewer fails the result is stop_ask_user with reviewer 'unavailable', so the host
 * falls back to asking the user instead of extending blindly.
 */
export async function reviewStepBudget(input: {
  providerStore: ProviderStore;
  cqrRoot: string;
  sessionId?: string;
  workingModelId: string;
  facts: StepBudgetFacts;
  signal?: AbortSignal;
  complete?: StepBudgetComplete;
  reviewers?: readonly string[];
}): Promise<StepBudgetReview> {
  const started = Date.now();
  const complete = input.complete ?? defaultComplete();
  const messages: ChatMessage[] = [
    { role: 'system', content: buildStepBudgetSystemPrompt() },
    { role: 'user', content: buildStepBudgetFactsText(input.facts) },
  ];
  const failures: string[] = [];
  for (const modelId of input.reviewers ?? pickStepBudgetReviewers(input.workingModelId)) {
    if (input.signal?.aborted) break;
    const provider = input.providerStore.resolveProvider(APPROVAL_REVIEW_PROVIDER_ID, modelId);
    if (!provider || (provider.wireApi !== 'responses' && provider.wireApi !== 'chat_completions')) {
      failures.push(`${modelId}: unavailable`);
      continue;
    }
    const label = `${provider.def.name}/${provider.modelId}`;
    try {
      const response = await complete({
        baseUrl: provider.baseUrl,
        apiKey: provider.secret.api_key,
        model: modelId,
        messages,
        wireApi: provider.wireApi,
        signal: input.signal,
      });
      const parsed = parseStepBudgetReview(response.content);
      if (!parsed) {
        failures.push(`${label}: invalid JSON`);
        continue;
      }
      const result: StepBudgetReview = { ...parsed, reviewer: label };
      audit(input.cqrRoot, input.sessionId, true, Date.now() - started, `${label}:${result.verdict}:${result.confidence}:${result.reason}`, input.facts.stepsUsed);
      return result;
    } catch (error) {
      failures.push(redact(`${label}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 200));
    }
  }
  const reason = `검토 모델을 쓸 수 없습니다 (${failures.join(' | ') || 'aborted'})`.slice(0, 480);
  audit(input.cqrRoot, input.sessionId, false, Date.now() - started, reason, input.facts.stepsUsed);
  return { verdict: 'stop_ask_user', confidence: 0, reason, instruction: '', reviewer: 'unavailable' };
}

function audit(cqrRoot: string, sessionId: string | undefined, ok: boolean, durationMs: number, detail: string, steps: number): void {
  try {
    appendAgentAuditEvent(cqrRoot, { type: 'budget_review', sessionId, ok, durationMs, detail: detail.slice(0, 600), steps });
  } catch {
    /* audit is best-effort */
  }
}

/**
 * A안 grant policy. stop = reviewer judged more steps wasteful (user can still say 「이어서」);
 * auto = 「나 대신 승인」/Autopilot within the auto-grant cap; ask = approval card.
 * An unavailable reviewer never auto-grants and never silently stops.
 */
export function decideStepBudgetGrant(input: {
  review: Pick<StepBudgetReview, 'verdict' | 'reviewer'>;
  approvalPolicy: 'ask' | 'delegate' | 'autopilot' | string;
  autoGrantsUsed: number;
  /** Run wall time; past STEP_BUDGET_AUTO_GRANT_MAX_ELAPSED_MS the user is always asked. */
  elapsedMs?: number;
  trigger?: StepBudgetTrigger;
}): 'auto' | 'ask' | 'stop' {
  const unavailable = input.review.reviewer === 'unavailable';
  if (unavailable) return 'ask';
  if (input.review.verdict === 'stop_ask_user') return 'stop';
  if ((input.elapsedMs ?? 0) >= STEP_BUDGET_AUTO_GRANT_MAX_ELAPSED_MS) return 'ask';
  // A time checkpoint grants no steps; under an hour the reviewer's go-ahead is enough.
  if (input.trigger === 'time') return 'auto';
  const delegated = input.approvalPolicy === 'delegate' || input.approvalPolicy === 'autopilot';
  return delegated && input.autoGrantsUsed < STEP_BUDGET_MAX_AUTO_GRANTS ? 'auto' : 'ask';
}

/** Korean minutes label (e.g. 「42분」, 「1시간 5분」). */
export function formatElapsedMinutes(elapsedMs: number): string {
  const total = Math.max(0, Math.round(elapsedMs / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

/** Working-model note appended when a wall-time checkpoint lets the run continue. */
export function formatStepBudgetTimeNote(review: StepBudgetReview, elapsedMs: number, grantedBy: 'auto' | 'user'): string {
  const lines = [
    `## 작업 시간 점검 (${formatElapsedMinutes(elapsedMs)} 경과, ${grantedBy === 'auto' ? '자동 승인' : '사용자 승인'})`,
    `검토 모델 판단: ${review.verdict === 'redirect' ? '방향 수정 필요' : '계속 진행'} — ${review.reason || '(이유 없음)'}`,
  ];
  if (review.verdict === 'redirect' && review.instruction) lines.push(`지시: ${review.instruction}`);
  lines.push('오래 걸리고 있습니다. 남은 일을 줄여 빨리 끝내고, 끝내기 어려우면 진행 상황과 남은 일을 정리해 보고하세요.');
  return lines.join('\n');
}

/** Working-model note appended when the budget is extended. */
export function formatStepBudgetExtensionNote(review: StepBudgetReview, extension: number, grantedBy: 'auto' | 'user'): string {
  const lines = [
    `## 실행 예산 연장 (+${extension} 스텝, ${grantedBy === 'auto' ? '자동 승인' : '사용자 승인'})`,
    `검토 모델 판단: ${review.verdict === 'redirect' ? '방향 수정 필요' : '계속 진행'} — ${review.reason || '(이유 없음)'}`,
  ];
  if (review.verdict === 'redirect' && review.instruction) lines.push(`지시: ${review.instruction}`);
  lines.push(`추가 ${extension} 스텝 안에 남은 일을 끝내고, 끝나지 않으면 진행 상황과 남은 일을 정리해 보고하세요.`);
  return lines.join('\n');
}
