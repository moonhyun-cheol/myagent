/**
 * Chat divider for a language-model change. Prefix stripping matches
 * core/src/chat/model-switch.ts (the UI cannot import core). The divider
 * compares the composer selection, not the id a latest alias resolved to.
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
  /** Composer selection. Preferred over the provider-resolved `model` for the divider. */
  selectedModel?: string;
  mode?: string;
  text?: string;
  videoJob?: unknown;
  imageUrls?: string[];
  applicationNotice?: unknown;
}

/** Divider identity: the user's selection, not the id the provider resolved it to. */
export function dividerModelRef(turn: ModelSwitchTurn): string | undefined {
  const selected = turn.selectedModel?.trim();
  if (selected && selected.toLowerCase() !== 'auto') return selected;
  return turn.model?.trim() || undefined;
}

function stripAliasMarker(part: string): string {
  return part.replace(/^~+/, '');
}

/**
 * Composer picks are `provider:<providerId>@<encoded model id>`; stored replies
 * without a selection carry the resolved `DisplayName/vendor/model`. Decode the
 * pick so both forms of the same model compare equal.
 */
function unwrapProviderPick(raw: string): string {
  if (!raw.toLowerCase().startsWith('provider:')) return raw;
  const at = raw.indexOf('@');
  if (at < 0) return raw;
  const encoded = raw.slice(at + 1);
  try {
    return decodeURIComponent(encoded).trim();
  } catch {
    return encoded.trim();
  }
}

export function normalizeModelRef(ref: string | undefined | null): string | null {
  const raw = unwrapProviderPick(String(ref ?? '').trim());
  if (!raw || NON_LLM_EXACT.test(raw) || NON_LLM_PREFIX.test(raw)) return null;
  let parts = raw.split('/').map((part) => stripAliasMarker(part.trim())).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length >= 3 && !VENDOR_SLUGS.has(parts[0].toLowerCase())) parts = parts.slice(1);
  return parts.join('/').toLowerCase();
}

function splitVendorName(id: string): { vendor: string; name: string } {
  const at = id.lastIndexOf('/');
  if (at < 0) return { vendor: '', name: id };
  return { vendor: id.slice(0, at), name: id.slice(at + 1) };
}

function latestAliasStem(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('-latest')) return lower.slice(0, -'-latest'.length);
  if (lower.endsWith(':latest')) return lower.slice(0, -':latest'.length);
  return null;
}

function versionlessStem(name: string): string {
  return name.toLowerCase().replace(/-\d+(?:\.\d+)*(?:-\d{6,8})?$/, '');
}

function latestAliasEquivalent(left: string, right: string): boolean {
  const a = splitVendorName(left);
  const b = splitVendorName(right);
  if (a.vendor !== b.vendor) return false;
  const aLatest = latestAliasStem(a.name);
  const bLatest = latestAliasStem(b.name);
  if (aLatest && bLatest) return aLatest === bLatest;
  const alias = aLatest ?? bLatest;
  if (!alias) return false;
  const concrete = aLatest ? b.name : a.name;
  return versionlessStem(concrete) === alias || concrete.toLowerCase() === alias;
}

export function sameModelRef(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeModelRef(a);
  const right = normalizeModelRef(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;
  return latestAliasEquivalent(left, right);
}

/**
 * Divider identity. A latest alias the user picked (`grok-latest`) stays
 * different from the concrete id the provider returned (`grok-4.7`), so the
 * line does not vanish when the reply completes.
 */
export function sameSelectionRef(a: string | undefined | null, b: string | undefined | null): boolean {
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
  const model = dividerModelRef(turn);
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
  const current = turn ? dividerModelRef(turn) : undefined;
  if (!turn || !isComparableAssistantTurn(turn, videoIds) || !current) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = turns[i];
    const previous = prior ? dividerModelRef(prior) : undefined;
    if (!isComparableAssistantTurn(prior, videoIds) || !previous) continue;
    if (sameSelectionRef(previous, current)) return null;
    return { previous, current };
  }
  return null;
}
