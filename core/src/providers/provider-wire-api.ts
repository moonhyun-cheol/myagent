import type { ProviderDefinition, ProviderWireApi } from './types.js';

const GPT_MODEL = /^(?:openai[\/.:-])?(?:gpt|o[1-9])(?:[-_.:]|$)/i;
const CLAUDE_MODEL = /^(?:anthropic[\/.:-])?claude(?:[-_.:]|$)/i;

/**
 * Non-negotiable transport for providers/models with a known native contract.
 * User input must never override this mapping.
 */
export function enforcedProviderWireApi(
  def: ProviderDefinition,
  modelId: string,
): ProviderWireApi | null {
  // Endpoint ownership wins over a routed model name. The fixed company
  // OpenRouter connection uses its native Responses endpoint.
  if (def.id === 'openai') return 'responses';
  if (def.id === 'anthropic') return 'messages';
  if (def.id === 'custom') return 'responses';
  if (def.id === 'ollama') return 'chat_completions';
  if (def.compatibility === 'anthropic') return 'messages';
  // An OpenAI-compatible gateway may expose a Claude-named model through the
  // Responses or Chat Completions shape. The selected endpoint contract wins.
  if (def.compatibility === 'openai') return null;

  const model = modelId.trim();
  const base = def.base_url.toLowerCase();
  if (GPT_MODEL.test(model) || base.includes('api.openai.com')) return 'responses';
  if (CLAUDE_MODEL.test(model) || base.includes('api.anthropic.com')) return 'messages';
  if (!def.user_defined && def.wire_api) return def.wire_api;
  return null;
}

/** Resolve once during provider/model configuration; runtime uses the persisted result verbatim. */
export function knownProviderWireApi(
  def: ProviderDefinition,
  modelId: string,
  configured?: ProviderWireApi | null,
): ProviderWireApi | null {
  return enforcedProviderWireApi(def, modelId) ?? configured ?? null;
}

export function determineProviderWireApi(
  def: ProviderDefinition,
  modelId: string,
  requested?: ProviderWireApi | null,
): ProviderWireApi {
  return knownProviderWireApi(def, modelId, requested) ?? 'chat_completions';
}

/** Cloud-native transports cannot be made correct by parsing tool calls from model text. */
export function requiresNativeTools(wireApi: ProviderWireApi): boolean {
  return wireApi === 'responses' || wireApi === 'messages';
}

/** Used only by the configuration connection test, never by normal model execution. */
export function configurationWireCandidates(
  def: ProviderDefinition,
  modelId: string,
  configured?: ProviderWireApi | null,
): ProviderWireApi[] {
  const known = knownProviderWireApi(def, modelId, configured);
  if (known) return [known];
  if (def.compatibility === 'openai') return ['responses', 'chat_completions'];
  if (def.compatibility === 'anthropic') return ['messages'];
  return ['responses', 'messages', 'chat_completions'];
}

export async function selectWireApiAtConfiguration<T extends { ok: boolean; note: string }>(
  def: ProviderDefinition,
  modelId: string,
  configured: ProviderWireApi | null | undefined,
  probe: (wireApi: ProviderWireApi) => Promise<T>,
): Promise<{
  selected: ProviderWireApi | null;
  result: T;
  attempts: string[];
}> {
  const candidates = configurationWireCandidates(def, modelId, configured);
  let result: T | null = null;
  const attempts: string[] = [];
  for (const candidate of candidates) {
    result = await probe(candidate);
    attempts.push(`${candidate}:${result.ok ? 'ok' : result.note.slice(0, 80)}`);
    if (result.ok) return { selected: candidate, result, attempts };
  }
  if (!result) throw new Error('WIRE_CONFIGURATION_NO_CANDIDATES');
  return { selected: null, result, attempts };
}

export function wireApiLabel(wireApi: ProviderWireApi): string {
  if (wireApi === 'responses') return 'Responses';
  if (wireApi === 'messages') return 'Anthropic Messages';
  return 'Chat Completions';
}
