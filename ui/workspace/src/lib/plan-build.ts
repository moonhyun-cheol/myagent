/**
 * Plan → Build handoff helpers.
 * Build offer is driven by session `workspace_behavior === 'plan'` (not PLAN: regex).
 * Build always opens a new Agent conversation: the server cuts the PLAN block, builds the
 * first message from agent-runtime-facts.json behaviors.plan.build_prompt and copies the
 * Locked P0 (`POST /sessions/:id/plan-build-handoff`).
 */
import type { ReasoningLevel } from '../api/myAgentClient';

/** Hide Build when the user already sent a follow-up or the plan was already built. */
export function shouldOfferPlanBuild(
  messages: Array<{ role: string; content?: string; workspace_behavior?: string; plan_built_session_id?: string }>,
  index: number,
): boolean {
  const message = messages[index];
  if (message.role !== 'assistant') return false;
  if (message.workspace_behavior !== 'plan') return false;
  if (message.plan_built_session_id) return false;
  const text = String(message.content ?? '').trim();
  if (!text || text === '(빈 응답)' || text === '(중지됨)') return false;
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') return false;
  }
  return true;
}

const LAST_BUILD_KEY = 'my-agent-plan-build-last';

export interface PlanBuildPreference {
  model: string;
  reasoning: ReasoningLevel;
}

/** Last model / reasoning used for Build (the Plan chat usually runs a costlier model). */
export function readLastPlanBuildPreference(): PlanBuildPreference | null {
  try {
    const raw = localStorage.getItem(LAST_BUILD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlanBuildPreference>;
    if (typeof parsed.model !== 'string' || !parsed.model.trim() || typeof parsed.reasoning !== 'string') return null;
    return { model: parsed.model, reasoning: parsed.reasoning as ReasoningLevel };
  } catch {
    return null;
  }
}

export function saveLastPlanBuildPreference(pref: PlanBuildPreference): void {
  try {
    localStorage.setItem(LAST_BUILD_KEY, JSON.stringify(pref));
  } catch {
    /* preference only */
  }
}
