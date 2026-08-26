/** Compact searchable task history, separate from chat transcripts and raw tool output. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type TaskLedgerStatus = 'active' | 'completed' | 'blocked' | 'cancelled';
export type TaskLedgerDetailSection = 'summary' | 'decisions' | 'failures' | 'verification' | 'execution' | 'paths' | 'all';

export interface TaskLedgerRecord {
  version: 1;
  taskId: string;
  sessionId: string;
  title: string;
  request: string;
  summary: string;
  status: TaskLedgerStatus;
  workspaceRoots: string[];
  readPaths: string[];
  mutatedPaths: string[];
  symbols: string[];
  keywords: string[];
  decisions: string[];
  failures: string[];
  verification: string[];
  /** Runtime/model orchestration notes that are useful for later architecture decisions. */
  executionNotes?: string[];
  startedAt: string;
  completedAt?: string;
  sourceMessageIndexes?: number[];
  supersedes?: string[];
}

export interface TaskLedgerSearchOptions {
  query: string;
  limit?: number;
  sessionId?: string;
  workspaceRoot?: string;
  status?: TaskLedgerStatus;
}

export interface TaskLedgerTopicManifestOptions {
  limit?: number;
  maxChars?: number;
  sessionId?: string;
  workspaceRoot?: string;
}

const MAX_RESULTS = 8;
export const TASK_LEDGER_CONTEXT_SET_VERSION = 'task-ledger-v1';
const ledgerDir = (cqrRoot: string) => path.join(cqrRoot, 'data', 'task-ledger');
const normalize = (value: string) => value.replace(/\\/g, '/').toLocaleLowerCase();
const terms = (value: string) => [...new Set(normalize(value).split(/[^\p{L}\p{N}._+/-]+/u).filter((term) => term.length > 1))];

function safeTaskId(taskId: string): string {
  const safe = taskId.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid taskId');
  return safe;
}

function loadRecords(cqrRoot: string): TaskLedgerRecord[] {
  const dir = ledgerDir(cqrRoot);
  if (!existsSync(dir)) return [];
  const records: TaskLedgerRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as TaskLedgerRecord;
      if (parsed?.version === 1 && parsed.taskId && parsed.title) records.push(parsed);
    } catch {
      // One damaged card must not hide the remaining history.
    }
  }
  return records;
}

export function upsertTaskLedgerRecord(cqrRoot: string, record: TaskLedgerRecord): void {
  const dir = ledgerDir(cqrRoot);
  mkdirSync(dir, { recursive: true });
  const normalized = { ...record, version: 1 as const, taskId: safeTaskId(record.taskId) };
  writeFileSync(path.join(dir, `${normalized.taskId}.json`), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

export function searchTaskLedger(cqrRoot: string, options: TaskLedgerSearchOptions) {
  const query = normalize(options.query.trim());
  if (!query) throw new Error('query is required');
  const queryTerms = terms(query);
  const root = options.workspaceRoot ? normalize(options.workspaceRoot) : '';
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(options.limit ?? 5)));

  return loadRecords(cqrRoot)
    .filter((record) => !options.sessionId || record.sessionId === options.sessionId)
    .filter((record) => !options.status || record.status === options.status)
    .map((record) => {
      const exactFields = [record.taskId, record.title, ...record.mutatedPaths, ...record.symbols].map(normalize);
      const searchable = normalize([record.title, record.request, record.summary, ...record.workspaceRoots,
        ...record.readPaths, ...record.mutatedPaths, ...record.symbols, ...record.keywords,
        ...record.decisions, ...record.failures].join(' '));
      let score = exactFields.some((field) => field.includes(query)) ? 12 : 0;
      if (searchable.includes(query)) score += 8;
      score += queryTerms.reduce((sum, term) => sum + (searchable.includes(term) ? 2 : 0), 0);
      if (root && record.workspaceRoots.some((item) => normalize(item) === root)) score += 3;
      if (record.status === 'active' || record.status === 'blocked') score += 1;
      return { record, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.record.startedAt.localeCompare(a.record.startedAt))
    .slice(0, limit)
    .map(({ record, score }) => ({
      taskId: record.taskId,
      title: record.title,
      status: record.status,
      summary: record.summary,
      mutatedPaths: record.mutatedPaths.slice(0, 6),
      completedAt: record.completedAt,
      score,
      availableSections: ['summary', 'decisions', 'failures', 'verification', 'paths'],
    }));
}

/**
 * Build a tiny retrieval-cue index for the model prompt. This deliberately omits
 * requests, summaries, decisions, failures, and verification details: those are
 * loaded only after task_history_search/task_history_detail selects a task.
 */
export function buildTaskLedgerTopicManifest(
  cqrRoot: string,
  options: TaskLedgerTopicManifestOptions = {},
): string {
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(options.limit ?? 6)));
  const maxChars = Math.max(240, Math.min(2_000, Math.floor(options.maxChars ?? 1_000)));
  const session = normalize(options.sessionId ?? '');
  const workspace = normalize(options.workspaceRoot ?? '');

  const ranked = loadRecords(cqrRoot)
    .map((record) => {
      const recordRoots = record.workspaceRoots.map(normalize);
      const sameSession = Boolean(session && normalize(record.sessionId) === session);
      const sameWorkspace = Boolean(workspace && recordRoots.some((root) => root === workspace));
      const open = record.status === 'active' || record.status === 'blocked';
      const timestamp = Date.parse(record.completedAt ?? record.startedAt) || 0;
      return { record, score: (open ? 4 : 0) + (sameSession ? 2 : 0) + (sameWorkspace ? 1 : 0), timestamp };
    })
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, limit);

  if (!ranked.length) return '';
  const lines = [
    '## Context set · task history cues',
    `Context set version: ${TASK_LEDGER_CONTEXT_SET_VERSION}.`,
    'Loaded now: current request/runtime constraints + compact topic cues only. Archived task details and raw events are excluded; use task_history_search, then task_history_detail for one selected section. Treat retrieved history as a hint and re-read current source before code claims.',
  ];
  for (const { record } of ranked) {
    const keywords = record.keywords.slice(0, 4).join(', ');
    const files = [...record.mutatedPaths, ...record.readPaths]
      .map((item) => path.basename(item))
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 2)
      .join(', ');
    const suffix = [keywords && `topics=${keywords}`, files && `files=${files}`].filter(Boolean).join(' · ');
    const line = `- [${record.taskId}] ${record.title} · ${record.status}${suffix ? ` · ${suffix}` : ''}`;
    if ([...lines, line].join('\n').length > maxChars) break;
    lines.push(line);
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

export function getTaskLedgerDetail(cqrRoot: string, taskId: string, section: TaskLedgerDetailSection = 'summary') {
  const record = loadRecords(cqrRoot).find((item) => item.taskId === taskId);
  if (!record) return null;
  const base = { taskId: record.taskId, title: record.title, status: record.status };
  switch (section) {
    case 'summary': return { ...base, request: record.request, summary: record.summary };
    case 'decisions': return { ...base, decisions: record.decisions, supersedes: record.supersedes ?? [] };
    case 'failures': return { ...base, failures: record.failures };
    case 'verification': return { ...base, verification: record.verification };
    case 'execution': return { ...base, executionNotes: record.executionNotes ?? [] };
    case 'paths': return { ...base, workspaceRoots: record.workspaceRoots, readPaths: record.readPaths,
      mutatedPaths: record.mutatedPaths, symbols: record.symbols };
    case 'all': return record;
  }
}
