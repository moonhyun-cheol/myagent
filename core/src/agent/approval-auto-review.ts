import { chatCompletion, type ChatMessage } from '../providers/openai-compatible.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { ToolApprovalRequest } from './tool-approval.js';
import { appendAgentAuditEvent } from './agent-audit-ledger.js';

export type ApprovalReviewDecision = 'allow' | 'ask_user';

export interface ApprovalReviewResult {
  decision: ApprovalReviewDecision;
  confidence: number;
  reason: string;
  reviewer: string;
}

export const APPROVAL_REVIEW_PROVIDER_ID = 'custom';
export const APPROVAL_REVIEW_MODEL_ID = 'openai/gpt-5.6-luna';

type CompleteReview = (input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}) => Promise<{ content: string }>;

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['allow', 'ask_user'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', maxLength: 240 },
  },
};

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

function auditReview(cqrRoot: string, event: Parameters<typeof appendAgentAuditEvent>[1]): void {
  try {
    appendAgentAuditEvent(cqrRoot, event);
  } catch {
    // Audit persistence must never convert a safe fallback into an execution failure.
  }
}

export function parseApprovalReview(content: string): Omit<ApprovalReviewResult, 'reviewer'> {
  try {
    const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? '';
    const row = JSON.parse(jsonText) as Record<string, unknown>;
    const decision = row.decision === 'allow' ? 'allow' : 'ask_user';
    const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? Math.max(0, Math.min(1, row.confidence))
      : 0;
    const reason = typeof row.reason === 'string' ? redactSecrets(row.reason.trim()).slice(0, 240) : 'Reviewer returned no reason.';
    // The reviewer owns the semantic decision. Confidence is telemetry for the UI/audit,
    // not a second local heuristic that can silently reverse an explicit allow.
    return { decision, confidence, reason };
  } catch {
    return { decision: 'ask_user', confidence: 0, reason: 'Reviewer response was not valid JSON.' };
  }
}

function safeArgsFacts(argsPreview: string): Record<string, unknown> {
  const facts: Record<string, unknown> = { preview_chars: argsPreview.length };
  try {
    const args = JSON.parse(argsPreview) as Record<string, unknown>;
    for (const key of ['path', 'new_path', 'action', 'command']) {
      if (typeof args[key] === 'string') facts[key] = redactSecrets(String(args[key])).slice(0, 400);
    }
    if (typeof args.content === 'string') facts.content_chars = args.content.length;
    if (typeof args.patch === 'string') {
      facts.patch_chars = args.patch.length;
      facts.patch_paths = [...args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete|Move) File:\s*(.+)$/gm)]
        .map((match) => redactSecrets(match[1].trim()).slice(0, 400))
        .slice(0, 20);
    }
    if (Array.isArray(args.files)) {
      facts.files = args.files.slice(0, 20).map((raw) => {
        const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        return {
          path: typeof row.path === 'string' ? redactSecrets(row.path).slice(0, 400) : '',
          action: typeof row.action === 'string' ? row.action : 'update',
          content_chars: typeof row.content === 'string' ? row.content.length : undefined,
          edits: Array.isArray(row.edits) ? row.edits.length : undefined,
        };
      });
    }
  } catch {
    facts.paths = [...argsPreview.matchAll(/"(?:path|new_path)"\s*:\s*"([^"]+)"/g)]
      .map((match) => redactSecrets(match[1]).slice(0, 400))
      .slice(0, 20);
  }
  return facts;
}

export function buildApprovalReviewContext(userMessage: string, request: ToolApprovalRequest): string {
  return JSON.stringify({
    user_intent: redactSecrets(userMessage.trim()).slice(0, 1200),
    tool: request.tool,
    operation_summary: request.summary.slice(0, 400),
    argument_facts: safeArgsFacts(request.argsPreview),
    deterministic_policy: {
      workspace_contained: request.delegable === true,
      destructive: request.danger,
      access: request.access ?? 'operation',
      targets: (request.targets ?? []).map((target) => redactSecrets(target).slice(0, 400)),
      excluded_operations: ['delete', 'rollback', 'plugin_change', 'external_write', 'office_binary_raw_write', 'administrator', 'secret_transmission', 'purchase'],
    },
  });
}

export async function reviewToolApproval(input: {
  providerStore: ProviderStore;
  cqrRoot: string;
  sessionId?: string;
  providerId?: string;
  modelId?: string;
  userMessage: string;
  request: ToolApprovalRequest;
  signal?: AbortSignal;
  complete?: CompleteReview;
}): Promise<ApprovalReviewResult> {
  const started = Date.now();
  const reviewerProviderId = input.providerId ?? APPROVAL_REVIEW_PROVIDER_ID;
  const reviewerModelId = input.modelId ?? APPROVAL_REVIEW_MODEL_ID;
  const provider = input.providerStore.resolveProvider(reviewerProviderId, reviewerModelId);
  if (!provider || provider.wireApi !== 'responses' || input.request.delegable !== true) {
    const result: ApprovalReviewResult = {
      decision: 'ask_user', confidence: 0, reason: 'Responses reviewer is unavailable or the operation is outside its safe boundary.', reviewer: 'policy',
    };
    auditReview(input.cqrRoot, { type: 'approval_review', sessionId: input.sessionId, tool: input.request.tool, ok: false, durationMs: Date.now() - started, detail: result.reason });
    return result;
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a narrow tool-approval reviewer operating under user-delegated authority.',
        'Allow when the proposed operation directly matches the user intent, stays within the active task scope, and has no material unapproved external side effect.',
        'A terminal command may be allowed when it is a non-destructive local build, test, inspection, formatting, or other reversible workspace operation without elevation or secret transmission.',
        'An external read may be allowed when it is needed for the active task and the named target is not a credential or secret store.',
        'Never allow deletion, rollback, plugin changes, external writes, raw Office-binary writes, administrator actions, secret transmission, purchases, or material scope expansion.',
        'When evidence is incomplete or ambiguous, ask_user. Return JSON only.',
      ].join(' '),
    },
    { role: 'user', content: buildApprovalReviewContext(input.userMessage, input.request) },
  ];

  try {
    const complete = input.complete ?? (async (request) => chatCompletion(
      request.baseUrl,
      request.apiKey,
      request.model,
      request.messages,
      {
        wireApi: 'responses',
        timeoutMs: 8_000,
        signal: request.signal,
        reasoningEffort: 'low',
        extraBody: {
          max_output_tokens: 220,
          text: { format: { type: 'json_schema', name: 'approval_review', strict: true, schema: REVIEW_SCHEMA } },
        },
      },
    ));
    const response = await complete({
      baseUrl: provider.baseUrl,
      apiKey: provider.secret.api_key,
      model: reviewerModelId,
      messages,
      signal: input.signal,
    });
    const parsed = parseApprovalReview(response.content);
    const result: ApprovalReviewResult = { ...parsed, reviewer: `${provider.def.name}/${provider.modelId}` };
    auditReview(input.cqrRoot, { type: 'approval_review', sessionId: input.sessionId, tool: input.request.tool, ok: result.decision === 'allow', durationMs: Date.now() - started, detail: `${result.decision}:${result.confidence}:${result.reason}` });
    return result;
  } catch (error) {
    const result: ApprovalReviewResult = { decision: 'ask_user', confidence: 0, reason: redactSecrets(`Reviewer unavailable: ${error instanceof Error ? error.message : String(error)}`).slice(0, 240), reviewer: `${provider.def.name}/${provider.modelId}` };
    auditReview(input.cqrRoot, { type: 'approval_review', sessionId: input.sessionId, tool: input.request.tool, ok: false, durationMs: Date.now() - started, detail: result.reason });
    return result;
  }
}
