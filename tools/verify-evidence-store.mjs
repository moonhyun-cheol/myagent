#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { AgentEvidenceStore, formatEvidenceEnvelope } = await import(
  '../core/dist/agent/agent-evidence-store.js'
);
const { recordSessionEvidenceRecords, loadAgentRunMeta } = await import(
  '../core/dist/agent/agent-run-meta.js'
);

const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-evidence-'));
try {
  const sessionId = 'verify-session';
  const store = new AgentEvidenceStore({
    cqrRoot: root,
    sessionId,
    runId: 'verify-run',
    onRecordsChanged: (records) => recordSessionEvidenceRecords(root, sessionId, records),
  });
  const exact = '[read_file meta] path=paper.txt lines=2-4/8 bytes=17 cache=miss stat=abc sha256=def\nbeta\ngamma\ndelta';
  const record = store.record({
    tool: 'read_file',
    args: { path: 'paper.txt', start_line: 2, end_line: 4 },
    output: exact,
    ok: true,
  });
  assert.equal(record.complete, true);
  assert.equal(record.observedByModel, false);
  assert.deepEqual(record.coverage.returnedRanges, [{ start: 2, end: 4 }]);
  assert.deepEqual(record.coverage.omittedRanges, [{ start: 1, end: 1 }, { start: 5, end: 8 }]);
  assert.equal(store.read({ evidenceId: record.evidenceId }).content, exact);
  assert.match(store.read({ evidenceId: record.evidenceId, lines: [{ start: 2, end: 3 }] }).content, /beta[\s\S]*gamma/);
  assert.match(formatEvidenceEnvelope(record, exact), new RegExp(record.evidenceId));

  const meta = loadAgentRunMeta(root, sessionId);
  assert.equal(meta.evidenceRecords.length, 1);
  assert.equal(meta.evidenceRecords[0].bodyFile.includes('data/evidence-runs/'), true);
  assert.equal(Object.hasOwn(meta.evidenceRecords[0], 'content'), false, 'session meta must not duplicate body');
  const body = readFileSync(path.join(root, meta.evidenceRecords[0].bodyFile), 'utf8');
  assert.equal(body, exact);

  store.markObserved([record.evidenceId]);
  assert.equal(store.get(record.evidenceId).observedByModel, true);
  console.log('verify-evidence-store: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
