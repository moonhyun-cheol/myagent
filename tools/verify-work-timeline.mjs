/**
 * CQR_PA port #6 — unified workflow: interleaved response/tool timeline.
 * Verifies the arrival-order reducer (server-authoritative), the sanitize/
 * restore round-trip, and that the store + ChatPane wire the timeline in.
 *
 * Run: node node_modules/typescript/bin/tsc -p tsconfig.json && node tools/verify-work-timeline.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pushResponseDelta,
  pushToolMarker,
  sanitizeWorkTimeline,
} from '../core/dist/sessions/work-timeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`ok - ${name}`); };

// 1. Spec §동작기준 1: events 응답 A, 작업 A, 작업 B, 응답 B, 작업 C keep order.
check('interleave preserves arrival order', () => {
  let tl = [];
  tl = pushResponseDelta(tl, '응답 A');
  tl = pushToolMarker(tl, 'toolA');
  tl = pushToolMarker(tl, 'toolB');
  tl = pushResponseDelta(tl, '응답 B');
  tl = pushToolMarker(tl, 'toolC');
  assert.deepEqual(tl, [
    { kind: 'response', text: '응답 A' },
    { kind: 'tool', id: 'toolA' },
    { kind: 'tool', id: 'toolB' },
    { kind: 'response', text: '응답 B' },
    { kind: 'tool', id: 'toolC' },
  ]);
});

// 2. Consecutive thought deltas merge into the trailing response segment.
check('consecutive response deltas merge', () => {
  let tl = pushResponseDelta([], 'Hello');
  tl = pushResponseDelta(tl, ' world');
  assert.equal(tl.length, 1);
  assert.deepEqual(tl[0], { kind: 'response', text: 'Hello world' });
});

// 3. Spec §동작기준 2: repeated tool id (status updates) does not reorder/dup.
check('tool status update does not reorder', () => {
  let tl = pushToolMarker([], 'x');
  tl = pushResponseDelta(tl, 'mid');
  tl = pushToolMarker(tl, 'x'); // late status update for same execution
  assert.deepEqual(tl, [
    { kind: 'tool', id: 'x' },
    { kind: 'response', text: 'mid' },
  ]);
});

// 4. Response after a tool opens a NEW segment (interleave, not append).
check('response after tool opens new segment', () => {
  let tl = pushResponseDelta([], 'first');
  tl = pushToolMarker(tl, 't1');
  tl = pushResponseDelta(tl, 'second');
  assert.deepEqual(tl.map((i) => i.kind), ['response', 'tool', 'response']);
  assert.equal(tl[2].text, 'second');
});

// 5. Spec §세션: persisted timeline restores through sanitize (compat guard).
check('sanitize restores valid timeline and drops junk', () => {
  const stored = [
    { kind: 'response', text: 'ok' },
    { kind: 'tool', id: 'a' },
    { kind: 'bogus', id: 'z' },
    { kind: 'tool' },
    null,
    { kind: 'response', text: 5 },
  ];
  const restored = sanitizeWorkTimeline(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(restored, [
    { kind: 'response', text: 'ok' },
    { kind: 'tool', id: 'a' },
  ]);
  assert.equal(sanitizeWorkTimeline(undefined), undefined, 'legacy (no field) => undefined');
  assert.equal(sanitizeWorkTimeline([]), undefined, 'empty => undefined (legacy fallback)');
});

// 6. Server persists work_timeline on the assistant message (types + store wiring).
check('core session-store attaches work_timeline at persist points', () => {
  const store = readFileSync(path.join(root, 'core/src/sessions/session-store.ts'), 'utf8');
  assert.ok(store.includes('pendingWorkTimeline'), 'pending timeline map present');
  assert.ok(store.includes('pushResponseDelta') && store.includes('pushToolMarker'), 'reducers wired');
  const attachCount = (store.match(/work_timeline: timeline/g) || []).length;
  assert.ok(attachCount >= 2, `work_timeline attached at persist points (found ${attachCount})`);
  const types = readFileSync(path.join(root, 'core/src/sessions/types.ts'), 'utf8');
  assert.ok(types.includes('work_timeline?'), 'SessionMessage.work_timeline declared');
});

// 7. UI wires live reducers + restore + interleaved render (legacy fallback kept).
check('ui store + ChatPane wire the interleaved timeline', () => {
  const storeSrc = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
  assert.ok(storeSrc.includes('pushResponseDelta') && storeSrc.includes('pushToolMarker'), 'live reducers wired');
  assert.ok(storeSrc.includes('sanitizeWorkTimeline'), 'restore mapping wired');
  const pane = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
  assert.ok(pane.includes('turn.workTimeline?.length'), 'interleaved branch present');
  assert.ok(pane.includes("!turn.workTimeline?.length && turn.toolActivity?.length"), 'legacy ToolActivityLog fallback guarded');
});

console.log(JSON.stringify({ ok: true, checks: pass }));
