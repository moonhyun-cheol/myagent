#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const { buildTaskLedgerTopicManifest, getTaskLedgerDetail, searchTaskLedger, upsertTaskLedgerRecord } = await import('../core/dist/agent/task-ledger.js');
const { executeAgentTool } = await import('../core/dist/agent/agent-tool-execute.js');
const root = mkdtempSync(path.join(tmpdir(), 'my-agent-task-ledger-'));
try {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'task-ledger',
    'context-ledger.json',
  );
  upsertTaskLedgerRecord(root, JSON.parse(readFileSync(fixturePath, 'utf8')));
  upsertTaskLedgerRecord(root, {
    version: 1, taskId: 'T-file-open', sessionId: 'session-current',
    title: 'YAML 파일을 설정된 에디터로 열기', request: '파일 트리의 YAML 열기 버튼을 Notepad++에 연결한다.',
    summary: '추천 앱은 설정 시 절대 경로로 고정하고 파일 열기 때 재탐색하지 않는다.', status: 'completed',
    workspaceRoots: ['D:/workspace/MY Agent'], readPaths: ['ui/workspace/src/components/AssetExplorer.tsx'],
    mutatedPaths: ['ui/workspace/src/lib/applicationAssociations.ts'], symbols: ['openWorkspaceFileWithConfiguredApp'],
    keywords: ['yaml', 'notepad++', '연결 프로그램'], decisions: ['추천 앱 선택 시 실행 파일의 절대 경로를 저장한다.'],
    failures: ['notepad++.exe가 PATH에 없어 초기 실행이 실패했다.'], verification: ['UI TypeScript 및 프로덕션 빌드 통과'],
    startedAt: '2026-08-26T01:00:00.000Z', completedAt: '2026-08-26T01:30:00.000Z',
  });
  upsertTaskLedgerRecord(root, {
    version: 1, taskId: 'T-window-placement', sessionId: 'session-current', title: '보조 모니터 창 배치 복원',
    request: '종료 시 창 위치와 최대화 상태를 저장한다.', summary: 'WPF 셸에서 위치와 크기를 저장하고 다음 시작 전에 복원한다.',
    status: 'completed', workspaceRoots: ['D:/workspace/MY Agent'], readPaths: [],
    mutatedPaths: ['shell/CqrPa.Shell/MainWindow.xaml.cs'], symbols: ['WindowPlacementStore'], keywords: ['모니터', '창 위치', '최대화'],
    decisions: ['React가 아니라 네이티브 WPF 셸에서 처리한다.'], failures: [], verification: ['보조 모니터 작업 영역 좌표 확인'],
    startedAt: '2026-08-26T02:00:00.000Z', completedAt: '2026-08-26T02:30:00.000Z',
  });

  const cards = searchTaskLedger(root, { query: 'YAML Notepad++', limit: 3 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].taskId, 'T-file-open');
  assert.equal('decisions' in cards[0], false);
  const decisions = getTaskLedgerDetail(root, 'T-file-open', 'decisions');
  assert.deepEqual(decisions?.decisions, ['추천 앱 선택 시 실행 파일의 절대 경로를 저장한다.']);
  assert.equal('failures' in decisions, false);

  const searched = await executeAgentTool(root, { id: 's', type: 'function', function: {
    name: 'task_history_search', arguments: JSON.stringify({ query: '창 위치', limit: 2 }),
  } }, {}, { cqrRoot: root, sessionId: 'session-current' });
  assert.match(searched.output, /T-window-placement/);
  assert.doesNotMatch(searched.output, /네이티브 WPF 셸에서 처리한다/);
  const detailed = await executeAgentTool(root, { id: 'd', type: 'function', function: {
    name: 'task_history_detail', arguments: JSON.stringify({ task_id: 'T-window-placement', section: 'decisions' }),
  } }, undefined, { cqrRoot: root, sessionId: 'session-current' });
  assert.match(detailed.output, /네이티브 WPF 셸/);
  const manifest = buildTaskLedgerTopicManifest(root, {
    sessionId: 'session-current', workspaceRoot: 'D:/workspace/MY Agent', maxChars: 600,
  });
  assert.match(manifest, /Context set · task history cues/);
  assert.match(manifest, /current request\/runtime constraints \+ compact topic cues only/);
  assert.match(manifest, /task_history_search, then task_history_detail/);
  assert.match(manifest, /T-file-open/);
  assert.match(manifest, /YAML 파일을 설정된 에디터로 열기/);
  assert.match(manifest, /applicationAssociations\.ts/);
  assert.ok(manifest.length <= 600, 'topic manifest must honor its character budget');
  assert.doesNotMatch(manifest, /추천 앱 선택 시 실행 파일의 절대 경로를 저장한다/);
  assert.doesNotMatch(manifest, /PATH에 없어 초기 실행이 실패/);
  assert.doesNotMatch(manifest, /TypeScript 및 프로덕션 빌드 통과/);

  const fixtureCards = searchTaskLedger(root, {
    query: 'active context task history',
    sessionId: 'fixture-session',
    limit: 3,
  });
  assert.equal(fixtureCards[0]?.taskId, 'fixture-context-ledger');
  assert.equal('request' in fixtureCards[0], false);
  assert.equal('decisions' in fixtureCards[0], false);
  assert.ok(JSON.stringify(fixtureCards).length < 2_000, 'search results must stay compact');

  const fixtureSummary = getTaskLedgerDetail(root, 'fixture-context-ledger', 'summary');
  assert.match(fixtureSummary?.request ?? '', /active context compact/i);
  const fixtureExecution = getTaskLedgerDetail(root, 'fixture-context-ledger', 'execution');
  assert.ok(Array.isArray(fixtureExecution?.executionNotes));
  assert.ok(fixtureExecution.executionNotes.some((note) => note.includes('compact context manifest')));
  console.log('task ledger verify PASS: bounded topic cues -> compact search -> selected section detail');
} finally {
  rmSync(root, { recursive: true, force: true });
}
