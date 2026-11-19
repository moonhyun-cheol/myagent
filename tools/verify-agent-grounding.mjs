#!/usr/bin/env node
/** Smoke: grounding path helpers, product-memory scope, and index seed contracts. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectReadPathsFromMessages,
  normalizeAgentPath,
} from '../core/dist/agent/agent-grounding.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- path helpers ---
assert.equal(normalizeAgentPath('.\\core\\src\\a.ts'), 'core/src/a.ts');
assert.ok(
  collectReadPathsFromMessages([
    { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"./x/y.ts"}' } }] },
  ]).has('x/y.ts'),
);

// --- E product memory ---
import {
  formatExternalWorkspaceMemory,
  formatProductMemoryForPrompt,
  isMyAgentTreeRoot,
  isSelfWorkspace,
  loadAgentsMd,
  loadProductFacts,
  productFactsHasRoute,
  resolveScopedProductMemory,
  resolveSelfWorkspaceRoot,
  stripCqrSelfSkillSections,
} from '../core/dist/agent/agent-product-memory.js';
import {
  formatAuditSummaryBrief,
  summarizeAgentAuditLedger,
  appendAgentAuditEvent,
} from '../core/dist/agent/agent-audit-ledger.js';

const productFacts = loadProductFacts(root);
assert.ok(productFacts?.api?.route_count && productFacts.api.route_count > 10);
assert.equal(productFacts.layout?.primary_ui, 'ui/workspace');
assert.ok(
  productFactsHasRoute(productFacts, 'GET', '/health')
    || productFacts.api.routes.some((r) => r.path === '/health'),
);
const agentsMd = loadAgentsMd(root);
assert.ok(/ui\/workspace/.test(agentsMd));
assert.ok(formatProductMemoryForPrompt(productFacts, agentsMd).includes('api_roots'));
assert.equal(isSelfWorkspace(root, root), true);
assert.equal(isSelfWorkspace(path.join(root, 'ui', 'workspace'), root), true);
assert.equal(isSelfWorkspace('C:\\app\\vari6', root), false);
assert.equal(isMyAgentTreeRoot(root), true);
// A MY Agent source checkout opened as the workspace counts as self even when the running
// app root (cqrRoot) is a different folder.
{
  const appRoot = mkdtempSync(path.join(os.tmpdir(), 'my-agent-app-'));
  try {
    assert.equal(resolveSelfWorkspaceRoot(root, appRoot), root);
    assert.equal(resolveSelfWorkspaceRoot(path.join(root, 'ui', 'workspace'), appRoot), root);
    const devMem = resolveScopedProductMemory(appRoot, root);
    assert.equal(devMem.selfWorkspace, true);
    assert.ok(devMem.promptBlock.includes('api_roots'), 'self memory loads from the checkout');
    // A plain project folder (no MY Agent manifest) stays external.
    const ext = path.join(appRoot, 'external-project');
    mkdirSync(ext, { recursive: true });
    writeFileSync(path.join(ext, 'manifest.json'), '{"name":"Other"}\n', 'utf8');
    assert.equal(resolveSelfWorkspaceRoot(ext, path.join(os.tmpdir(), 'nope-app-root')), null);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}
const externalMem = resolveScopedProductMemory(root, 'C:\\app\\vari6');
assert.equal(externalMem.selfWorkspace, false);
assert.ok(externalMem.promptBlock.includes('external project'));
assert.ok(!externalMem.promptBlock.includes('api_roots'));
assert.ok(formatExternalWorkspaceMemory('').includes('ui-facts'));
assert.ok(
  !stripCqrSelfSkillSections(
    'before\n<!-- MY_AGENT_SELF_BEGIN -->\nui-facts.json\n<!-- MY_AGENT_SELF_END -->\nafter',
  ).includes('ui-facts.json'),
);

// --- G audit summary ---
appendAgentAuditEvent(root, {
  type: 'guard_block',
  sessionId: 'smoke',
  detail: 'ungrounded_file_state',
});
const sum = summarizeAgentAuditLedger(root, { maxLines: 200 });
assert.ok(sum.total >= 1);
assert.ok(formatAuditSummaryBrief(sum).includes('agent_audit'));

// --- A index + B multimodal ---
import {
  enrichWorkspaceIndexContext,
  indexQueryCandidatesFromMessage,
} from '../core/dist/agent/agent-workspace-index.js';
import {
  buildCodeAgentUserContent,
  formatMultimodalSystemNote,
} from '../core/dist/agent/agent-multimodal.js';

assert.ok(indexQueryCandidatesFromMessage('MainWindow.xaml 고쳐줘').some((q) => /MainWindow/i.test(q)));
// Unquoted Korean sentence words never become automatic queries; quoted phrases do.
assert.deepEqual(indexQueryCandidatesFromMessage('권장한 수정 모두 진행, 데드코드도 이어서 정리'), []);
assert.deepEqual(indexQueryCandidatesFromMessage('「이어서 진행」 문구 찾아줘'), ['이어서 진행']);
const parts = buildCodeAgentUserContent('스크린샷 봐줘', '### a.txt\nhello', [
  'data:image/png;base64,xx',
]);
assert.ok(Array.isArray(parts));
assert.ok(formatMultimodalSystemNote(true, true, false).includes('screenshot'));
const enriched = enrichWorkspaceIndexContext(root, '', 'ChatPane.tsx', { repoMapMaxChars: 2500 });
assert.ok(typeof enriched === 'string');

// Automatic embedding block: flat low-score lists are dropped; a distinct top hit survives.
{
  const { selectPromptEmbeddingHits } = await import('../core/dist/agent/index/agent-embedding-index.js');
  const h = (p, s) => ({ path: p, startLine: 1, endLine: 2, preview: '', score: s, engine: 'local-hashed-tf' });
  assert.deepEqual(selectPromptEmbeddingHits([h('a', 0.419), h('b', 0.377), h('c', 0.374)], 0.45), []);
  assert.equal(selectPromptEmbeddingHits([h('calc.ts', 0.354), h('noise.ts', 0.12)], 0.45).length, 1);
  assert.equal(selectPromptEmbeddingHits([h('x', 0.57), h('y', 0.5), h('z', 0.3)], 0.45).length, 2);
}

console.log('verify-agent-grounding: ok (grounding paths + product memory + index seeds)');
