#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  buildTaskLedgerTopicManifest,
  getTaskLedgerDetail,
  searchTaskLedger,
} from '../core/dist/agent/task-ledger.js';

const root = process.cwd();
const ledgerDir = path.join(root, 'data', 'task-ledger');
const requestedSessionId = process.argv[2]?.trim();
const query = process.argv[3]?.trim() || '컨텍스트 작업 이력 토큰';
const requestedTaskId = process.argv[4]?.trim();

const records = readdirSync(ledgerDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(path.join(ledgerDir, name), 'utf8')));

if (records.length === 0) throw new Error('Task Ledger records not found');

const sessionCounts = new Map();
for (const record of records) {
  sessionCounts.set(record.sessionId, (sessionCounts.get(record.sessionId) ?? 0) + 1);
}
const sessionId = requestedSessionId || [...sessionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
const sessionRecords = records.filter((record) => record.sessionId === sessionId);
if (sessionRecords.length === 0) throw new Error(`No Task Ledger records for session ${sessionId}`);

const sessionPath = path.join(root, 'data', 'sessions', `${sessionId}.json`);
const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
const transcript = (session.messages ?? [])
  .map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
  .join('\n');
const fullLedger = JSON.stringify(sessionRecords);
const manifest = buildTaskLedgerTopicManifest(root, {
  sessionId,
  workspaceRoot: sessionRecords[0]?.workspaceRoots?.[0],
  limit: 8,
  maxChars: 2_000,
});
const search = searchTaskLedger(root, { query, sessionId, limit: 5 });
const searchResults = Array.isArray(search) ? search : search?.results ?? [];
const taskId = requestedTaskId || searchResults[0]?.taskId || sessionRecords[0].taskId;
const detail = getTaskLedgerDetail(root, taskId, 'summary');

const text = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const measure = (value) => {
  const body = text(value);
  return {
    chars: [...body].length,
    utf8Bytes: Buffer.byteLength(body, 'utf8'),
    // Tokenizer-independent comparison proxy. Exact billing tokens depend on the selected model.
    tokenProxy: Math.ceil(Buffer.byteLength(body, 'utf8') / 4),
  };
};
const combine = (...values) => values.map(text).join('\n');
const baseline = measure(transcript);
const fullLedgerMeasure = measure(fullLedger);
const normalTurn = measure(manifest);
const lookupTurn = measure(combine(manifest, search, detail));
const reduction = (candidate, source) => Number((100 * (1 - candidate.tokenProxy / source.tokenProxy)).toFixed(1));

console.log(JSON.stringify({
  sessionId,
  recordCount: sessionRecords.length,
  query,
  selectedTaskId: taskId,
  note: 'tokenProxy는 UTF-8 4바이트당 1토큰인 비교용 근사치이며 실제 모델 청구 토큰과 다를 수 있습니다.',
  measurements: {
    transcriptBaseline: baseline,
    fullLedger: fullLedgerMeasure,
    topicManifestOnly: normalTurn,
    manifestSearchAndOneSummary: lookupTurn,
  },
  reductionVsTranscript: {
    normalTurnPercent: reduction(normalTurn, baseline),
    lookupTurnPercent: reduction(lookupTurn, baseline),
  },
  reductionVsFullLedger: {
    normalTurnPercent: reduction(normalTurn, fullLedgerMeasure),
    lookupTurnPercent: reduction(lookupTurn, fullLedgerMeasure),
  },
}, null, 2));
