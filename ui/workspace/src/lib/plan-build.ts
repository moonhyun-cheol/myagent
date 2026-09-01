/**
 * Plan → Build handoff helpers.
 * Build offer is driven by session `workspace_behavior === 'plan'` (not PLAN: regex).
 * Prompt text mirrors agent-runtime-facts.json behaviors.plan.build_prompt
 * (verify-workspace-behavior asserts match).
 */

export const PLAN_BUILD_USER_MESSAGE =
  '위 PLAN을 Agent 모드로 구현해 주세요. Locked P0·대상 파일·단계만 따르고, Exit Gate 1개만 닫으세요. PLAN에 없는 리팩터·범위 확장 금지. verify로 증거를 남기세요.';

/** Hide Build when the user already sent a follow-up after this plan turn. */
export function shouldOfferPlanBuild(
  messages: Array<{ role: string; content?: string; workspace_behavior?: string }>,
  index: number,
): boolean {
  const message = messages[index];
  if (message.role !== 'assistant') return false;
  if (message.workspace_behavior !== 'plan') return false;
  const text = String(message.content ?? '').trim();
  if (!text || text === '(빈 응답)' || text === '(중지됨)') return false;
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') return false;
  }
  return true;
}
