import type { ExecutionPolicy } from '../execution-policy.js';

export interface PublicReasoningRecord {
  version: 1;
  /** Only provider-exposed reasoning summaries and visible agent work logs are persisted. */
  format: 'public_summary';
  content: string;
  /** Actual model reported for this assistant response. */
  model?: string;
}

export interface ApplicationNotice {
  kind: 'continuation' | 'failure';
  title: string;
  message: string;
  /** Actual runtime model; never replace with a synthetic policy label. */
  model?: string;
  /** Cumulative execution time across explicit continuation runs. */
  elapsedMs?: number;
  /** Last completed orchestration step represented by this notice. */
  step?: number;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  model?: string;
  mode?: string;
  /** Normalized public reasoning/work log for this exact assistant response. */
  reasoning?: PublicReasoningRecord;
  /** @deprecated Legacy public work-log field; read for backward compatibility only. */
  thought?: string;
  /** Local `/outputs/images/...` URLs for chat + image_gen restore */
  image_urls?: string[];
  /** Host/application notice rendered separately from model-authored content. */
  application_notice?: ApplicationNotice;
  /**
   * When true, UI may still show the message but it must not be fed back to the model.
   * Used for guardrail / hallucination-block notices that would pollute later turns.
   */
  model_exclude?: boolean;
}

export type ResponsesStateMode = 'provider_state' | 'client_replay';

/** Durable continuation state for a Responses-native conversation chain. */
export interface ResponsesContinuationState {
  version: 1;
  mode: ResponsesStateMode;
  provider_id: string;
  model_id: string;
  previous_response_id?: string;
  /** Tool schema represented by this chain. Missing/mismatched hashes invalidate legacy state. */
  tool_schema_hash?: string;
  /** First ChatMessage index not represented by the preceding response chain. */
  next_message_index: number;
  /**
   * Counting basis for next_message_index. 'dynamic' = durable non-system messages
   * only; system and ephemeral context-profile guidance travel via `instructions`.
   * Absent = legacy full-array chain; safely rebuilt in full on next call.
   */
  index_basis?: 'dynamic';
  /** Exact Responses input/output items used when provider-side storage is unavailable. */
  replay_items?: unknown[];
  reasoning_context?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: SessionMessage[];
  /** null/undefined = 일반(프로젝트 없음) 대화 */
  project_id?: string | null;
  /** Optional per-chat binding to a registered workspace_root project. */
  workspace_project_id?: string | null;
  /** Snapshot copied from PC defaults when the session is created; independent afterwards. */
  execution_policy?: ExecutionPolicy;
  /** Model selected for this conversation. Missing means inherit scope/global defaults. */
  preferred_model?: string;
  /** Absolute roots writable by this conversation; first entry is the relative-path base and every entry is enforced. */
  allowed_paths?: string[];
  /** The active model/provider owns one chain; switching either starts a new chain. */
  responses_state?: ResponsesContinuationState;
  /** Independent chat/agent/MAR lanes; prevents concurrent roles from sharing a chain. */
  responses_states?: Record<string, ResponsesContinuationState>;
}

export interface SessionSummary {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
  project_id?: string | null;
  workspace_project_id?: string | null;
  preferred_model?: string;
  allowed_paths?: string[];
}
