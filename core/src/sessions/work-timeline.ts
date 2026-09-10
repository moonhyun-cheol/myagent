/**
 * Interleaved chat work timeline (CQR_PA #6 unified-workflow-cancel).
 *
 * Records the arrival order of model response segments and tool executions so
 * a chat turn can be rendered as a flat timeline (`응답 1 → 작업 1 → 작업 2 →
 * 응답 2 → … → 최종 응답`) instead of the old two-stage panel that grouped all
 * reasoning first and all tool activity after. Ordering is authoritative on the
 * server (SSE emit order); the client mirrors the same reducer for live render.
 *
 * Items are metadata only:
 *  - `response` carries the accumulated public reasoning/work-log segment text.
 *  - `tool` references a `ToolActivity.id`; the execution snapshot itself stays
 *    in `tool_activity` so status/output/cancel state is not duplicated here.
 */

export type WorkTimelineItem =
  | { kind: 'response'; text: string }
  | { kind: 'tool'; id: string };

/** Per-response-segment cap so one long reasoning burst cannot grow unbounded. */
export const MAX_TIMELINE_SEGMENT_CHARS = 8_000;
/** Hard cap on interleaved items retained for one assistant turn. */
export const MAX_TIMELINE_ITEMS = 200;

function boundItems(timeline: WorkTimelineItem[]): WorkTimelineItem[] {
  if (timeline.length <= MAX_TIMELINE_ITEMS) return timeline;
  return timeline.slice(timeline.length - MAX_TIMELINE_ITEMS);
}

/**
 * Append a `thought` delta. When the last item is a response segment the delta
 * extends it; otherwise (start, or the previous item was a tool) a new response
 * segment is opened so the interleave order is preserved.
 */
export function pushResponseDelta(
  timeline: readonly WorkTimelineItem[],
  delta: string,
): WorkTimelineItem[] {
  if (!delta) return [...timeline];
  const next = [...timeline];
  const last = next[next.length - 1];
  if (last && last.kind === 'response') {
    const merged = (last.text + delta).slice(-MAX_TIMELINE_SEGMENT_CHARS);
    next[next.length - 1] = { kind: 'response', text: merged };
  } else {
    next.push({ kind: 'response', text: delta.slice(-MAX_TIMELINE_SEGMENT_CHARS) });
  }
  return boundItems(next);
}

/**
 * Record a tool execution at its arrival position. Later status updates for the
 * same id must NOT reorder the item, so a repeated id is a no-op.
 */
export function pushToolMarker(
  timeline: readonly WorkTimelineItem[],
  id: string,
): WorkTimelineItem[] {
  if (!id) return [...timeline];
  if (timeline.some((item) => item.kind === 'tool' && item.id === id)) return [...timeline];
  return boundItems([...timeline, { kind: 'tool', id }]);
}

/** Runtime validation for restored/persisted timelines from untrusted JSON. */
export function sanitizeWorkTimeline(value: unknown): WorkTimelineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkTimelineItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.kind === 'response' && typeof item.text === 'string') {
      out.push({ kind: 'response', text: item.text.slice(-MAX_TIMELINE_SEGMENT_CHARS) });
    } else if (item.kind === 'tool' && typeof item.id === 'string' && item.id) {
      out.push({ kind: 'tool', id: item.id });
    }
  }
  return out.length ? boundItems(out) : undefined;
}
