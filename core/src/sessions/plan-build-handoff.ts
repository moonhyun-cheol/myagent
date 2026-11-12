/**
 * Plan → Build handoff into a fresh conversation.
 *
 * Only the `PLAN:` block of the latest Plan reply travels: exploration prose stays in the
 * Plan chat, the new chat starts in Agent mode with its own model / reasoning, and the
 * Locked P0 is re-extracted from the same block so constraints survive the split.
 */
import { randomUUID } from 'node:crypto';
import { persistConstraintsFromAssistantText } from '../agent/agent-locked-constraints.js';
import { loadPlanBuildPrompt } from '../agent/agent-runtime-facts.js';
import { normalizeExecutionPolicy } from '../execution-policy.js';
import { isReasoningLevel } from '../providers/reasoning-levels.js';
import type { SessionStore } from './session-store.js';
import type { SessionMessage, SessionRecord } from './types.js';

const PLAN_HEADER_RE = /^\s*(?:#{1,6}\s+)?(?:\*\*)?PLAN(?:\*\*)?\s*(?:[:：]\s*(?:\*\*)?\s*(.*))?$/;
const PLAN_ITEM_RE = /^(?:\s+\S|[-*•]\s|\d+[.)]\s)/;
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * Cut the last `PLAN:` block (header + its bullet list) out of a Plan reply.
 * Returns null when the reply does not follow the PLAN format.
 */
export function extractPlanBlock(text: string): string | null {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const header = lines[start]!.match(PLAN_HEADER_RE);
    if (!header) continue;
    const inline = (header[1] ?? '').replace(/\*\*$/, '').trim();
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (FENCE_RE.test(line)) break;
      if (!line.trim()) {
        body.push('');
        continue;
      }
      if (!PLAN_ITEM_RE.test(line)) break;
      body.push(line.replace(/\s+$/, ''));
    }
    while (body.length && !body[body.length - 1]!.trim()) body.pop();
    const items = body.filter((line) => /^[-*•]\s/.test(line));
    if (items.length < 2) continue;
    return [`PLAN:${inline ? ` ${inline}` : ''}`, ...body].join('\n');
  }
  return null;
}

export function formatPlanBuildMessage(cqrRoot: string, planBlock: string): string {
  return `${loadPlanBuildPrompt(cqrRoot)}\n\n${planBlock.trim()}`;
}

/** PLAN items Build cannot run without (Acceptance / 미결정 may legitimately be n/a). */
const REQUIRED_PLAN_FIELDS: Array<{ label: string; re: RegExp }> = [
  { label: '목표', re: /^[-*•]\s*(?:\*\*)?목표/m },
  { label: 'P0', re: /^[-*•]\s*(?:\*\*)?P0/m },
  { label: '대상 파일', re: /^[-*•]\s*(?:\*\*)?대상\s*파일/m },
  { label: '단계', re: /^[-*•]\s*(?:\*\*)?단계/m },
  { label: 'Exit Gate', re: /^[-*•]\s*(?:\*\*)?Exit\s*Gate/im },
];

/** Required PLAN items missing from a block (e.g. a follow-up reply that only listed the changes). */
export function missingPlanFields(planBlock: string): string[] {
  return REQUIRED_PLAN_FIELDS.filter((field) => !field.re.test(planBlock)).map((field) => field.label);
}

/** Same-chat follow-up asking the Plan model to restate the full PLAN block (no new exploration). */
export const PLAN_REFORMAT_MESSAGE =
  '지금까지 정한 내용을 PLAN 블록 전체(목표·P0·대상 파일·Acceptance·단계·미결정·Exit Gate)로 다시 정리해 주세요. '
  + '새로 탐색하지 말고 이 대화에서 확인한 내용만 쓰세요.';

export type PlanBuildPreview =
  | { status: 'ready' | 'incomplete'; missing_fields: string[]; plan_block: string; reformat_message: string }
  | { status: 'missing'; missing_fields: string[]; reformat_message: string }
  | { status: 'not_buildable'; message: string };

/** Dry-run of the handoff: what Build would carry, so the dialog can warn before creating a chat. */
export function previewPlanBuild(rec: SessionRecord): PlanBuildPreview {
  const plan = buildablePlanMessage(rec);
  if (!plan) return { status: 'not_buildable', message: 'Build할 수 있는 최신 PLAN 답변이 없습니다.' };
  const block = extractPlanBlock(plan.content);
  if (!block) {
    return {
      status: 'missing',
      missing_fields: REQUIRED_PLAN_FIELDS.map((field) => field.label),
      reformat_message: PLAN_REFORMAT_MESSAGE,
    };
  }
  const missing = missingPlanFields(block);
  return {
    status: missing.length ? 'incomplete' : 'ready',
    missing_fields: missing,
    plan_block: block,
    reformat_message: PLAN_REFORMAT_MESSAGE,
  };
}

/** Latest Plan reply eligible for Build (same rule as the UI offer: nothing sent after it). */
export function buildablePlanMessage(rec: SessionRecord): SessionMessage | null {
  const last = rec.messages[rec.messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (last.workspace_behavior !== 'plan' || last.status === 'stopped') return null;
  if (last.plan_built_session_id) return null;
  const text = last.content.trim();
  if (!text || text === '(빈 응답)' || text === '(중지됨)') return null;
  return last;
}

export type PlanBuildHandoffResult =
  | {
      ok: true;
      session: SessionRecord;
      build_message: string;
      plan_constraints_locked: boolean;
      missing_fields: string[];
    }
  | { ok: false; status: number; error: string; message: string };

export function createPlanBuildHandoff(opts: {
  sessionStore: SessionStore;
  cqrRoot: string;
  sourceSessionId: string;
  model?: unknown;
  reasoning?: unknown;
}): PlanBuildHandoffResult {
  const { sessionStore, cqrRoot } = opts;
  const source = sessionStore.load(opts.sourceSessionId);
  if (!source) return { ok: false, status: 404, error: 'SESSION_NOT_FOUND', message: '원래 대화를 찾을 수 없습니다.' };
  const plan = buildablePlanMessage(source);
  if (!plan) {
    return { ok: false, status: 409, error: 'PLAN_NOT_BUILDABLE', message: 'Build할 수 있는 최신 PLAN 답변이 없습니다.' };
  }
  const block = extractPlanBlock(plan.content);
  if (!block) {
    return {
      ok: false,
      status: 422,
      error: 'PLAN_BLOCK_MISSING',
      message: '답변에 PLAN: 블록이 없어 새 대화로 넘길 수 없습니다. Plan 모드에서 PLAN 형식으로 다시 요청하세요.',
    };
  }
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (model.length > 240) return { ok: false, status: 400, error: 'INVALID_MODEL', message: '모델 이름이 올바르지 않습니다.' };
  if (opts.reasoning !== undefined && !isReasoningLevel(opts.reasoning)) {
    return { ok: false, status: 400, error: 'INVALID_REASONING', message: '추론 수준이 올바르지 않습니다.' };
  }

  const sourcePolicy = normalizeExecutionPolicy(source.execution_policy);
  const targetId = randomUUID();
  sessionStore.ensure(targetId, {
    project_id: source.project_id ?? null,
    execution_policy: {
      ...sourcePolicy,
      reasoning: isReasoningLevel(opts.reasoning) ? opts.reasoning : sourcePolicy.reasoning,
      autopilot: 'auto',
      workspace_behavior: 'agent',
    },
  });
  // Same folder binding / path grants as the Plan chat (binding first: it resets grants).
  if (source.workspace_binding_explicit) {
    sessionStore.setWorkspaceProject(targetId, source.workspace_project_id ?? null);
  }
  if (source.allowed_paths?.length) {
    sessionStore.setScopeSettings(targetId, { allowed_paths: source.allowed_paths });
  }
  if (model && model !== 'auto') sessionStore.setPreferredModel(targetId, model);
  sessionStore.rename(targetId, `${source.title.trim().slice(0, 40) || '대화'} · Build`);

  const constraints = persistConstraintsFromAssistantText({
    cqrRoot,
    sessionId: targetId,
    assistantText: block,
  });
  sessionStore.markPlanBuilt(source.id, targetId);

  const session = sessionStore.load(targetId);
  if (!session) return { ok: false, status: 500, error: 'SESSION_CREATE_FAILED', message: '새 대화를 만들지 못했습니다.' };
  return {
    ok: true,
    session,
    build_message: formatPlanBuildMessage(cqrRoot, block),
    plan_constraints_locked: Boolean(constraints),
    missing_fields: missingPlanFields(block),
  };
}
