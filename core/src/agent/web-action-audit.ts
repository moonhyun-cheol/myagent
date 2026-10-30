/**
 * Web-action audit (security plan step 5).
 *
 * Every browser / web-download / user-MCP tool call appends one `web_action` event to the
 * local agent ledger (`data/audit/agent-ledger.jsonl`) so "what did the agent do in my
 * browser?" can be answered afterwards.
 *
 * Privacy contract: only the surface (visible/isolated/download/mcp), the action, the
 * host (no path / query — queries are an exfiltration channel) and the outcome are kept.
 * Fill values, JS expressions, selectors, MCP arguments and page content are never logged.
 */
import { appendAgentAuditEvent, type AgentWebAuditFields } from './agent-audit-ledger.js';
import { summarizeAgentToolResult } from './agent-tool-result.js';

export type WebAuditTarget = AgentWebAuditFields['target'];
export type WebAuditOutcome = AgentWebAuditFields['outcome'];

export function isAuditedWebTool(name: string): boolean {
  return name.startsWith('browser_') || name === 'save_web_asset' || name.startsWith('mcp_');
}

/** Host[:port] only. Returns undefined for non-http(s) or unparsable input. */
export function webAuditHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) return undefined;
  try {
    return new URL(raw.trim()).host.toLowerCase().slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

const RESULT_URL_RE = /"(?:url|page_url|final_url|current_url)"\s*:\s*"(https?:\/\/[^"\s]+)"/i;
const ANY_URL_RE = /https?:\/\/[^\s"'<>)]+/i;

/** Host the action ended on: explicit url arg first, then the result's page url. */
export function webAuditHostFrom(args: Record<string, unknown>, output?: string): string | undefined {
  const fromArgs = webAuditHost(args.url);
  if (fromArgs) return fromArgs;
  if (!output) return undefined;
  const m = RESULT_URL_RE.exec(output) ?? (output.startsWith('ERROR:') ? ANY_URL_RE.exec(output) : null);
  return m ? webAuditHost(m[1] ?? m[0]) : undefined;
}

export function webAuditTarget(
  name: string,
  args: Record<string, unknown>,
  resolvedBrowserTarget?: 'visible' | 'isolated',
): WebAuditTarget {
  if (name === 'save_web_asset') return 'download';
  if (name.startsWith('mcp_')) return 'mcp';
  if (name === 'browser_targets') return 'none';
  if (name === 'browser_lock' || name === 'browser_unlock') return 'visible';
  if (name === 'browser_evaluate') return 'isolated';
  if (args.target === 'visible' || args.target === 'isolated') return args.target;
  // Not executed (e.g. approval denied before routing) → no surface was touched.
  return resolvedBrowserTarget ?? 'none';
}

export function webAuditOutcome(output: string): WebAuditOutcome {
  const head = output.slice(0, 600);
  if (/VISIBLE_BROWSER_CONTROL_TAKEN_OVER/.test(head)) return 'taken_over';
  if (/\bBLOCKED_[A-Z_]+|Placeholder URL blocked/.test(head)) return 'blocked';
  if (/^ERROR:/.test(output)) return 'error';
  return summarizeAgentToolResult(output).ok === false ? 'error' : 'ok';
}

export function webAuditAction(name: string): string {
  if (name.startsWith('browser_')) return name.slice('browser_'.length);
  if (name === 'save_web_asset') return 'download';
  return 'call';
}

export interface WebActionAuditInput {
  cqrRoot: string;
  sessionId?: string;
  tool: string;
  args: Record<string, unknown>;
  output?: string;
  outcome?: WebAuditOutcome;
  durationMs?: number;
  resolvedBrowserTarget?: 'visible' | 'isolated';
}

export function buildWebAuditFields(
  input: Pick<WebActionAuditInput, 'tool' | 'args' | 'output' | 'outcome' | 'resolvedBrowserTarget'>,
): AgentWebAuditFields {
  const output = input.output ?? '';
  return {
    target: webAuditTarget(input.tool, input.args, input.resolvedBrowserTarget),
    action: webAuditAction(input.tool),
    host: webAuditHostFrom(input.args, output),
    outcome: input.outcome ?? webAuditOutcome(output),
  };
}

/** Never throws: audit failures must not break the tool call. `MY_AGENT_WEB_AUDIT=0` disables. */
export function recordWebActionAudit(input: WebActionAuditInput): void {
  if (process.env.MY_AGENT_WEB_AUDIT === '0') return;
  try {
    const web = buildWebAuditFields(input);
    appendAgentAuditEvent(input.cqrRoot, {
      type: 'web_action',
      sessionId: input.sessionId,
      tool: input.tool,
      ok: web.outcome === 'ok',
      durationMs: input.durationMs,
      web,
    });
  } catch {
    /* audit is best-effort */
  }
}
