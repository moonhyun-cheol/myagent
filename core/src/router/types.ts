import type { ExecutionPolicy } from '../execution-policy.js';

export type BuiltinChatMode =
  | 'chat'
  | 'image_gen'
  | 'deep_research'
  | 'web_dev'
  | 'web_landing'
  | 'prompt_master'
  | 'browser_automation'
  | 'browser_agent'
  | 'web_crawl'
  | 'code_agent'
  | 'automaton_direct';

export type ChatMode = BuiltinChatMode | `user:${string}`;

export const SKILL_CHAT_MODES: BuiltinChatMode[] = ['web_dev', 'web_landing', 'prompt_master'];

export interface RouteInput {
  message: string;
  explicitMode: ChatMode | null;
  hasAttachments: boolean;
}

export interface RouteDecision {
  mode: ChatMode;
  confidence: number;
  layer: 'explicit' | 'bypass' | 'L1' | 'L2' | 'intent' | 'default';
  matched_tool?: string;
}

/** Workspace UI → 채팅 API — 현재 편집 중 파일 힌트 (경량 컨텍스트) */
export interface EditorContext {
  path: string;
  selection?: string;
  error_snippet?: string;
  /** @ chips — extra workspace paths (files/folders) attached as context. */
  paths?: string[];
}

export interface ChatRequest {
  message: string;
  mode?: ChatMode | 'chat';
  attachments?: string[];
  /** `auto` | `cloud` | registry model id */
  model?: string;
  /** Session-scoped execution policy, snapshotted by the UI when this job is queued. */
  execution_policy?: ExecutionPolicy;
  /** @deprecated web search removed — kept for API compat */
  web_search?: boolean;
  editor_context?: EditorContext;
}

export interface ChatResponse {
  role: 'assistant';
  content: string;
  mode: ChatMode;
  routing: RouteDecision;
  model?: string;
  image?: { url: string; seed?: number };
  images?: { url: string }[];
  research?: { id: string; url: string; title: string };
  web_search?: { applied: boolean; source_count: number };
  /** Workspace paths mutated this code-agent turn (UI Preview auto-open). */
  mutatedPaths?: string[];
}
