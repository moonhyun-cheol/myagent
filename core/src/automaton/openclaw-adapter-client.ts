import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AutomatonDispatchOptions, AutomatonDispatchResult } from './adapter.js';
import { AutomatonDispatchError } from './errors.js';
import { formatAutomatonEnvelope } from './format-result.js';
import {
  buildGateCommandContextPayload,
  signGateCommandContext,
} from './openclaw-gate-context.js';
import { attachLocalNopsUserId } from './local-nops-user-id.js';
import { readOpenClawAdapterVault } from './openclaw-adapter-vault.js';
import { resolveOpenClawWorkflow } from './openclaw-workflow-map.js';
import { resolveAutomatonToolTimeoutMs } from './timeouts.js';

export interface OpenClawAdapterConfig {
  baseUrl: string;
  token: string;
  /** Optional legacy client-side signing — prefer empty + /cqr/adapter/request. */
  signingPrivateKeyHex?: string;
  actorId?: string;
  guildId?: string;
  channelId?: string;
  /** Prefer server-signed /cqr/adapter/request (default true). */
  useCqrEntry?: boolean;
  enabled?: boolean;
}

export function resolveOpenClawAdapterConfig(input: {
  baseUrl?: string;
  token?: string;
  signingPrivateKeyHex?: string;
  actorId?: string;
  guildId?: string;
  channelId?: string;
  useCqrEntry?: boolean;
  cqrRoot?: string;
  vaultDir?: string;
}): OpenClawAdapterConfig | null {
  const vaultDir = input.vaultDir
    ?? (input.cqrRoot ? path.join(input.cqrRoot, 'data', 'vault') : undefined);
  const vault = vaultDir ? readOpenClawAdapterVault(vaultDir) : null;
  const baseUrl = (
    process.env.OPENCLAW_ADAPTER_BASE_URL?.trim()
    || vault?.base_url?.trim()
    || input.baseUrl?.trim()
    || ''
  ).replace(/\/+$/, '');
  const token = (
    process.env.OPENCLAW_ADAPTER_TOKEN?.trim()
    || process.env.MAIN_API_TOKEN?.trim()
    || process.env.MANAGER_API_TOKEN?.trim()
    || vault?.token?.trim()
    || input.token?.trim()
    || ''
  );
  const signingPrivateKeyHex = (
    process.env.GATE_CONTEXT_SIGNING_PRIVATE_KEY?.trim()
    || input.signingPrivateKeyHex?.trim()
    || vault?.signing_private_key_hex?.trim()
    || ''
  );
  if (!baseUrl || !token) return null;
  return {
    baseUrl,
    token,
    signingPrivateKeyHex: signingPrivateKeyHex || undefined,
    actorId: process.env.MY_AGENT_OPENCLAW_ACTOR_ID?.trim() || input.actorId || 'cqr-pa',
    guildId: process.env.MY_AGENT_OPENCLAW_GUILD_ID?.trim() || input.guildId || 'cqr-pa',
    channelId: process.env.MY_AGENT_OPENCLAW_CHANNEL_ID?.trim() || input.channelId || 'cqr-pa-chat',
    useCqrEntry: input.useCqrEntry !== false,
    enabled: true,
  };
}

export async function probeOpenClawAdapterHealth(baseUrl: string): Promise<{
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}> {
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 2_000) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface OpenClawRawRequestBuildOptions {
  cqrRoot?: string;
  /** Test injection. Production omits this and reads the local NOPSPro login. */
  nopsUserId?: string;
}

export function buildOpenClawRawRequest(
  toolId: string,
  message: string,
  cfg: OpenClawAdapterConfig,
  options?: OpenClawRawRequestBuildOptions,
): {
  rawRequest: Record<string, unknown>;
  requestId: string;
  transactionId: string;
  workflowToolId: string;
  taskProfileId: string;
} {
  const cqrRoot = options?.cqrRoot?.trim() || process.env.MY_AGENT_ROOT?.trim() || '';
  const workflow = resolveOpenClawWorkflow(toolId, cqrRoot);
  if (!workflow) {
    throw new AutomatonDispatchError(
      'MCP_SPAWN_FAILED',
      `OpenClaw remote map 없음: ${toolId}`,
    );
  }

  const requestId = `cqr-${randomUUID()}`;
  const transactionId = `txn-${randomUUID()}`;
  const requestedText = message.trim();
  const args = {
    ...workflow.args,
    requested_text: requestedText,
    manager_request_text: requestedText,
  };

  const rawRequest: Record<string, unknown> = {
    transaction_id: transactionId,
    request_id: requestId,
    actor_id: cfg.actorId ?? 'cqr-pa',
    platform: 'cqr_pa',
    guild_id: cfg.guildId ?? 'cqr-pa',
    channel_id: cfg.channelId ?? 'cqr-pa-chat',
    actor_tier: 'operator',
    task_profile_id: workflow.task_profile_id,
    tool_id: workflow.tool_id,
    approval_token: '',
    approval_token_ref: '',
    incident_reference: '',
    args,
    requested_text: requestedText,
    token_scope: {},
    requested_scope: {},
    dispatch: {
      execution_plan_id: `plan-${randomUUID()}`,
      operation_fingerprint: 'cqr-pa-automaton',
      approval_token_ref: 'n/a',
    },
    response: {
      response_receipt_id: randomUUID(),
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      binding_hash: 'cqr-pa',
    },
    desired_transition: 'complete',
    reconciliation_verdict: 'pass',
  };
  attachLocalNopsUserId(rawRequest, args, options?.nopsUserId);

  return {
    requestId,
    transactionId,
    workflowToolId: workflow.tool_id,
    taskProfileId: workflow.task_profile_id,
    rawRequest,
  };
}

function formatOpenClawResult(
  toolId: string,
  adapterBody: Record<string, unknown>,
): AutomatonDispatchResult {
  const status = String(adapterBody.status ?? 'unknown');
  const result = (adapterBody.result ?? {}) as Record<string, unknown>;
  const nested = (result.result ?? result) as Record<string, unknown>;

  const envelope: Record<string, unknown> = {
    status: status === 'completed' ? 'ok' : status,
    tool: toolId,
    route: 'openclaw_adapter',
    reason_code: adapterBody.reason_code,
    user_message: adapterBody.user_message,
    result: nested,
    adapter: adapterBody,
  };

  if (status === 'denied' || status === 'failed' || status === 'error') {
    const detail = String(
      adapterBody.user_message
      || adapterBody.detail
      || adapterBody.reason_code
      || status,
    );
    const reason = adapterBody.reason_code != null && String(adapterBody.reason_code).trim()
      ? String(adapterBody.reason_code).trim()
      : '';
    const lines = [
      '**OpenClaw Adapter 실행 실패**',
      '',
      `- tool: \`${toolId}\``,
      `- status: **${status}**`,
      ...(reason ? [`- reason: \`${reason}\``] : []),
      `- detail: ${detail}`,
    ];
    if (reason === 'INGRESS_LANE_NOT_ALLOWED') {
      lines.push(
        '',
        '힌트: OpenClaw Main API가 이 입구(lane)를 막았습니다. token/health는 통과해도',
        '`platform=my_agent` + 해당 task_profile 허용이 어댑터 설정에 없으면 denied 됩니다.',
        'Adapter ingress allowlist 설정을 확인하세요.',
      );
    }
    return {
      tool: toolId,
      envelope,
      content: lines.join('\n'),
    };
  }

  // Prefer adapter "completed" + business payload fields over nested bare "success".
  const content = formatAutomatonEnvelope(toolId, {
    ...envelope,
    status:
      status === 'completed' || status === 'ok' || status === 'success'
        ? (String(
          (asNestedBusinessStatus(nested) || nested.status || status),
        ) || status)
        : (nested.status ?? envelope.status),
    excel_file: nested.excel_file,
    json_output_path:
      nested.json_output_path
      ?? nested.output_path
      ?? (Array.isArray(nested.artifacts)
        ? (nested.artifacts as { path?: string }[]).find((a) => a?.path)?.path
        : undefined),
    // Keep full tree under result so pickAutomatonUserFacingText sees output.summary.
    result: nested,
  });

  return {
    tool: toolId,
    envelope,
    content: content.replace(
      '**my_live_automaton 실행 완료**',
      '**OpenClaw Adapter 실행 완료**',
    ),
  };
}

function asNestedBusinessStatus(result: Record<string, unknown>): string {
  const output = result.output && typeof result.output === 'object'
    ? (result.output as Record<string, unknown>)
    : null;
  const deep = output?.result && typeof output.result === 'object'
    ? (output.result as Record<string, unknown>)
    : null;
  const s = deep?.status ?? output?.status;
  return s != null ? String(s).trim() : '';
}

export async function dispatchAutomatonToolRemote(
  message: string,
  matchedTool: string,
  cfg: OpenClawAdapterConfig,
  options?: AutomatonDispatchOptions,
): Promise<AutomatonDispatchResult> {
  const built = buildOpenClawRawRequest(matchedTool, message, cfg, {
    cqrRoot: options?.cqrRoot,
  });
  const useCqrEntry = cfg.useCqrEntry !== false;
  const timeoutMs = resolveAutomatonToolTimeoutMs(matchedTool);

  let url: string;
  let body: Record<string, unknown>;

  if (useCqrEntry || !cfg.signingPrivateKeyHex) {
    url = `${cfg.baseUrl}/cqr/adapter/request`;
    body = {
      raw_request: built.rawRequest,
      callback_url: '',
      token_refs: [],
    };
    options?.onStatus?.('OpenClaw CQR Adapter (:8790) 요청 중…');
  } else {
    const gatePayload = buildGateCommandContextPayload({
      requestId: built.requestId,
      transactionId: built.transactionId,
      actorId: cfg.actorId ?? 'cqr-pa',
      guildId: cfg.guildId,
      channelId: cfg.channelId,
      taskProfileId: built.taskProfileId,
      toolId: built.workflowToolId,
      ttlSeconds: 3_600,
      platform: 'cqr_pa',
    });
    url = `${cfg.baseUrl}/adapter/request`;
    body = {
      raw_request: built.rawRequest,
      callback_url: '',
      token_refs: [],
      gate_command_context: signGateCommandContext(gatePayload, cfg.signingPrivateKeyHex),
    };
    options?.onStatus?.('OpenClaw Adapter (:8790) 요청 중…');
  }

  options?.onThought?.(`request_id=${built.requestId} tool=${matchedTool} url=${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AutomatonDispatchError(
      'MCP_SPAWN_FAILED',
      `OpenClaw Adapter 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { status: 'error', detail: text.slice(0, 2_000) };
  }

  if (res.status === 401) {
    throw new AutomatonDispatchError('MCP_SPAWN_FAILED', 'OpenClaw Adapter unauthorized (token)');
  }
  if (res.status === 404 && useCqrEntry) {
    throw new AutomatonDispatchError(
      'MCP_SPAWN_FAILED',
      'OpenClaw /cqr/adapter/request 없음 — Adapter API를 최신으로 재기동하세요',
    );
  }
  if (res.status === 403) {
    return formatOpenClawResult(matchedTool, {
      status: 'denied',
      reason_code: parsed.reason_code ?? 'GATE_CONTEXT_DENIED',
      user_message: parsed.user_message ?? text.slice(0, 500),
      ...parsed,
    });
  }
  if (!res.ok && !parsed.status) {
    throw new AutomatonDispatchError(
      'MCP_SPAWN_FAILED',
      `OpenClaw Adapter HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  options?.onStatus?.(`OpenClaw Adapter 응답: ${String(parsed.status ?? res.status)}`);
  return formatOpenClawResult(matchedTool, parsed);
}
