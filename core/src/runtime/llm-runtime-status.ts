import type { ProviderStore } from '../providers/provider-store.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import { resolveCodeAgentProvider } from '../chat/modes/workspace-agent.js';
import { prefersClientToolProtocol } from '../agent/code-agent.js';
import { resolveInstalledOllamaModel } from '../providers/ollama-models.js';

export interface OllamaRuntimeProbe {
  configured: boolean;
  base_url?: string;
  model_id?: string;
  reachable: boolean;
  model_installed: boolean;
  model_count: number;
  models_sample: string[];
  note: string;
}

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
  ollama: OllamaRuntimeProbe;
  openrouter: OpenRouterRuntimeProbe;
  /** @deprecated Compatibility alias for older diagnostics readers. */
  openwebui: OpenRouterRuntimeProbe;
  /** Code agent + configured LLM can run (Ollama model present or OpenRouter reachable when not local_only). */
  chat_ready: boolean;
  warnings: string[];
}

async function probeOllama(
  providerStore: ProviderStore,
): Promise<OllamaRuntimeProbe> {
  const none: OllamaRuntimeProbe = {
    configured: false,
    reachable: false,
    model_installed: false,
    model_count: 0,
    models_sample: [],
    note: 'not configured',
  };
  const resolved = providerStore.resolveProvider('ollama');
  if (!resolved) return none;

  const baseUrl = resolved.baseUrl.replace(/\/v1\/?$/, '');
  const modelId = resolved.modelId;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return {
        configured: true,
        base_url: resolved.baseUrl,
        model_id: modelId,
        reachable: false,
        model_installed: false,
        model_count: 0,
        models_sample: [],
        note: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => Boolean(n));
    const remapped = resolveInstalledOllamaModel(modelId, names);
    const installed = Boolean(remapped);
    return {
      configured: true,
      base_url: resolved.baseUrl,
      model_id: modelId,
      reachable: true,
      model_installed: installed,
      model_count: names.length,
      models_sample: names.slice(0, 8),
      note: remapped && remapped !== modelId
        ? `OK · '${modelId}' → '${remapped}'`
        : installed
          ? `OK · ${names.length} models`
          : `reachable but model '${modelId}' not found (${names.length} installed)`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      configured: true,
      base_url: resolved.baseUrl,
      model_id: modelId,
      reachable: false,
      model_installed: false,
      model_count: 0,
      models_sample: [],
      note: msg.slice(0, 240),
    };
  }
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

/** OpenRouter/Ollama 경로·코드 에이전트 LLM 상태 (health / Manager). */
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

  const ollama = await probeOllama(providerStore);
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

  if (localOnly) {
    if (!ollama.configured) warnings.push('local_only인데 Ollama가 설정되지 않았습니다.');
    else if (!ollama.reachable) warnings.push(`Ollama 서버 연결 실패: ${ollama.note}`);
    else if (!ollama.model_installed) {
      warnings.push(`Ollama 모델 '${ollama.model_id}' 없음 — ollama pull 또는 Manager에서 모델 변경`);
    }
  } else if (codeAgent?.provider_id === 'custom' && !openrouter.reachable) {
    warnings.push(
      `MY OpenRouter 불안정: ${openrouter.note} (코드 에이전트는 Ollama로 자동 재시도하지 않음 — MY_AGENT_OLLAMA_FALLBACK=1로만 허용)`,
    );
  }

  let chatReady = false;
  if (localOnly) {
    chatReady = ollama.configured && ollama.reachable && ollama.model_installed;
  } else if (codeAgent?.provider_id === 'ollama') {
    chatReady = ollama.configured && ollama.reachable && ollama.model_installed;
  } else if (codeAgent?.provider_id === 'custom') {
    chatReady = openrouter.reachable;
  } else if (codeAgent?.provider_id) {
    // Personal / catalog OpenAI-compatible endpoints: key is enough for readiness.
    chatReady = providerStore.getConfiguredIds().includes(codeAgent.provider_id);
  }

  return finishLlmRuntimeStatus({
    local_only: localOnly,
    default_provider_id: providerStore.getDefaultId(),
    code_agent: codeAgent,
    ollama,
    openrouter,
    openwebui: openrouter,
    chat_ready: chatReady,
    warnings,
  });
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
    ollama_ok: full.ollama.reachable && full.ollama.model_installed,
    openrouter_ok: full.openrouter.skipped ? null : full.openrouter.reachable,
    openwebui_ok: full.openrouter.skipped ? null : full.openrouter.reachable,
    warnings: full.warnings,
  };
}
