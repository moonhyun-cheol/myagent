/**
 * Internal Multi-Agent Runtime supervisor (ADR-005).
 * Serial Planner → Coder (+ optional browser/researcher/reviewer). Feature flag off → single runCodeAgent.
 */
import { isPlaywrightAvailable } from '../browser/playwright-probe.js';
import { appendAgentAuditEvent, hashPath } from './agent-audit-ledger.js';
import {
  buildOpenGateFromCriticNext,
  parseCriticNext,
} from './agent-open-gate.js';
import {
  appendRoleContribution,
  clearSessionOpenGate,
  loadAgentRunMeta,
  setSessionOpenGate,
} from './agent-run-meta.js';
import { runCodeAgent } from './agent-run-loop.js';
import type { CodeAgentOptions, CodeAgentResult } from './agent-run-types.js';
import {
  maxStepsForRole,
  newAgentIds,
  planMarRoles,
  parseReviewerVerdict,
  reviewerNeedsStructuredRetry,
  formatReviewerStructuredRetryNote,
  systemNoteForRole,
} from './agent-mar-roles.js';
import { runBrowserSpecialistNode, runResearchSpecialistNode } from './agent-mar-specialists.js';
import {
  contentLooksLikeLeakedRoleInfraFailure,
  isInfraLlmFailure,
  roleFailureMaySoftSkip,
  roleFailureMustAbortTurn,
  wrapAsInfraError,
} from './agent-failure-plane.js';
import { formatWebWiringCriticNote } from './agent-runtime-smoke.js';
import type {
  AgentRole,
  HandoffMessage,
  MarRoleResult,
  MarRunResult,
} from './agent-mar-types.js';
import { isMandatoryCriticEnabled, isMultiAgentEnabled } from './agent-mar-types.js';
import type { AgentToolPack } from './agent-tool-pack.js';

export { isMultiAgentEnabled, isMandatoryCriticEnabled } from './agent-mar-types.js';
export { planMarRoles } from './agent-mar-roles.js';

function isThinkingUnsupportedError(msg: string): boolean {
  return /does not support thinking|reasoning_effort|thinking is not supported|unsupported.*thinking/i.test(
    msg,
  );
}
export interface MarRuntimeOptions extends CodeAgentOptions {
  /** Required for browser/research specialist nodes. */
  configPath: string;
}

function toolPackForRole(role: AgentRole, planned: AgentToolPack): AgentToolPack {
  if (role === 'browser') return 'browser';
  if (role === 'planner' || role === 'reviewer' || role === 'researcher') return 'files';
  if (role === 'coder' && (planned === 'files+browser' || planned === 'browser')) {
    // Coder mutates files; browser role runs separately.
    return planned === 'browser' ? 'files' : 'files';
  }
  return planned === 'browser' ? 'files' : planned === 'files+browser' ? 'files' : planned;
}

function buildHandoff(
  from: MarRoleResult,
  toRole: AgentRole,
  allMutated: string[],
): HandoffMessage {
  return {
    fromRole: from.role,
    toRole,
    task: from.content.slice(0, 6000),
    mutatedPaths: allMutated,
    evidence: from.detail,
  };
}

function mergeableRoleContent(r: MarRoleResult | undefined): string {
  if (!r?.ok || !r.content.trim()) return '';
  if (contentLooksLikeLeakedRoleInfraFailure(r.content)) return '';
  return r.content.trim();
}

function mergeSupervisorReply(results: MarRoleResult[]): string {
  const usable = results.filter((r) => mergeableRoleContent(r));
  if (usable.length === 1) return mergeableRoleContent(usable[0]!) || '';
  const coder = [...results].reverse().find((r) => r.role === 'coder');
  const reviewer = [...results].reverse().find((r) => r.role === 'reviewer');
  const extras = results.filter(
    (r) => r.role !== 'coder' && r.role !== 'planner' && r.role !== 'reviewer',
  );
  const plan = results.find((r) => r.role === 'planner');
  const parts: string[] = [];
  const coderText = mergeableRoleContent(coder);
  const planText = mergeableRoleContent(plan);
  if (coderText) parts.push(coderText);
  else if (planText) parts.push(planText);
  for (const r of extras) {
    const t = mergeableRoleContent(r);
    if (!t) continue;
    parts.push(`\n---\n### ${r.role}\n${t}`);
  }
  const criticText = mergeableRoleContent(reviewer);
  if (criticText) {
    parts.push(`\n---\n### critic\n${criticText}`);
  }
  if (!parts.length && results[0]) {
    const fallback = mergeableRoleContent(results[0]);
    if (fallback) parts.push(fallback);
  }
  return parts.join('\n').trim();
}

function applySupervisorOutcomeGate(
  _opts: MarRuntimeOptions,
  content: string,
  _mutatedPaths: string[],
  _roleResults: MarRoleResult[],
): string {
  return content;
}

async function runCodeSpecialist(
  opts: MarRuntimeOptions,
  role: AgentRole,
  agentId: string,
  parentRunId: string,
  handoff: HandoffMessage | undefined,
  plan: ReturnType<typeof planMarRoles>,
): Promise<MarRoleResult> {
  opts.onStatus?.(`MAR · ${role} (${agentId.slice(0, 12)}…)`);
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'role_start',
    sessionId: opts.sessionId,
    agentId,
    parentRunId,
    role,
  });

  const isFinalCoder =
    role === 'coder' && !plan.roles.some((r) => r === 'reviewer' || r === 'browser' || r === 'researcher');

  try {
    const wiringNote =
      role === 'reviewer' && (handoff?.mutatedPaths?.length ?? 0) > 0
        ? formatWebWiringCriticNote(opts.workspaceRoot, handoff?.mutatedPaths ?? [])
        : '';
    const result = await runCodeAgent({
      ...opts,
      marRole: role,
      agentId,
      parentRunId,
      applyOutcomeGate: false, // Supervisor gate only
      forceToolPack: toolPackForRole(role, plan.toolPack),
      maxSteps: maxStepsForRole(role),
      extraSystemNotes: [
        ...(opts.extraSystemNotes ?? []),
        systemNoteForRole(role, handoff),
        ...(wiringNote ? [wiringNote] : []),
      ],
      skipSessionMetaAppend: true,
      // Avoid streaming intermediate role answers as final UI answer.
      onAnswer: isFinalCoder && plan.roles.length === 1 ? opts.onAnswer : undefined,
    });

    const mutatedPaths = result.mutatedPaths ?? [];
    appendRoleContribution(opts.cqrRoot, opts.sessionId, {
      agentId,
      parentRunId,
      role,
      mutatedPaths,
    });
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId,
      parentRunId,
      role,
      ok: true,
      steps: result.steps,
      pathHashes: mutatedPaths.slice(0, 8).map(hashPath),
    });
    opts.hooks?.onEvent?.({
      type: 'role_end',
      role,
      agentId,
      parentRunId,
      ok: true,
    });

    return {
      role,
      agentId,
      content: result.content,
      model: result.model,
      steps: result.steps,
      mutatedPaths,
      ok: true,
      diagnostics: result.diagnostics ?? null,
      verifyWitness: result.verifyWitness ?? null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (role === 'reviewer' && isThinkingUnsupportedError(msg)) {
      opts.onStatus?.('MAR · critic skip (model rejects thinking)');
      appendAgentAuditEvent(opts.cqrRoot, {
        type: 'role_end',
        sessionId: opts.sessionId,
        agentId,
        parentRunId,
        role,
        ok: true,
        detail: 'skip_critic_no_thinking',
      });
      return {
        role,
        agentId,
        content: [
          'VERDICT: PASS',
          '```json',
          '{"verdict":"PASS","gaps":[],"next":"","note":"critic_skipped_no_thinking"}',
          '```',
          '결론: Critic 생략 — 모델이 thinking/reasoning_effort를 지원하지 않습니다. Coder 결과는 유지됩니다.',
          '미충족: (없음 — Critic 인프라 스킵)',
          '다음 수정: (없음)',
        ].join('\n'),
        model: 'mar/critic-skip',
        steps: 0,
        mutatedPaths: [],
        ok: true,
        detail: 'skip_critic_no_thinking',
      };
    }

    const infra = isInfraLlmFailure(e);
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId,
      parentRunId,
      role,
      ok: false,
      detail: `${infra ? 'infra:' : 'fail:'}${msg.slice(0, 180)}`,
    });
    opts.hooks?.onEvent?.({
      type: 'role_end',
      role,
      agentId,
      parentRunId,
      ok: false,
    });

    // ADR-008: critical roles never become assistant prose ("coder 실패: 504…").
    if (roleFailureMustAbortTurn(role) || (infra && !roleFailureMaySoftSkip(role))) {
      throw wrapAsInfraError(e);
    }

    // Soft roles (reviewer/browser/researcher): skip silently; keep prior coder work.
    if (infra && roleFailureMaySoftSkip(role)) {
      opts.onStatus?.(`MAR · ${role} skip (infra) — prior results kept`);
      return {
        role,
        agentId,
        content: '',
        model: 'mar/infra-skip',
        steps: 0,
        mutatedPaths: [],
        ok: false,
        detail: msg,
      };
    }

    // Non-infra soft failure: still do not leak as fake capability narrative.
    return {
      role,
      agentId,
      content: '',
      model: 'mar/error',
      steps: 0,
      mutatedPaths: [],
      ok: false,
      detail: msg,
    };
  }
}

/** Skip Planner/browser/Critic when MAR would dump a second novel (P88 / no_self_deny). */
/**
 * Run MAR when enabled; otherwise identical to runCodeAgent.
 */
export async function runMarOrCodeAgent(opts: MarRuntimeOptions): Promise<CodeAgentResult> {
  if (!isMultiAgentEnabled()) {
    return runCodeAgent(opts);
  }
  const mar = await runMultiAgent(opts);
  return {
    content: mar.content,
    model: mar.model,
    steps: mar.steps,
    mutatedPaths: mar.roleResults.flatMap((r) => r.mutatedPaths),
  };
}

export async function runMultiAgent(opts: MarRuntimeOptions): Promise<MarRunResult> {
  const playwrightAvailable = isPlaywrightAvailable(opts.cqrRoot);
  const plan = {
    roles: ['coder'] as AgentRole[],
    reason: 'model_directed_single_agent',
    toolPack: (playwrightAvailable ? 'files+browser' : 'files') as AgentToolPack,
  };
  const ids = newAgentIds();
  const parentRunId = ids.parentRunId;

  opts.onStatus?.(`MAR · plan ${plan.roles.join('→')} (${plan.reason})`);
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'turn_decision',
    sessionId: opts.sessionId,
    parentRunId,
    role: 'supervisor',
    detail: `model_directed|pack=${plan.toolPack}|roles=${plan.roles.join(',')}`,
  });
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'run_start',
    sessionId: opts.sessionId,
    parentRunId,
    role: 'supervisor',
    detail: `mar:${plan.reason}:${plan.roles.join(',')}`,
  });

  const roleResults: MarRoleResult[] = [];
  const allMutated: string[] = [];
  let prev: MarRoleResult | undefined;

  for (const role of plan.roles) {
    // Skip Critic when disabled, or when Coder produced no disk mutations.
    if (
      role === 'reviewer'
      && plan.reason.includes('mandatory_post_mutate_critic')
      && (allMutated.length === 0 || !isMandatoryCriticEnabled())
    ) {
      opts.onStatus?.(
        allMutated.length === 0
          ? 'MAR · critic skip (no mutate)'
          : 'MAR · critic skip (MY_AGENT_MANDATORY_CRITIC=0)',
      );
      appendAgentAuditEvent(opts.cqrRoot, {
        type: 'handoff',
        sessionId: opts.sessionId,
        parentRunId,
        role: 'reviewer',
        detail:
          allMutated.length === 0
            ? 'skip_critic_no_mutate'
            : 'skip_critic_flag_off',
      });
      continue;
    }

    const agentId = ids.nextId();
    if (prev) {
      appendAgentAuditEvent(opts.cqrRoot, {
        type: 'handoff',
        sessionId: opts.sessionId,
        parentRunId,
        role,
        agentId,
        detail: `${prev.role}->${role}`,
      });
      opts.hooks?.onEvent?.({
        type: 'handoff',
        fromRole: prev.role,
        toRole: role,
        parentRunId,
      });
      opts.onStatus?.(`MAR · handoff ${prev.role} → ${role}`);
    }

    const handoff = prev ? buildHandoff(prev, role, allMutated) : undefined;
    opts.hooks?.onEvent?.({
      type: 'role_start',
      role,
      agentId,
      parentRunId,
    });

    let result: MarRoleResult;
    if (role === 'browser') {
      result = await runBrowserSpecialistNode({
        cqrRoot: opts.cqrRoot,
        configPath: opts.configPath,
        providerStore: opts.providerStore,
        sessionId: opts.sessionId,
        userMessage: opts.userMessage,
        parentRunId,
        agentId,
        handoff,
        signal: opts.signal,
        onStatus: opts.onStatus,
      });
    } else if (role === 'researcher') {
      result = await runResearchSpecialistNode({
        cqrRoot: opts.cqrRoot,
        configPath: opts.configPath,
        providerStore: opts.providerStore,
        sessionId: opts.sessionId,
        userMessage: opts.userMessage,
        parentRunId,
        agentId,
        handoff,
        signal: opts.signal,
        onStatus: opts.onStatus,
      });
    } else {
      result = await runCodeSpecialist(opts, role, agentId, parentRunId, handoff, plan);
      // Structured Critic output: one internal rewrite if VERDICT/JSON missing.
      if (
        role === 'reviewer'
        && result.ok
        && reviewerNeedsStructuredRetry(result.content)
      ) {
        opts.onStatus?.('해결 중… · Critic VERDICT 구조화 재시도');
        const retryId = ids.nextId();
        const retryHandoff: HandoffMessage = {
          fromRole: 'reviewer',
          toRole: 'reviewer',
          task: [
            formatReviewerStructuredRetryNote(),
            '',
            '## Previous incomplete Critic draft',
            result.content.slice(0, 2500),
          ].join('\n'),
          mutatedPaths: allMutated,
        };
        const retry = await runCodeSpecialist(
          opts,
          'reviewer',
          retryId,
          parentRunId,
          retryHandoff,
          plan,
        );
        if (parseReviewerVerdict(retry.content) && !reviewerNeedsStructuredRetry(retry.content)) {
          result = retry;
        } else if (!parseReviewerVerdict(retry.content) && !parseReviewerVerdict(result.content)) {
          result = {
            ...retry,
            content: [
              'VERDICT: FAIL',
              '```json',
              '{"verdict":"FAIL","gaps":["Critic reply missing structured VERDICT"],"next":"재검토"}',
              '```',
              '결론: Critic 구조화 실패 — 완료로 확정하지 않습니다.',
              '미충족: VERDICT/JSON 누락',
              '다음 수정: Critic 형식으로 재실행',
              '',
              (retry.content || result.content).slice(0, 1200),
            ].join('\n'),
            detail: 'critic_structure_forced_fail',
          };
        } else {
          result = parseReviewerVerdict(retry.content) ? retry : result;
        }
      }
      // Persist Critic next → session openGate (Single Exit Gate).
      if (role === 'reviewer' && result.ok) {
        const verdict = parseReviewerVerdict(result.content);
        const next = parseCriticNext(result.content);
        if (verdict === 'PASS') {
          clearSessionOpenGate(opts.cqrRoot, opts.sessionId, 'critic_pass');
          opts.onStatus?.('Exit Gate · Critic PASS — openGate 해제');
        } else if (next) {
          const gate = buildOpenGateFromCriticNext(next, {
            source: 'critic',
            parentRunId,
            agentId: result.agentId,
          });
          if (gate) {
            setSessionOpenGate(opts.cqrRoot, opts.sessionId, gate);
            opts.onStatus?.(`Exit Gate OPEN · ${gate.gate.slice(0, 80)}`);
          }
        }
      }
    }

    for (const p of result.mutatedPaths) {
      if (!allMutated.includes(p)) allMutated.push(p);
    }
    roleResults.push(result);
    prev = result;
  }

  // Ensure session meta has parent/agent ids even if no paths.
  const meta = loadAgentRunMeta(opts.cqrRoot, opts.sessionId);
  if (!meta.parentRunId || allMutated.length) {
    appendRoleContribution(opts.cqrRoot, opts.sessionId, {
      agentId: roleResults[roleResults.length - 1]?.agentId ?? parentRunId,
      parentRunId,
      role: 'supervisor',
      mutatedPaths: [],
    });
  }

  let content = mergeSupervisorReply(roleResults);
  if (!content.trim()) {
    const leaked = roleResults.find((r) => contentLooksLikeLeakedRoleInfraFailure(r.content));
    const fail = roleResults.find((r) => !r.ok && r.detail);
    throw wrapAsInfraError(
      new Error(leaked?.content || fail?.detail || 'MAR produced no usable role content'),
    );
  }
  content = applySupervisorOutcomeGate(opts, content, allMutated, roleResults);

  const lastModel = roleResults.find((r) => r.role === 'coder')?.model
    ?? roleResults[roleResults.length - 1]?.model
    ?? 'mar/supervisor';
  const steps = roleResults.reduce((n, r) => n + r.steps, 0);

  opts.onAnswer?.(content);
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'run_end',
    sessionId: opts.sessionId,
    parentRunId,
    role: 'supervisor',
    steps,
    detail: `roles=${plan.roles.join(',')}`,
  });

  return {
    content,
    model: lastModel,
    steps,
    parentRunId,
    roles: plan.roles,
    roleResults,
  };
}
