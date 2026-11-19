import type { ProviderStore } from '../providers/provider-store.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import { resolveCodeAgentProvider } from '../chat/modes/workspace-agent.js';
import { prefersClientToolProtocol } from '../agent/code-agent.js';

export interface OpenRouterRuntimeProbe {
  configured: boolean;
  base_url?: string;
  model_id?: string;
  reachable: boolean;
  skipped: boolean;
  note: string;
}

export interface CodeAgentRuntimeInfo {
  provider_id: string;
  model_id: string;
  display: string;
  tool_protocol: 'tool_call_text' | 'api_tool_calls';
}

export interface LlmRuntimeStatus {
  local_only: boolean;
  default_provider_id: string | null;
  code_agent: CodeAgentRuntimeInfo | null;
  openrouter: OpenRouterRuntimeProbe;
  /** @deprecated Compatibility alias for older diagnostics readers. */
  openwebui: OpenRouterRuntimeProbe;
  /** Code agent + configured LLM can run (OpenRouter reachable, or a configured personal provider). */
  chat_ready: boolean;
  warnings: string[];
}

async function probeOpenRouter(providerStore: ProviderStore): Promise<OpenRouterRuntimeProbe> {
  const none: OpenRouterRuntimeProbe = {
    configured: false,
    reachable: false,
    skipped: false,
    note: 'not configured',
  };
  const resolved = providerStore.resolveProvider('custom');
  if (!resolved) return none;

  const url = `${resolved.baseUrl.replace(/\/$/, '')}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${resolved.secret.api_key}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) {
      const gateway = res.status === 502 || res.status === 504 || res.status === 503;
      return {
        configured: true,
        base_url: resolved.baseUrl,
        model_id: resolved.modelId,
        reachable: false,
        skipped: false,
        note: gateway ? `gateway HTTP ${res.status}` : `HTTP ${res.status}: ${text.slice(0, 80)}`,
      };
    }
    if (text.trimStart().toLowerCase().startsWith('<!doctype') || text.trimStart().toLowerCase().startsWith('<html')) {
      return {
        configured: true,
        base_url: resolved.baseUrl,
        model_id: resolved.modelId,
        reachable: false,
        skipped: false,
        note: 'gateway HTML error (502/504)',
      };
    }
    return {
      configured: true,
      base_url: resolved.baseUrl,
      model_id: resolved.modelId,
      reachable: true,
      skipped: false,
      note: 'OK',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      configured: true,
      base_url: resolved.baseUrl,
      model_id: resolved.modelId,
      reachable: false,
      skipped: false,
      note: msg.slice(0, 240),
    };
  }
}

/** OpenRouter 경로·코드 에이전트 LLM 상태 (health / Manager). */
const LLM_STATUS_CACHE_MS = 15_000;
let llmStatusCache: { at: number; data: LlmRuntimeStatus } | null = null;

export async function collectLlmRuntimeStatus(
  providerStore: ProviderStore,
  configPath: string,
  opts?: { fresh?: boolean },
): Promise<LlmRuntimeStatus> {
  if (!opts?.fresh && llmStatusCache && Date.now() - llmStatusCache.at < LLM_STATUS_CACHE_MS) {
    return llmStatusCache.data;
  }
  const overrides = loadUserOverrides(configPath);
  const localOnly = overrides.local_only === true;
  const warnings: string[] = [];

  let openrouter: OpenRouterRuntimeProbe;
  if (localOnly) {
    openrouter = {
      configured: providerStore.getConfiguredIds().includes('custom'),
      reachable: false,
      skipped: true,
      note: 'skipped (local_only)',
    };
  } else {
    openrouter = await probeOpenRouter(providerStore);
  }

  let codeAgent: CodeAgentRuntimeInfo | null = null;
  try {
    const pick = resolveCodeAgentProvider(configPath, providerStore, {
      display: 'auto',
      route: { type: 'stub', reason: 'runtime-status' },
    });
    const def = providerStore.getDefinition(pick.providerId);
    if (def) {
      codeAgent = {
        provider_id: pick.providerId,
        model_id: pick.modelId ?? '',
        display: pick.display,
        tool_protocol: prefersClientToolProtocol(pick.providerId, def)
          ? 'tool_call_text'
          : 'api_tool_calls',
      };
    }
  } catch {
    warnings.push('코드 에이전트 LLM 프로바이더를 resolve하지 못했습니다.');
  }

  if (!localOnly && codeAgent?.provider_id === 'custom' && !openrouter.reachable) {
    warnings.push(`MY OpenRouter 불안정: ${openrouter.note}`);
  }

  let chatReady = false;
  if (codeAgent?.provider_id === 'custom' && !localOnly) {
    chatReady = openrouter.reachable;
  } else if (codeAgent?.provider_id) {
    // Personal / catalog OpenAI-compatible endpoints: key is enough for readiness.
    chatReady = providerStore.getConfiguredIds().includes(codeAgent.provider_id);
  }

  return finishLlmRuntimeStatus({
    local_only: localOnly,
    default_provider_id: providerStore.getDefaultId(),
    code_agent: codeAgent,
    openrouter,
    openwebui: openrouter,
    chat_ready: chatReady,
    warnings,
  });
}

/** Last computed status without any network probe (null before the first probe). */
export function peekLlmRuntimeStatus(): LlmRuntimeStatus | null {
  return llmStatusCache?.data ?? null;
}

let llmStatusRefresh: Promise<unknown> | null = null;

/**
 * Refresh the cached status in the background when it is missing/stale (single-flight).
 * `/health` uses this so the shell's 2s health probe never waits on OpenRouter.
 */
export function refreshLlmRuntimeStatusInBackground(providerStore: ProviderStore, configPath: string): void {
  if (llmStatusRefresh) return;
  if (llmStatusCache && Date.now() - llmStatusCache.at < LLM_STATUS_CACHE_MS) return;
  llmStatusRefresh = collectLlmRuntimeStatus(providerStore, configPath)
    .catch(() => undefined)
    .finally(() => { llmStatusRefresh = null; });
}

function finishLlmRuntimeStatus(data: LlmRuntimeStatus): LlmRuntimeStatus {
  llmStatusCache = { at: Date.now(), data };
  return data;
}

export function compactLlmRuntimeStatus(full: LlmRuntimeStatus): Record<string, unknown> {
  return {
    local_only: full.local_only,
    chat_ready: full.chat_ready,
    code_agent_provider: full.code_agent?.provider_id ?? null,
    code_agent_model: full.code_agent?.model_id ?? null,
    openrouter_ok: full.openrouter.skipped ? null : full.openrouter.reachable,
    openwebui_ok: full.openrouter.skipped ? null : full.openrouter.reachable,
    warnings: full.warnings,
  };
}
