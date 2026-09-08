import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../ui/workspace/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../ui/workspace/src/lib/chatHistoryNavigation.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { historyTarget, navigateHistory, focusHistoryBackground } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const anchors = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'].map((role, i) => ({ id: String(i), role, top: 24 + i * 400 }));
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
for (const [key, expected] of [['ArrowLeft', '0'], ['ArrowRight', '4'], ['ArrowUp', '2'], ['ArrowDown', '4']]) {
  equal(historyTarget(anchors, key, 1212, null)?.id, expected);
}
equal(historyTarget(anchors, 'ArrowUp', 0, null)?.id, '0');
equal(historyTarget(anchors, 'ArrowDown', 9999, null)?.id, '5');
equal(historyTarget(anchors, 'ArrowRight', 9999, null)?.id, '4');
equal(historyTarget([], 'ArrowDown', 0, null), undefined);
equal(historyTarget([{ id: 'a', role: 'assistant', top: 0 }], 'ArrowLeft', 0, null), undefined);
const container = {
  scrollTop: 12, clientHeight: 500, ownerDocument: {},
  scrollTo({ top }) { this.scrollTop = Math.max(0, Math.min(1700, top)); },
  focus(options) { this.ownerDocument.activeElement = this; equal(options, { preventScroll: true }); },
};
container.ownerDocument.activeElement = container;
const event = (key, overrides = {}) => ({ key, target: container, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides });
let cursor = null;
for (const id of ['1', '2', '3', '4', '5', '5']) {
  const e = event('ArrowDown');
  cursor = navigateHistory(e, container, anchors, cursor);
  equal(cursor.id, id); equal(e.defaultPrevented, true); equal(e.stopped, true);
}
cursor = navigateHistory(event('ArrowUp'), container, anchors, cursor);
equal(cursor.id, '4'); // reverse from the clamped final message
container.scrollTop = 812; // manual scrolling invalidates the previous logical anchor
cursor = navigateHistory(event('ArrowDown'), container, anchors, cursor);
equal(cursor.id, '3');
container.scrollTop = 1000;
equal(navigateHistory(event('PageUp'), container, anchors, cursor), null);
equal(container.scrollTop, 550);
navigateHistory(event('PageDown'), container, anchors, null);
equal(container.scrollTop, 1000);
for (const overrides of [{ target: {} }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
  const e = event('ArrowDown', overrides);
  equal(navigateHistory(e, container, anchors, cursor), cursor);
  equal(container.scrollTop, 1000);
}
let e = event('ArrowDown');
navigateHistory(e, container, anchors, cursor, true);
equal(e.defaultPrevented, false);
container.ownerDocument.activeElement = {};
e = event('ArrowDown');
navigateHistory(e, container, anchors, cursor);
equal(e.defaultPrevented, false);
globalThis.Element = class { constructor(blocked) { this.blocked = blocked; } closest() { return this.blocked ? {} : null; } };
focusHistoryBackground(container, new Element(true));
equal(container.ownerDocument.activeElement === container, false);
focusHistoryBackground(container, new Element(false));
equal(container.ownerDocument.activeElement, container);
console.log(`PASS: ${checks} chat history navigation assertions`);
