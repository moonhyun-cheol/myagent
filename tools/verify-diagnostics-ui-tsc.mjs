#!/usr/bin/env node
/**
 * When session mutate paths include ui/workspace/src, detectDiagnostics must NOT
 * pick the root core-only `tsc --noEmit -p tsconfig.json` (false Exit 0).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  detectDiagnostics,
  pathsFocusWorkspaceUiSrc,
} = await import('../core/dist/agent/run-diagnostics.js');

assert.equal(pathsFocusWorkspaceUiSrc(undefined), false);
assert.equal(pathsFocusWorkspaceUiSrc(['core/src/agent/x.ts']), false);
assert.equal(
  pathsFocusWorkspaceUiSrc(['ui/workspace/src/components/MainWorkspaceContainer.tsx']),
  true,
);
assert.equal(
  pathsFocusWorkspaceUiSrc(['core/src/a.ts', 'ui\\workspace\\src\\store\\workspaceStore.ts']),
  true,
);

const coreOnly = detectDiagnostics(root, { focusPaths: ['core/src/agent/code-agent.ts'] });
assert.equal(coreOnly.kind, 'tsc');
assert.match(coreOnly.command ?? '', /tsconfig\.json/);
assert.equal(/ui\/workspace/.test(coreOnly.command ?? ''), false);

const uiFocus = detectDiagnostics(root, {
  focusPaths: ['ui/workspace/src/components/MainWorkspaceContainer.tsx'],
});
assert.equal(uiFocus.kind, 'tsc');
assert.match(uiFocus.command ?? '', /ui\/workspace/);
assert.match(uiFocus.command ?? '', /tsc -b/);
assert.match(uiFocus.reason ?? '', /core-only|workspace tsc/i);

console.log('verify-diagnostics-ui-tsc: ok');
