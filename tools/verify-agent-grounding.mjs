#!/usr/bin/env node
/** Smoke: grounding, UI targeting, and product-memory contracts. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contentClaimsUngroundedFileState,
  expectedPathsForUiRequest,
  formatUiClarifyQuestion,
  mutationsCoverExpected,
  needsUiClarifyQuestion,
  pathsFromUiClarifyReply,
} from '../core/dist/agent/agent-grounding.js';
import {
  classifyUiTargetFromMessage,
  parseUiVisionTarget,
  visionTargetToBootstrapPath,
} from '../core/dist/agent/agent-ui-vision.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const factsPath = path.join(root, 'core', 'config', 'defaults', 'ui-facts.json');
assert.ok(existsSync(factsPath), 'ui-facts.json missing');
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
assert.equal(facts.shell.title, 'MY Agent');
assert.equal(facts.shell.custom_caption, true);

// --- 1 ungrounded ---
assert.ok(
  contentClaimsUngroundedFileState(
    '현재 MainWindow.xaml은 기본 Windows 타이틀바라 Title만 바꿀 수 있고 Background로 변경되지 않습니다. Title="MY Agent"',
  ),
);

// --- 2 facts / expected paths ---
const expected = expectedPathsForUiRequest('위에 바 색 바꿔줘 MY Agent', facts);
assert.ok(expected.some((p) => /MainWindow\.xaml/i.test(p)));

// --- 5 done path ---
assert.equal(
  mutationsCoverExpected(['ui/workspace/src/components/ChatPane.tsx'], expected).ok,
  false,
);
assert.equal(
  mutationsCoverExpected(['shell/CqrPa.Shell/MainWindow.xaml'], expected).ok,
  true,
);

// --- 3 vision parse ---
const parsed = parseUiVisionTarget(
  '{"target":"title_bar","reason":"window caption with MY Agent"}',
);
assert.ok(parsed);
assert.equal(parsed.target, 'title_bar');
assert.equal(
  visionTargetToBootstrapPath('title_bar', facts.targets),
  'shell/CqrPa.Shell/MainWindow.xaml',
);
assert.equal(classifyUiTargetFromMessage('위에 바를 변경해').target, 'title_bar');

// --- 4 clarify ---
assert.equal(needsUiClarifyQuestion('안내창 색상 통일해줘', 'unknown'), false);
assert.equal(needsUiClarifyQuestion('위에 바 색 맞춰', 'unknown'), false);
assert.equal(
  needsUiClarifyQuestion('색상 통일해줘', 'unknown', { hasScreenshot: true }),
  false,
);
assert.equal(
  needsUiClarifyQuestion('색상 통일해줘', 'unknown', { planApproved: true }),
  false,
);
assert.equal(needsUiClarifyQuestion('이 두 부분 색 맞춰줘', 'unknown'), true);
assert.ok(formatUiClarifyQuestion().includes('1)'));
assert.ok(pathsFromUiClarifyReply('1', facts).some((p) => /MainWindow/i.test(p)));
assert.ok(pathsFromUiClarifyReply('2 삭제 모달', facts).some((p) => /ConfirmModal/i.test(p)));

// --- E product memory ---
import {
  formatExternalWorkspaceMemory,
  formatProductMemoryForPrompt,
  isSelfWorkspace,
  loadAgentsMd,
  loadProductFacts,
  productFactsHasRoute,
  resolveScopedProductMemory,
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
const parts = buildCodeAgentUserContent('스크린샷 봐줘', '### a.txt\nhello', [
  'data:image/png;base64,xx',
]);
assert.ok(Array.isArray(parts));
assert.ok(formatMultimodalSystemNote(true, true, false).includes('screenshot'));
const enriched = enrichWorkspaceIndexContext(root, '', 'ChatPane.tsx', { repoMapMaxChars: 2500 });
assert.ok(typeof enriched === 'string');

console.log('verify-agent-grounding: ok (grounding + UI target + product memory)');
