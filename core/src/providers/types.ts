export type ProviderKind = 'openai_compatible' | 'search';
export type ProviderWireApi = 'responses' | 'messages' | 'chat_completions';
export type ProviderToolProtocol = 'native' | 'text';
export type ProviderCompatibility = 'openai' | 'anthropic';

export interface ProviderDefinition {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  default_model: string;
  custom?: boolean;
  /** User-added OpenAI-compatible endpoint (Base URL + key + model). */
  user_defined?: boolean;
  /** Compatibility family selected when a user-defined endpoint is created. */
  compatibility?: ProviderCompatibility;
  docs_url?: string;
  note?: string;
  /** Allowed when local_only policy is on (e.g. NAS Ollama). */
  local_only_ok?: boolean;
  /** Preferred LLM wire protocol. */
  wire_api?: ProviderWireApi;
}

export interface ProviderCatalogFile {
  version: number;
  providers: ProviderDefinition[];
}

export interface UserProviderMeta {
  name: string;
  base_url: string;
  default_model: string;
  wire_api?: ProviderWireApi;
  compatibility?: ProviderCompatibility;
  created_at: string;
}

export interface ProviderSecretEntry {
  api_key: string;
  base_url?: string;
  model_id?: string;
  /** Fixed at configuration time; execution never negotiates or falls back. */
  wire_api?: ProviderWireApi;
  /** Fixed by the configuration connection test; execution never negotiates or falls back. */
  tool_protocol?: ProviderToolProtocol;
  updated_at: string;
}

export interface ProviderVaultFile {
  version: number;
  default_provider_id: string | null;
  entries: Record<string, ProviderSecretEntry>;
  /** Personal OpenAI-compatible providers (id starts with `user_`). */
  user_defs?: Record<string, UserProviderMeta>;
}

export interface ProviderPublicStatus {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  default_model: string;
  custom?: boolean;
  user_defined?: boolean;
  compatibility?: ProviderCompatibility;
  docs_url?: string;
  note?: string;
  configured: boolean;
  is_default: boolean;
  model_id: string | null;
  key_hint: string | null;
  updated_at: string | null;
  wire_api: ProviderWireApi;
  wire_api_confirmed: boolean;
  tool_protocol: ProviderToolProtocol;
  tool_protocol_confirmed: boolean;
  secret_storage: 'local_encrypted';
  secret_backend?: import('./os-secret-store.js').SecretStoreBackend;
}

export interface ResolvedModelRoute {
  display: string;
  route:
    | { type: 'provider'; providerId: string; modelId: string; baseUrl: string }
    | { type: 'local'; modelId: string; path: string; filename: string }
    | { type: 'stub'; reason: string };
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
