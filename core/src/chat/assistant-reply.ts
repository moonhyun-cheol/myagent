/**
 * Shared assistant reply persistence — same outlet/empty guarantees for every chat mode.
 */
import type { SessionStore } from '../sessions/session-store.js';
import type { ChatMode } from '../router/types.js';
import type { ExecutionPolicy } from '../execution-policy.js';
import {
  applyChatOutletFilter,
  looksLikeTruncatedAssistantReply,
} from './chat-filters.js';

export { looksLikeTruncatedAssistantReply };

export function scrubAssistantContent(
  content: string,
  sessionId?: string,
  userMessage?: string,
): string {
  return applyChatOutletFilter(content ?? '', { sessionId, userMessage }).text.trim();
}

const DEFAULT_EMPTY =
  '응답이 비어 있습니다. 같은 요청을 다시 보내 주세요.';

/**
 * Scrub outlet filters, reject empty, persist, return the stored body.
 */
export function appendAssistantReply(
  sessionStore: SessionStore,
  sessionId: string,
  opts: {
    content: string;
    model: string;
    mode: ChatMode | string;
    image_urls?: string[];
    emptyFallback?: string;
    /** Used for Korean-vs-Chinese outlet language warning */
    userMessage?: string;
    workspace_behavior?: ExecutionPolicy['workspace_behavior'];
    plan_constraints_locked?: boolean;
  },
): string {
  let content = scrubAssistantContent(opts.content, sessionId, opts.userMessage);
  if (!content) {
    content = (opts.emptyFallback ?? DEFAULT_EMPTY).trim();
  }
  sessionStore.append(sessionId, {
    role: 'assistant',
    content,
    at: new Date().toISOString(),
    model: opts.model,
    mode: opts.mode,
    ...(opts.image_urls?.length ? { image_urls: opts.image_urls } : {}),
    ...(opts.workspace_behavior ? { workspace_behavior: opts.workspace_behavior } : {}),
    ...(typeof opts.plan_constraints_locked === 'boolean'
      ? { plan_constraints_locked: opts.plan_constraints_locked }
      : {}),
  });
  return content;
}

/**
 * If narrative LLM text looks cut off / channel-leaked, run `retry` once and prefer the longer scrubbed body.
 */
export async function withNarrativeCompletionRetry(
  content: string,
  retry: () => Promise<string>,
  sessionId?: string,
  userMessage?: string,
): Promise<string> {
  let text = scrubAssistantContent(content, sessionId, userMessage);
  if (!looksLikeTruncatedAssistantReply(text)) return text;
  try {
    const again = scrubAssistantContent(await retry(), sessionId, userMessage);
    if (!again) return text;
    if (!looksLikeTruncatedAssistantReply(again)) return again;
    return again.length >= text.length ? again : text;
  } catch {
    return text;
  }
}

