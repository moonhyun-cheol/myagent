#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

assert.ok(existsSync(path.join(root, 'core/config/defaults/document-scratch.json')));
assert.ok(existsSync(path.join(root, 'ui/workspace/src/lib/documentFile.ts')));
assert.ok(existsSync(path.join(root, 'ui/workspace/src/components/MarkdownDocument.tsx')));

const modes = read('ui/workspace/src/components/workspacePreviewModes.ts');
assert.match(modes, /id:\s*'document'/);
assert.match(modes, /label:\s*'문서'/);
assert.doesNotMatch(modes, /label:\s*'캔버스'/);

const main = read('ui/workspace/src/components/MainWorkspaceContainer.tsx');
assert.match(main, /MarkdownDocument/);
assert.doesNotMatch(main, /MultiModalCanvas/);

const chat = read('ui/workspace/src/components/ChatPane.tsx');
assert.match(chat, /append-to-document/);
assert.match(chat, /문서에 추가/);
assert.match(chat, /visibleChat/);
assert.match(chat, /isChatTurnUiHidden/);

const store = read('ui/workspace/src/store/workspaceStore.ts');
assert.match(store, /appendToDocument/);
assert.match(store, /askAiFromDocumentSelection/);
assert.match(store, /lastDumpPath/);
assert.match(store, /DOCUMENT_MEMO_MARKER/);
assert.match(store, /document-memo/);
assert.match(store, /uiHidden/);
assert.doesNotMatch(store, /\bwindow\.confirm\s*\(/);

const memoLib = read('ui/workspace/src/lib/documentMemo.ts');
assert.match(memoLib, /isChatTurnUiHidden/);
assert.match(memoLib, /isDocumentMemoMessage/);
assert.match(memoLib, /DOCUMENT_MEMO_MARKER/);

const md = read('ui/workspace/src/components/MarkdownDocument.tsx');
assert.match(md, /DiffEditor/);
assert.match(md, /FolderBrowserModal/);
assert.match(md, /AI에게 묻기/);
assert.match(md, /document-ask-note/);
assert.match(md, /contextmenu:\s*false/);
assert.match(md, /createPortal/);
assert.match(md, /ai-memo-corner/);
assert.match(md, /uiSurface:\s*'document-memo'/);
assert.match(md, /접힌 메모/);
assert.doesNotMatch(md, /\bwindow\.confirm\s*\(/);
assert.doesNotMatch(md, />\s*Ask AI\s*</);

const asset = read('ui/workspace/src/components/AssetExplorer.tsx');
assert.doesNotMatch(asset, /open-canvas|캔버스에서 열기/);

const gi = read('core/src/sessions/workspace-scratch-gitignore.ts');
assert.match(gi, /removeDocumentSessionScratch/);
assert.match(gi, /document-scratch\.json/);

console.log('verify-document-markdown: PASS');
