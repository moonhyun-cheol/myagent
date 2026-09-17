#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const chatPane = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
const transferHelper = readFileSync(path.join(root, 'ui/workspace/src/lib/clipboardImages.ts'), 'utf8');

assert.match(chatPane, /addEventListener\('drop',\s*onComposerDrop,\s*true\)/, 'drop must use a native capture listener');
assert.match(chatPane, /addEventListener\('dragover',\s*onComposerDragOver,\s*true\)/, 'dragover must use a native capture listener');
assert.match(chatPane, /filesFromDataTransfer\(dataTransfer\)/, 'drop must share the attachment ingestion path');
assert.match(chatPane, /드롭한 파일을 읽지 못했습니다/, 'unreadable drops need a visible explanation');
assert.match(transferHelper, /data\.files/, 'standard DataTransfer files must be supported');
assert.match(transferHelper, /data\.items/, 'WebView2 DataTransfer item fallback must be supported');
assert.match(transferHelper, /getAsFile\(\)/, 'file items must be converted synchronously during drop');

const assetsDir = path.join(root, 'ui/workspace/dist/assets');
assert.ok(existsSync(assetsDir), 'workspace production bundle is required');
const bundle = readdirSync(assetsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(path.join(assetsDir, name), 'utf8'))
  .join('\n');
assert.match(bundle, /드롭한 파일을 읽지 못했습니다/, 'production bundle must contain the external-drop failure path');

console.log('chat external file drop contract and production bundle: PASS');
