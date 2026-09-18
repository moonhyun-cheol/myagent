#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const chatPane = readFileSync(path.join(root, 'ui/workspace/src/components/ChatPane.tsx'), 'utf8');
const transferHelper = readFileSync(path.join(root, 'ui/workspace/src/lib/clipboardImages.ts'), 'utf8');
const workspaceStore = readFileSync(path.join(root, 'ui/workspace/src/store/workspaceStore.ts'), 'utf8');
const shellXaml = readFileSync(path.join(root, 'shell/CqrPa.Shell/MainWindow.xaml'), 'utf8');
const shellMain = readFileSync(path.join(root, 'shell/CqrPa.Shell/MainWindow.xaml.cs'), 'utf8');
const shellDrop = readFileSync(path.join(root, 'shell/CqrPa.Shell/MainWindow.ExternalFileDrop.cs'), 'utf8');

assert.match(chatPane, /addEventListener\('drop',\s*onComposerDrop,\s*true\)/, 'drop must use a native capture listener');
assert.match(chatPane, /addEventListener\('dragover',\s*onComposerDragOver,\s*true\)/, 'dragover must use a native capture listener');
assert.match(chatPane, /filesFromDataTransfer\(dataTransfer\)/, 'drop must share the attachment ingestion path');
assert.match(chatPane, /드롭한 파일을 읽지 못했습니다/, 'unreadable drops need a visible explanation');
assert.match(transferHelper, /data\.files/, 'standard DataTransfer files must be supported');
assert.match(transferHelper, /data\.items/, 'WebView2 DataTransfer item fallback must be supported');
assert.match(transferHelper, /getAsFile\(\)/, 'file items must be converted synchronously during drop');
assert.match(shellXaml, /AllowDrop="True"/, 'the WPF shell must accept Explorer OLE drops');
assert.match(shellXaml, /WebView2CompositionControl[^>]+AllowExternalDrop="False"/, 'the shell must own external drops instead of WebView2 swallowing them');
assert.match(shellMain, /InitializeExternalFileDrop\(\)/, 'the native drop bridge must initialize with the shell');
assert.match(shellMain, /composer\.externalDrop\.accept/, 'the shell must receive composer acceptance');
assert.match(shellDrop, /DragDrop\.DropEvent/, 'the shell must subscribe to native drop events');
assert.match(shellDrop, /DataFormats\.FileDrop/, 'the shell must extract Explorer file paths');
assert.match(shellDrop, /MultipartFormDataContent/, 'native files must use the attachment multipart route');
assert.match(shellDrop, /X-CQR-Session/, 'native uploads must remain scoped to the owning chat');
assert.match(shellDrop, /xRatio[\s\S]+yRatio/, 'the shell must publish normalized drop coordinates');
assert.match(chatPane, /pointTargetsComposer/, 'native drops must be limited to the composer surface');
assert.match(chatPane, /composer\.externalDrop/, 'the composer must consume native shell drop messages');
assert.match(workspaceStore, /acceptExternalFileDrop[\s\S]+adoptExternalFileDrop/, 'the store must accept and adopt native uploads');

const assetsDir = path.join(root, 'ui/workspace/dist/assets');
assert.ok(existsSync(assetsDir), 'workspace production bundle is required');
const bundle = readdirSync(assetsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(path.join(assetsDir, name), 'utf8'))
  .join('\n');
assert.match(bundle, /드롭한 파일을 읽지 못했습니다/, 'production bundle must contain the external-drop failure path');
assert.match(bundle, /composer\.externalDrop/, 'production bundle must contain the native shell drop bridge');

console.log('chat external file drop contract and production bundle: PASS');
