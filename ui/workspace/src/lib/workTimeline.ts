import type { WorkTimelineItem } from '../types';

/**
 * Client mirror of the server-authoritative interleaved work timeline
 * (CQR_PA #6). The live chat reducer builds the same order the server persists
 * so the flat timeline (response / tool interleave) matches after restore.
 */

const MAX_SEGMENT_CHARS = 8_000;
const MAX_ITEMS = 200;

function bound(timeline: WorkTimelineItem[]): WorkTimelineItem[] {
  return timeline.length <= MAX_ITEMS ? timeline : timeline.slice(timeline.length - MAX_ITEMS);
}

/** Extend the trailing response segment, or open a new one after a tool item. */
export function pushResponseDelta(
  timeline: readonly WorkTimelineItem[],
  delta: string,
): WorkTimelineItem[] {
  if (!delta) return [...timeline];
  const next = [...timeline];
  const last = next[next.length - 1];
  if (last && last.kind === 'response') {
    next[next.length - 1] = { kind: 'response', text: (last.text + delta).slice(-MAX_SEGMENT_CHARS) };
  } else {
    next.push({ kind: 'response', text: delta.slice(-MAX_SEGMENT_CHARS) });
  }
  return bound(next);
}

/** Record a tool at its arrival position; repeated ids never reorder. */
export function pushToolMarker(
  timeline: readonly WorkTimelineItem[],
  id: string,
): WorkTimelineItem[] {
  if (!id || timeline.some((item) => item.kind === 'tool' && item.id === id)) return [...timeline];
  return bound([...timeline, { kind: 'tool', id }]);
}

/** Validate a restored timeline from a persisted session message. */
export function sanitizeWorkTimeline(value: unknown): WorkTimelineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkTimelineItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.kind === 'response' && typeof item.text === 'string') {
      out.push({ kind: 'response', text: item.text.slice(-MAX_SEGMENT_CHARS) });
    } else if (item.kind === 'tool' && typeof item.id === 'string' && item.id) {
      out.push({ kind: 'tool', id: item.id });
    }
  }
  return out.length ? bound(out) : undefined;
}
