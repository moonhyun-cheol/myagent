import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  EvidenceLineRange,
  EvidenceReadResult,
  EvidenceRecord,
  EvidenceSelector,
  EvidenceSource,
} from './agent-evidence-types.js';

const safePart = (value: string, fallback: string): string => {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96);
  return safe && safe !== '.' && safe !== '..' ? safe : fallback;
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function inferSource(tool: string, args: Record<string, unknown>): EvidenceSource {
  const pathArg = typeof args.path === 'string' ? args.path.replace(/\\/g, '/') : undefined;
  const kind: EvidenceSource['kind'] = tool === 'read_file'
    ? 'workspace_file'
    : tool.startsWith('browser_')
      ? 'browser'
      : tool === 'run_terminal' || tool === 'run_tests' || tool === 'run_diagnostics'
        ? 'terminal'
        : 'tool_output';
  return { kind, ...(pathArg ? { path: pathArg } : {}) };
}

function inferCoverage(output: string): EvidenceRecord['coverage'] | undefined {
  const match = output.match(/\[read_file meta\][^\n]*\blines=(\d+)-(\d+)\/(\d+)/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalLines = Number(match[3]);
  const returnedRanges: EvidenceLineRange[] = [{ start, end }];
  const omittedRanges: EvidenceLineRange[] = [];
  if (start > 1) omittedRanges.push({ start: 1, end: start - 1 });
  if (end < totalLines) omittedRanges.push({ start: end + 1, end: totalLines });
  return { lines: returnedRanges, returnedRanges, omittedRanges, totalLines };
}

function selectLines(content: string, ranges: EvidenceLineRange[]): string {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  for (const range of ranges) {
    const start = Math.max(1, Math.trunc(range.start));
    const end = Math.min(lines.length, Math.max(start, Math.trunc(range.end)));
    blocks.push(`[evidence lines ${start}-${end}/${lines.length}]\n${lines.slice(start - 1, end).join('\n')}`);
  }
  return blocks.join('\n\n');
}

export interface AgentEvidenceStoreOptions {
  cqrRoot: string;
  sessionId?: string;
  runId?: string;
  records?: EvidenceRecord[];
  onRecordsChanged?: (records: EvidenceRecord[]) => void;
}

/** Exact tool-result storage. Prompt projection may change, but these bodies are never truncated or deleted in-run. */
export class AgentEvidenceStore {
  readonly runId: string;
  private readonly cqrRoot: string;
  private readonly sessionId?: string;
  private readonly onRecordsChanged?: (records: EvidenceRecord[]) => void;
  private records = new Map<string, EvidenceRecord>();

  constructor(options: AgentEvidenceStoreOptions) {
    this.cqrRoot = path.resolve(options.cqrRoot);
    this.sessionId = options.sessionId;
    this.runId = safePart(options.runId ?? randomUUID(), 'run');
    this.onRecordsChanged = options.onRecordsChanged;
    for (const record of options.records ?? []) this.records.set(record.evidenceId, record);
  }

  private runDir(): string {
    return path.join(
      this.cqrRoot,
      'data',
      'evidence-runs',
      safePart(this.sessionId ?? 'anonymous', 'anonymous'),
      this.runId,
    );
  }

  list(): EvidenceRecord[] {
    return [...this.records.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  get(evidenceId: string): EvidenceRecord | undefined {
    return this.records.get(evidenceId);
  }

  record(input: {
    tool: string;
    args: Record<string, unknown>;
    output: string;
    ok: boolean;
    complete?: boolean;
  }): EvidenceRecord {
    const output = String(input.output ?? '');
    const evidenceId = `ev_${this.runId}_${this.list().filter((item) => item.runId === this.runId).length + 1}`;
    const dir = this.runDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${safePart(evidenceId, randomUUID())}.txt`;
    const absolute = path.join(dir, fileName);
    const temp = `${absolute}.${process.pid}.tmp`;
    writeFileSync(temp, output, 'utf8');
    renameSync(temp, absolute);
    const bodyFile = path.relative(this.cqrRoot, absolute).replace(/\\/g, '/');
    const coverage = inferCoverage(output);
    const record: EvidenceRecord = {
      version: 1,
      evidenceId,
      runId: this.runId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      tool: input.tool,
      args: input.args,
      source: inferSource(input.tool, input.args),
      ...(coverage ? { coverage } : {}),
      complete: input.complete ?? true,
      fingerprint: sha256(output),
      ok: input.ok,
      at: new Date().toISOString(),
      bytes: Buffer.byteLength(output, 'utf8'),
      bodyFile,
      observedByModel: false,
    };
    this.records.set(record.evidenceId, record);
    this.onRecordsChanged?.(this.list());
    return record;
  }

  read(selector: EvidenceSelector): EvidenceReadResult {
    const record = this.records.get(selector.evidenceId);
    if (!record) throw new Error(`Evidence not found: ${selector.evidenceId}`);
    const absolute = path.resolve(this.cqrRoot, record.bodyFile);
    const root = `${this.cqrRoot}${path.sep}`;
    if (absolute !== this.cqrRoot && !absolute.startsWith(root)) {
      throw new Error(`Evidence body escaped CQR root: ${selector.evidenceId}`);
    }
    if (!existsSync(absolute)) throw new Error(`Evidence body is unavailable: ${selector.evidenceId}`);
    const exact = readFileSync(absolute, 'utf8');
    const ranges = selector.lines?.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end));
    return {
      record,
      content: ranges?.length ? selectLines(exact, ranges) : exact,
      ...(ranges?.length ? { selectedLines: ranges } : {}),
    };
  }

  markObserved(evidenceIds: string[]): void {
    let changed = false;
    for (const id of evidenceIds) {
      const record = this.records.get(id);
      if (!record || record.observedByModel) continue;
      this.records.set(id, { ...record, observedByModel: true });
      changed = true;
    }
    if (changed) this.onRecordsChanged?.(this.list());
  }
}

export function formatEvidenceEnvelope(record: EvidenceRecord, content: string): string {
  return [
    `[evidence id=${record.evidenceId} complete=${record.complete} bytes=${record.bytes} sha256=${record.fingerprint}]`,
    content,
  ].join('\n');
}
