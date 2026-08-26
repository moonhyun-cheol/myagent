#!/usr/bin/env node
/**
 * Smoke: acceptance/structure review routing + seed adequacy (Phase 0).
 * Messages: no path / absolute path / 이어서 follow-up.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const build = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    path.join(root, 'tsconfig.json'),
    '--pretty',
    'false',
  ],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(build.status, 0, build.stderr || build.stdout || 'tsc failed');

const { looksLikeInspectFilesTask } = await import('../core/dist/router/route-task-gate.js');
const {
  looksLikeAcceptanceReviewTask,
  looksLikeAcceptanceReviewFollowUp,
} = await import('../core/dist/router/route-heuristics.js');
const {
  reviewReadsAreAdequate,
  contentIsReviewEvasion,
  dedupeRepeatedReviewBody,
} = await import('../core/dist/agent/agent-outcome-gate.js');
const { buildAcceptanceReviewSeed } = await import('../core/dist/agent/agent-review-seed.js');

const qNoPath = '이 프로젝트의 구조 검토, 리펙토링 필요성 확인';
const qWithPath = `${qNoPath}\n${path.join(root)}`;
const hist = [
  { role: 'user', content: qWithPath },
  { role: 'assistant', content: 'dir dump' },
];

assert.equal(looksLikeAcceptanceReviewTask(qNoPath), true);
assert.equal(looksLikeInspectFilesTask(qNoPath), false);

assert.equal(looksLikeAcceptanceReviewTask(qWithPath), true);
assert.equal(looksLikeInspectFilesTask(qWithPath), false, 'path+review must not be NAS inspect');

assert.equal(looksLikeAcceptanceReviewFollowUp('이어서', hist), true);

const seed = buildAcceptanceReviewSeed(root);
assert.ok(seed.seededPaths.length >= 4, `seed paths=${seed.seededPaths.join(',')}`);
assert.equal(reviewReadsAreAdequate(seed.seededPaths), true);
assert.ok(seed.promptBlock.includes('meta: lines='));

const greeting = '물론입니다! 어떤 도움을 드릴까요?\n요청을 꺼내놓으세요';
assert.equal(contentIsReviewEvasion(greeting), true);
const theater = '네, 다음과 같이 작업을 진행하겠습니다:\n### 요청 이해\nWindows 환경下的继续';
assert.equal(contentIsReviewEvasion(theater), true);

const dup = '## 결론\n부분\n### 다음 수정\nX\n## 결론\n부분\n### 다음 수정\nX';
assert.equal(dedupeRepeatedReviewBody(dup).split('## 결론').length - 1, 1);

console.log('verify-acceptance-review: ok');
