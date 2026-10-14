/**
 * Chat divider for a language-model change. Mirrors core/src/chat/model-switch.ts
 * comparison rules (the UI cannot import core). Stored `turn.model` only — no
 * wording classification.
 */

const NON_LLM_PREFIX = /^(automaton|browser|org|filter|policy|video)\//i;
const NON_LLM_EXACT = /^(중지됨|stopped|none)$/i;
const VENDOR_SLUGS = new Set([
  'openai', 'anthropic', 'google', 'meta-llama', 'meta', 'x-ai', 'mistralai',
  'deepseek', 'qwen', 'cohere', 'perplexity', 'moonshotai', 'amazon', 'nvidia',
  'microsoft', 'bytedance', 'sakana', 'z-ai', 'groq',
]);

export interface ModelSwitchTurn {
  role: string;
  model?: string;
  mode?: string;
  text?: string;
  videoJob?: unknown;
  imageUrls?: string[];
  applicationNotice?: unknown;
}

export function normalizeModelRef(ref: string | undefined | null): string | null {
  const raw = String(ref ?? '').trim();
  if (!raw || NON_LLM_EXACT.test(raw) || NON_LLM_PREFIX.test(raw)) return null;
  let parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length >= 3 && !VENDOR_SLUGS.has(parts[0].toLowerCase())) parts = parts.slice(1);
  return parts.join('/').toLowerCase();
}

export function sameModelRef(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeModelRef(a);
  const right = normalizeModelRef(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function isVideoRef(ref: string, videoIds: ReadonlySet<string>): boolean {
  if (videoIds.size === 0) return false;
  if (videoIds.has(ref)) return true;
  const norm = normalizeModelRef(ref);
  if (norm && videoIds.has(norm)) return true;
  for (const id of videoIds) {
    if (ref.endsWith(`/${id}`) || (norm && (norm === id || norm.endsWith(`/${id}`)))) return true;
  }
  return false;
}

export function isComparableAssistantTurn(
  turn: ModelSwitchTurn,
  videoIds: ReadonlySet<string> = new Set(),
): boolean {
  if (turn.role !== 'assistant') return false;
  const model = turn.model?.trim();
  if (!model) return false;
  if (turn.videoJob) return false;
  if (turn.mode === 'image') return false;
  if (turn.imageUrls?.some((url) => /\/outputs\/videos\//.test(url) || /\.(mp4|webm)(\?|$)/i.test(url))) return false;
  if (turn.applicationNotice && !turn.text?.trim()) return false;
  if (isVideoRef(model, videoIds)) return false;
  return normalizeModelRef(model) !== null;
}

/** Divider to draw above `turns[index]`, or null. */
export function videoIdsFromPicker(options: readonly { id: string; category?: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const option of options) {
    if (option.category !== 'video') continue;
    ids.add(option.id);
    const at = option.id.lastIndexOf('@');
    if (at < 0) continue;
    try {
      ids.add(decodeURIComponent(option.id.slice(at + 1)));
    } catch {
      ids.add(option.id.slice(at + 1));
    }
  }
  return ids;
}

export function modelSwitchBefore(
  turns: readonly ModelSwitchTurn[],
  index: number,
  videoIds: ReadonlySet<string> = new Set(),
): { previous: string; current: string } | null {
  const turn = turns[index];
  if (!turn || !isComparableAssistantTurn(turn, videoIds) || !turn.model) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = turns[i];
    if (!isComparableAssistantTurn(prior, videoIds) || !prior.model) continue;
    if (sameModelRef(prior.model, turn.model)) return null;
    return { previous: prior.model, current: turn.model };
  }
  return null;
}
