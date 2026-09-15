#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const markdownDocument = read('ui/workspace/src/components/MarkdownDocument.tsx');
const renderedEditor = read('ui/workspace/src/components/RenderedMarkdownEditor.tsx');
const supportPanel = read('ui/workspace/src/components/DocumentCollaborationPanel.tsx');

assert.match(renderedEditor, /data-testid="document-selection-toolbar"/);
assert.match(renderedEditor, /AI에게 수정 요청/);
assert.match(renderedEditor, /AI에게 묻기/);
assert.match(renderedEditor, /onRequestEdit\(selected\)/);

assert.match(markdownDocument, /DOCUMENT_EDIT_MARKER_PREFIX/);
assert.match(markdownDocument, /chat\[requestTurnIndex \+ 1\]/, 'proposal must bind to the adjacent assistant turn for the marked request');
assert.doesNotMatch(markdownDocument, /최근 응답을 변경안으로 검토/);
assert.match(markdownDocument, /documentContent !== documentEditRequest\.baseContent/);
assert.match(markdownDocument, /activeDocument\.revision \?\? null\) !== documentEditRequest\.baseRevision/);
assert.match(markdownDocument, /자동 적용을 차단했습니다/);
assert.match(markdownDocument, /data-testid="document-ai-collaboration-status"/);
assert.match(markdownDocument, /문서 전체 AI 수정 요청/);
assert.match(markdownDocument, /문서 공유·가져오기/);

assert.match(supportPanel, /if \(!session \|\| !visible\) return null/);
assert.match(supportPanel, /AI 공동편집과 별개의 문서 이식·주석 기능입니다/);
assert.match(supportPanel, /다른 채팅에서 공유된 문서/);
assert.match(supportPanel, /이전 문서 가져오기/);
assert.doesNotMatch(supportPanel, />협업</);
assert.doesNotMatch(supportPanel, /기존 협업문서/);

console.log('AI document collaboration contract: PASS');
