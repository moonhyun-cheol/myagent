#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ui = readFileSync(path.join(root, 'ui/workspace/src/components/MainWorkspaceContainer.tsx'), 'utf8');
const objects = readFileSync(path.join(root, 'ui/workspace/src/components/WorkspaceObjectsPane.tsx'), 'utf8');
const chat = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
const store = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
const client = readFileSync(path.join(root, 'ui/workspace/src/api/cqrClient.ts'), 'utf8');
const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');

assert.match(ui, /WorkspaceObjectsPane/);
assert.match(objects, /data-testid="open-workspace-explorer"/);
assert.match(objects, /openWorkspaceRootInExplorer\(\)/);
assert.doesNotMatch(ui, /id: 'editor', label: '코드'/);
assert.doesNotMatch(chat, /Preview에서 검토/);
assert.doesNotMatch(store, /await get\(\)\.openMutatedWorkspaceFiles\(\[\.\.\.mutatedWorkspacePaths\]\)/);
assert.doesNotMatch(store, /get\(\)\.openAssetInEditor\(asset\.id\)/);
assert.match(client, /fetch\('\/fs\/open-workspace-root'/);
assert.match(client, /fetch\('\/fs\/open-workspace-path'/);
assert.match(client, /'X-CQR-Session'/);
assert.match(dispatch, /url\.pathname === '\/fs\/open-workspace-root'/);
assert.match(dispatch, /url\.pathname === '\/fs\/open-workspace-path'/);
assert.match(dispatch, /const root = workspaceRootForRequest\(\)/);
assert.match(dispatch, /spawn\(command, \[root\]/);

const distAssets = path.join(root, 'ui/workspace/dist/assets');
const bundle = readdirSync(distAssets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(path.join(distAssets, name), 'utf8'))
  .join('\n');
assert.match(bundle, /\/fs\/open-workspace-root/);
assert.match(bundle, /open-workspace-explorer/);
assert.match(bundle, /탐색기/);

console.log('preview explorer + no auto code tabs: PASS');
