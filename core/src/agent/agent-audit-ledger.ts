/**
 * Append-only local agent audit ledger + optional enterprise shipper.
 * Policy: see ADR-002. Shipping is opt-in via deploy/user overrides.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { summarizeAgentToolResult } from './agent-tool-result.js';

export type AgentAuditEventType =
  | 'run_start'
  | 'run_end'
  | 'tool_start'
  | 'tool_end'
  | 'hook_stop'
  | 'checkpoint'
  | 'rollback'
  | 'verify_fail'
  | 'verify_pass'
  | 'verify_weak'
  | 'guard_block'
  | 'work_mode'
  | 'clarify'
  | 'handoff'
  | 'role_start'
  | 'role_end'
  | 'turn_decision'
  | 'approval_review';

export interface AgentAuditEvent {
  id: string;
  at: string;
  type: AgentAuditEventType;
  sessionId?: string;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  failureType?: string;
  exitCode?: number;
  /** Path hashes only — never raw file contents. */
  pathHashes?: string[];
  detail?: string;
  steps?: number;
  /** MAR specialist id (ADR-005). */
  agentId?: string;
  /** MAR supervisor parent run id. */
  parentRunId?: string;
  /** MAR role name. */
  role?: string;
}

export interface AuditShipPolicy {
  enabled: boolean;
  endpoint?: string;
  /** Bearer or opaque token; never logged. */
  authToken?: string;
  batchSize?: number;
}

function ledgerDir(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'audit');
}

function ledgerPath(cqrRoot: string): string {
  return path.join(ledgerDir(cqrRoot), 'agent-ledger.jsonl');
}

function queuePath(cqrRoot: string): string {
  return path.join(ledgerDir(cqrRoot), 'agent-ship-queue.jsonl');
}

export function hashPath(relPath: string): string {
  return createHash('sha256').update(relPath.replace(/\\/g, '/')).digest('hex').slice(0, 16);
}

export function appendAgentAuditEvent(cqrRoot: string, partial: Omit<AgentAuditEvent, 'id' | 'at'> & { id?: string; at?: string }): AgentAuditEvent {
  const event: AgentAuditEvent = {
    id: partial.id ?? randomUUID(),
    at: partial.at ?? new Date().toISOString(),
    type: partial.type,
    sessionId: partial.sessionId,
    tool: partial.tool,
    ok: partial.ok,
    durationMs: partial.durationMs,
    failureType: partial.failureType,
    exitCode: partial.exitCode,
    pathHashes: partial.pathHashes,
    detail: partial.detail?.slice(0, 500),
    steps: partial.steps,
    agentId: partial.agentId,
    parentRunId: partial.parentRunId,
    role: partial.role,
  };
  const dir = ledgerDir(cqrRoot);
  mkdirSync(dir, { recursive: true });
  appendFileSync(ledgerPath(cqrRoot), `${JSON.stringify(event)}\n`, 'utf8');
  appendFileSync(queuePath(cqrRoot), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export function createAuditLedgerHooks(
  cqrRoot: string,
  sessionId?: string,
): {
  beforeRun: () => void;
  afterRun: (result: { content: string; steps: number }) => void;
  beforeTool: (ctx: { tool: string; args: Record<string, unknown>; step: number }) => void;
  afterTool: (ctx: {
    tool: string;
    args: Record<string, unknown>;
    step: number;
    output: string;
    durationMs: number;
  }) => void;
} {
  return {
    beforeRun: () => {
      appendAgentAuditEvent(cqrRoot, { type: 'run_start', sessionId });
    },
    afterRun: (result) => {
      appendAgentAuditEvent(cqrRoot, {
        type: 'run_end',
        sessionId,
        steps: result.steps,
        detail: `content_chars=${result.content.length}`,
      });
    },
    beforeTool: (ctx) => {
      const pathHashes: string[] = [];
      for (const key of ['path', 'new_path', 'from', 'to']) {
        const v = ctx.args[key];
        if (typeof v === 'string' && v.trim()) pathHashes.push(hashPath(v));
      }
      appendAgentAuditEvent(cqrRoot, {
        type: 'tool_start',
        sessionId,
        tool: ctx.tool,
        pathHashes: pathHashes.length ? pathHashes : undefined,
      });
    },
    afterTool: (ctx) => {
      const result = summarizeAgentToolResult(ctx.output);
      appendAgentAuditEvent(cqrRoot, {
        type: 'tool_end',
        sessionId,
        tool: ctx.tool,
        ok: result.ok,
        durationMs: ctx.durationMs,
        failureType: result.failure_type,
        exitCode: result.exit_code,
      });
    },
  };
}

/** Read ship policy from deploy-defaults + optional user override fields. */
export function loadAuditShipPolicy(
  cqrRoot: string,
  overrides?: Record<string, unknown>,
): AuditShipPolicy {
  let enabled = false;
  let endpoint: string | undefined;
  let authToken: string | undefined;
  let batchSize = 50;

  try {
    const p = path.join(cqrRoot, 'core', 'config', 'defaults', 'deploy-defaults.json');
    if (existsSync(p)) {
      const doc = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      const audit = (doc.audit_ship ?? doc.agent_audit) as Record<string, unknown> | undefined;
      if (audit && typeof audit === 'object') {
        enabled = audit.enabled === true;
        if (typeof audit.endpoint === 'string') endpoint = audit.endpoint;
        if (typeof audit.batch_size === 'number') batchSize = audit.batch_size;
      }
    }
  } catch {
    /* ignore */
  }

  if (overrides) {
    if (overrides.audit_ship_enabled === true) enabled = true;
    if (typeof overrides.audit_ship_endpoint === 'string') endpoint = overrides.audit_ship_endpoint;
    if (typeof overrides.audit_ship_token === 'string') authToken = overrides.audit_ship_token;
  }

  return { enabled, endpoint, authToken, batchSize };
}

/**
 * Background-friendly ship: POST queued events when policy enabled.
 * Never includes file contents — ledger events only.
 */
export type AgentAuditSummary = {
  total: number;
  by_type: Record<string, number>;
  tool_end_ok: number;
  tool_end_fail: number;
  verify_fail: number;
  verify_pass: number;
  verify_weak: number;
  guard_blocks: number;
  work_mode_events: number;
  top_tools: { tool: string; count: number; fail: number }[];
  failure_types: Record<string, number>;
  recent_blocks: { at: string; type: string; detail?: string; tool?: string }[];
  ledger_path: string;
};

/** Observability (G): aggregate local ledger without shipping contents. */
export function summarizeAgentAuditLedger(
  cqrRoot: string,
  opts?: { maxLines?: number; recentBlocks?: number },
): AgentAuditSummary {
  const maxLines = opts?.maxLines ?? 4000;
  const recentBlocksN = opts?.recentBlocks ?? 12;
  const lp = ledgerPath(cqrRoot);
  const empty: AgentAuditSummary = {
    total: 0,
    by_type: {},
    tool_end_ok: 0,
    tool_end_fail: 0,
    verify_fail: 0,
    verify_pass: 0,
    verify_weak: 0,
    guard_blocks: 0,
    work_mode_events: 0,
    top_tools: [],
    failure_types: {},
    recent_blocks: [],
    ledger_path: lp,
  };
  if (!existsSync(lp)) return empty;

  const raw = readFileSync(lp, 'utf8').trim();
  if (!raw) return empty;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const byType: Record<string, number> = {};
  const toolCounts = new Map<string, { count: number; fail: number }>();
  const blocks: AgentAuditSummary['recent_blocks'] = [];
  let toolEndOk = 0;
  let toolEndFail = 0;
  let verifyFail = 0;
  let verifyPass = 0;
  let verifyWeak = 0;
  let guardBlocks = 0;
  let workMode = 0;
  const failureTypes: Record<string, number> = {};

  for (const line of slice) {
    let ev: AgentAuditEvent;
    try {
      ev = JSON.parse(line) as AgentAuditEvent;
    } catch {
      continue;
    }
    byType[ev.type] = (byType[ev.type] ?? 0) + 1;
    if (ev.type === 'tool_end') {
      if (ev.ok === false) toolEndFail += 1;
      else toolEndOk += 1;
      if (ev.tool) {
        const cur = toolCounts.get(ev.tool) ?? { count: 0, fail: 0 };
        cur.count += 1;
        if (ev.ok === false) cur.fail += 1;
        toolCounts.set(ev.tool, cur);
      }
      if (ev.failureType) {
        failureTypes[ev.failureType] = (failureTypes[ev.failureType] ?? 0) + 1;
      }
    }
    if (ev.type === 'verify_fail') verifyFail += 1;
    if (ev.type === 'verify_pass') verifyPass += 1;
    if (ev.type === 'verify_weak') verifyWeak += 1;
    if (ev.type === 'guard_block' || ev.type === 'hook_stop') {
      guardBlocks += 1;
      blocks.push({ at: ev.at, type: ev.type, detail: ev.detail, tool: ev.tool });
    }
    if (ev.type === 'work_mode') workMode += 1;
  }

  const top_tools = [...toolCounts.entries()]
    .map(([tool, v]) => ({ tool, count: v.count, fail: v.fail }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    total: slice.length,
    by_type: byType,
    tool_end_ok: toolEndOk,
    tool_end_fail: toolEndFail,
    verify_fail: verifyFail,
    verify_pass: verifyPass,
    verify_weak: verifyWeak,
    guard_blocks: guardBlocks,
    work_mode_events: workMode,
    top_tools,
    failure_types: failureTypes,
    recent_blocks: blocks.slice(-recentBlocksN).reverse(),
    ledger_path: lp,
  };
}

export function formatAuditSummaryBrief(summary: AgentAuditSummary): string {
  if (!summary.total) return 'agent_audit: empty';
  const failRate =
    summary.tool_end_ok + summary.tool_end_fail > 0
      ? summary.tool_end_fail / (summary.tool_end_ok + summary.tool_end_fail)
      : 0;
  return [
    `agent_audit events=${summary.total}`,
    `tools_ok=${summary.tool_end_ok} tools_fail=${summary.tool_end_fail} fail_rate=${failRate.toFixed(2)}`,
    `verify_pass=${summary.verify_pass} verify_weak=${summary.verify_weak} verify_fail=${summary.verify_fail} guards=${summary.guard_blocks}`,
    summary.top_tools.length
      ? `top_tools: ${summary.top_tools
          .slice(0, 5)
          .map((t) => `${t.tool}(${t.count}${t.fail ? `/${t.fail}f` : ''})`)
          .join(', ')}`
      : '',
    Object.keys(summary.failure_types).length
      ? `failures: ${Object.entries(summary.failure_types).map(([k, v]) => `${k}=${v}`).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

export async function shipAgentAuditQueue(
  cqrRoot: string,
  policy: AuditShipPolicy,
): Promise<{ shipped: number; skipped: boolean; error?: string }> {
  if (!policy.enabled || !policy.endpoint) {
    return { shipped: 0, skipped: true };
  }

  const q = queuePath(cqrRoot);
  if (!existsSync(q)) return { shipped: 0, skipped: false };

  const raw = readFileSync(q, 'utf8').trim();
  if (!raw) return { shipped: 0, skipped: false };

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const batchSize = policy.batchSize ?? 50;
  const batch = lines.slice(0, batchSize);
  const events = batch.map((l) => JSON.parse(l) as AgentAuditEvent);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'MY Agent-audit-shipper/1.0',
    };
    if (policy.authToken) headers.authorization = `Bearer ${policy.authToken}`;

    const res = await fetch(policy.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events, source: 'my_agent_agent_ledger' }),
    });
    if (!res.ok) {
      return { shipped: 0, skipped: false, error: `HTTP ${res.status}` };
    }

    const rest = lines.slice(batch.length);
    const tmp = `${q}.tmp`;
    writeFileSync(tmp, rest.length ? `${rest.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, q);
    return { shipped: events.length, skipped: false };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { shipped: 0, skipped: false, error: msg };
  }
}
