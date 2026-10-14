/**
 * Detect a language-model change from stored reply metadata only.
 * User wording is never classified. The notice states the fact; it does not
 * prescribe behavior beyond re-checking claims before asserting file contents.
 */
import { findVideoModel } from '../video/video-models.js';

export interface ModelSwitchMessage {
  role: string;
  content?: string;
  model?: string;
  mode?: string;
  status?: string;
  model_exclude?: boolean;
  application_notice?: unknown;
  video_job?: unknown;
}

export interface ModelSwitch {
  /** Stored ref of the previous language-model streak (display form, not normalized). */
  previous: string;
  current: string;
  /** Replies in the passed history written by `previous` since the prior switch. */
  previousReplies: number;
  lastPreviousIndex: number;
}

const NON_LLM_MODES = new Set([
  'image_gen',
  'deep_research',
  'browser_automation',
  'browser_agent',
  'web_crawl',
  'automaton_direct',
  'org:market_research',
  'org:size_guide',
]);

const NON_LLM_PREFIX = /^(automaton|browser|org|filter|policy|video)\//i;
const NON_LLM_EXACT = /^(중지됨|stopped|none)$/i;

/**
 * OpenRouter-style vendor slugs. A stored ref is `DisplayName/vendor/model`
 * (3+ segments). The display name is dropped only when the first segment is
 * not itself a vendor slug, so `OpenRouter/anthropic/claude-x` and
 * `anthropic/claude-x` compare equal.
 */
const VENDOR_SLUGS = new Set([
  'openai', 'anthropic', 'google', 'meta-llama', 'meta', 'x-ai', 'mistralai',
  'deepseek', 'qwen', 'cohere', 'perplexity', 'moonshotai', 'amazon', 'nvidia',
  'microsoft', 'bytedance', 'sakana', 'z-ai', 'groq',
]);

export function isVideoModelRef(ref: string): boolean {
  const raw = ref.trim();
  if (!raw) return false;
  if (findVideoModel(raw)) return true;
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && findVideoModel(parts.slice(-2).join('/'))) return true;
  if (parts.length >= 3 && findVideoModel(parts.slice(1).join('/'))) return true;
  return false;
}

/** Comparable identity, or null when the ref is not a language model. */
export function normalizeModelRef(ref: string | undefined | null): string | null {
  const raw = String(ref ?? '').trim();
  if (!raw || NON_LLM_EXACT.test(raw) || NON_LLM_PREFIX.test(raw) || isVideoModelRef(raw)) return null;
  let parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length >= 3 && !VENDOR_SLUGS.has(parts[0].toLowerCase())) parts = parts.slice(1);
  const id = parts.join('/').toLowerCase();
  if (!id || isVideoModelRef(id)) return null;
  return id;
}

export function sameModelRef(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeModelRef(a);
  const right = normalizeModelRef(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export function isComparableLanguageModelReply(message: ModelSwitchMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.model_exclude === true) return false;
  if (message.video_job) return false;
  const content = String(message.content ?? '').trim();
  if (message.status === 'stopped' && !content) return false;
  if (message.application_notice && !content) return false;
  if (message.mode && NON_LLM_MODES.has(message.mode)) return false;
  return normalizeModelRef(message.model) !== null;
}

/**
 * Notice only when the last comparable reply in `history` used a different model.
 * After the new model replies once, the last comparable reply matches and the
 * notice disappears — no stored flag.
 */
export function detectModelSwitch(
  history: readonly ModelSwitchMessage[],
  currentRef: string,
): ModelSwitch | null {
  if (!normalizeModelRef(currentRef)) return null;
  let previous: string | null = null;
  let previousReplies = 0;
  let lastPreviousIndex = -1;
  for (let i = 0; i < history.length; i += 1) {
    const message = history[i];
    if (!isComparableLanguageModelReply(message)) continue;
    const ref = String(message.model);
    if (previous && sameModelRef(previous, ref)) {
      previousReplies += 1;
      lastPreviousIndex = i;
      continue;
    }
    previous = ref;
    previousReplies = 1;
    lastPreviousIndex = i;
  }
  if (!previous || sameModelRef(previous, currentRef)) return null;
  return { previous, current: currentRef, previousReplies, lastPreviousIndex };
}

export function formatModelSwitchTurnNote(hit: ModelSwitch | null): string {
  if (!hit) return '';
  const n = hit.previousReplies;
  return [
    '### Model switch',
    `The previous ${n} ${n === 1 ? 'reply' : 'replies'} in this context ${n === 1 ? 'was' : 'were'} written by \`${hit.previous}\`. You are \`${hit.current}\`.`,
    'Claims and results in those replies were written by a different model. Re-check file contents before asserting them.',
  ].join('\n');
}

export function formatResumeModelSwitchLine(previous: string, current: string): string {
  return `This stored run was progressed by \`${previous}\`; you (\`${current}\`) are resuming it.`;
}

/** User-message context only. Does not touch a system prompt. */
export function prependModelSwitchContext(
  context: string | undefined,
  history: readonly ModelSwitchMessage[],
  currentRef: string,
): string | undefined {
  const note = formatModelSwitchTurnNote(detectModelSwitch(history, currentRef));
  if (!note) return context;
  const base = context?.trim();
  return base ? `${base}\n\n${note}` : note;
}
