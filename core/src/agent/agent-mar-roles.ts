/**
 * Role planning + system notes for internal MAR (ADR-005).
 */
import { randomUUID } from 'node:crypto';
import type { AgentToolPack } from './agent-tool-pack.js';
import type { AgentRole, HandoffMessage } from './agent-mar-types.js';

export interface MarRolePlan {
  roles: AgentRole[];
  /** Why this plan was chosen (audit / status). */
  reason: string;
  toolPack: AgentToolPack;
}

export function newAgentIds(parentRunId?: string): { parentRunId: string; nextId: () => string } {
  const parent = parentRunId?.trim() || randomUUID();
  let n = 0;
  return {
    parentRunId: parent,
    nextId: () => `${parent.slice(0, 8)}-${++n}-${randomUUID().slice(0, 8)}`,
  };
}

/**
 * Decide serial specialist chain for one user turn.
 * Always starts with planner when dual-role mutate; browser/researcher append when intent matches.
 * After any mutate-capable coder chain, append read-only reviewer (mandatory Critic).
 */
export function planMarRoles(
  _message: string,
  opts?: {
    playwrightAvailable?: boolean;
    history?: Array<{ role?: string; content?: string }> | null;
    autopilot?: boolean;
    codeSession?: boolean;
  },
): MarRolePlan {
  void opts;
  return {
    roles: ['coder'],
    reason: 'model_directed_single_agent',
    toolPack: opts?.playwrightAvailable === false ? 'files' : 'files+browser',
  };
}

export function formatPlannerSystemNote(): string {
  return [
    '## MAR role: PLANNER (no mutate)',
    'You are the Planner specialist. Do NOT call write_file / edit_file / apply_patch / delete_file / rename_file.',
    'Output a short PLAN only:',
    'PLAN:',
    '- 목표: ...',
    '- P0 제약: 신규/기존 | do-not-touch | 진입점 | 데이터 출처',
    '- 대상 파일: ...',
    '- 변경 요지: ...',
    '- 검증: run_diagnostics / run_tests',
    'Do not claim 완료. Do not ask the user for 「진행」 — Supervisor owns approvals.',
    'After the PLAN block, stop. The Coder role will execute.',
  ].join('\n');
}

export function formatCoderSystemNote(handoff?: HandoffMessage): string {
  const handoffBlock = handoff
    ? [
        '## Handoff from Planner',
        handoff.task.slice(0, 4000),
        handoff.evidence ? `Evidence:\n${handoff.evidence.slice(0, 2000)}` : '',
        handoff.constraintsNote ? `Constraints:\n${handoff.constraintsNote}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  return [
    '## MAR role: CODER (execute)',
    'Execute the plan with tools. Prefer apply_patch. Verify with run_diagnostics.',
    'Do not ask for 「진행」. Intermediate status only — Supervisor owns the final 완료 claim.',
    'Answer the user naturally and preserve useful findings. Do not force a work-report template, changed-path list, diagnostics footer, or next-action section.',
    handoffBlock,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatBrowserSystemNote(handoff?: HandoffMessage): string {
  return [
    '## MAR role: BROWSER',
    'Verify UI in the browser (navigate / screenshot). Prefer evidence over speculation.',
    'Do not mutate workspace files in this role.',
    'Do not claim overall task 완료 — report browser findings only.',
    handoff?.task ? `## Prior context\n${handoff.task.slice(0, 3000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatResearcherSystemNote(handoff?: HandoffMessage): string {
  return [
    '## MAR role: RESEARCHER',
    'Produce a concise Korean research brief. No live web inventing of URLs/stats.',
    'Start with: ※ LLM 일반 지식 기반 초안입니다 (실시간 웹 검색 없음).',
    'Do not mutate files. Do not claim product 완료.',
    handoff?.task ? `## Prior context\n${handoff.task.slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatReviewerSystemNote(handoff?: HandoffMessage): string {
  return [
    '## MAR role: REVIEWER / CRITIC (read-only Validator)',
    'You are the mandatory Critic after Coder. Judge quality vs user request — do not re-implement.',
    'Re-read mutated paths (and product-facts / ui-facts when relevant).',
    'Check for: false 완료, overclaim (auto-test / frame bypass / 연결·연동 without call path), user debug deferral, missing verify evidence, HTML/JS boot wiring.',
    'Web SPA checklist (when .html/.js mutated): every getElementById("x") / querySelector("#x") must exist as id="x" in HTML (or be created in JS). Missing id → VERDICT: PARTIAL, next=wire that id.',
    'Exit-gate rule: 완료 조건 = 디스크·실행 증거 + (UI/shell) user Acceptance path. tsc/dotnet build alone ≠ PASS.',
    'UI/shell/chat-link: 「연결/인앱에서 열림」 needs call path (postMessage inAppBrowser.open or NavigationStarting→OpenInAppBrowser). `<a href>` alone → PARTIAL.',
    'gaps/next must name the unclosed Acceptance step (user-visible), not a file laundry list.',
    'Do NOT re-list already-verified facts; do NOT tell the user to re-run the same shell command as the only next step.',
    'You MUST include a machine-readable verdict. Prefer BOTH forms:',
    '1) Line: VERDICT: PASS | PARTIAL | FAIL',
    '2) JSON block:',
    '```json',
    '{"verdict":"PASS|PARTIAL|FAIL","gaps":["..."],"next":"..."}',
    '```',
    'Also output:',
    '결론: ...',
    '미충족: (≤3 bullets, or 없음)',
    '다음 수정: (exactly ONE unclosed Acceptance/exit gate — disk/execution evidence to close — or 없음). No redesign laundry list.',
    'No mutate tools. Never claim overall product 완료 — Supervisor owns the final user reply.',
    handoff?.mutatedPaths?.length
      ? `Mutated paths to re-read:\n${handoff.mutatedPaths.map((p) => `- ${p}`).join('\n')}`
      : 'No mutated paths listed — still verify coder claims against disk before PASS.',
    handoff?.task ? `## Prior (coder/planner)\n${handoff.task.slice(0, 3000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export { parseCriticNext as parseReviewerNext } from './agent-open-gate.js';

/** Parse Critic VERDICT from reviewer prose or embedded JSON. */
export function parseReviewerVerdict(text: string): 'PASS' | 'PARTIAL' | 'FAIL' | null {
  const raw = String(text || '');
  const line = raw.match(/\bVERDICT\s*[:：]\s*(PASS|PARTIAL|FAIL)\b/i);
  if (line?.[1]) return line[1]!.toUpperCase() as 'PASS' | 'PARTIAL' | 'FAIL';
  const jsonBlock = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = jsonBlock?.[1]?.trim() || raw.match(/\{[\s\S]*"verdict"\s*:\s*"(PASS|PARTIAL|FAIL)"[\s\S]*\}/i)?.[0];
  if (candidate) {
    try {
      const doc = JSON.parse(candidate) as { verdict?: string };
      const v = String(doc.verdict || '').toUpperCase();
      if (v === 'PASS' || v === 'PARTIAL' || v === 'FAIL') return v;
    } catch {
      const m = candidate.match(/"verdict"\s*:\s*"(PASS|PARTIAL|FAIL)"/i);
      if (m?.[1]) return m[1]!.toUpperCase() as 'PASS' | 'PARTIAL' | 'FAIL';
    }
  }
  return null;
}

/** Critic output missing required structured fields → one internal rewrite. */
export function reviewerNeedsStructuredRetry(text: string): boolean {
  const t = String(text || '').trim();
  if (t.length < 20) return true;
  const verdict = parseReviewerVerdict(t);
  if (!verdict) return true;
  if (!/(?:결론\s*[:：]|결론\s)/i.test(t)) return true;
  if (verdict !== 'PASS' && !/(?:미충족\s*[:：]|gaps)/i.test(t)) return true;
  return false;
}

export function formatReviewerStructuredRetryNote(): string {
  return [
    'SYSTEM: Your Critic reply was incomplete.',
    'Rewrite NOW with ALL of:',
    'VERDICT: PASS|PARTIAL|FAIL',
    '```json',
    '{"verdict":"PASS|PARTIAL|FAIL","gaps":[],"next":""}',
    '```',
    '결론: ...',
    '미충족: ...',
    '다음 수정: ...',
    'No tools. Critic only.',
  ].join('\n');
}

/** True when Critic blocks shipping a coder 완료 claim as-is. */
export function reviewerBlocksCompletion(reviewerText: string): boolean {
  const v = parseReviewerVerdict(reviewerText);
  if (v === 'FAIL') return true;
  if (v === 'PARTIAL') return true;
  if (v === 'PASS') return false;
  // No structured verdict — treat strong gap language as block.
  return /(?:미충족\s*[:：].{0,40}(?:있음|발견|문제)|완료\s*주장\s*(?:불가|차단|과장)|거짓\s*완료|증거\s*부족)/i.test(
    reviewerText,
  );
}

export function systemNoteForRole(role: AgentRole, handoff?: HandoffMessage): string {
  switch (role) {
    case 'planner':
      return formatPlannerSystemNote();
    case 'coder':
      return formatCoderSystemNote(handoff);
    case 'browser':
      return formatBrowserSystemNote(handoff);
    case 'researcher':
      return formatResearcherSystemNote(handoff);
    case 'reviewer':
      return formatReviewerSystemNote(handoff);
    default:
      return `## MAR role: ${role}`;
  }
}

/** Max steps per role (cost control). */
export function maxStepsForRole(role: AgentRole): number {
  switch (role) {
    case 'planner':
      return 8;
    case 'browser':
      return 10;
    case 'researcher':
      return 6;
    case 'reviewer':
      return 10;
    case 'coder':
      return 24;
    default:
      return 16;
  }
}
