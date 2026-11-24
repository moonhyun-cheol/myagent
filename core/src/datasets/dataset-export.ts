/**
 * Operator PC fixed export. Not a model tool: only the Settings button and the in-app timer
 * start it.
 *
 * The deployed dataset definition pins the sha256 of the only command allowed for it. The
 * operator pastes that command once; before every run its hash is compared with the deployed
 * one again, so an edited registration or a changed definition stops before anything is sent.
 * The command runs over the existing SSH service (pinned or trusted fingerprint, remembered
 * DPAPI password). Its output is parsed, personal-information columns are dropped, and the
 * snapshot is written atomically into the team shared folder that everyone else reads.
 *
 * No database password is stored: commands that carry one inline are refused, so the
 * database login stays in the operator's own account on the server.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import { findSshServer, loadSshServers } from '../ssh/ssh-profile-store.js';
import { execSshCommand, redactSshOutput, SshError } from '../ssh/ssh-service.js';
import {
  DatasetError,
  findDatasetDefinition,
  listDatasetDefinitions,
  loadDataConnectionSettings,
  type DatasetDefinition,
} from './dataset-catalog.js';
import {
  DATASET_SNAPSHOT_SCHEMA,
  DATASET_STATUS_LABEL,
  datasetSnapshotFile,
  formatDatasetAsOf,
  loadDatasetStatus,
  visibleColumnIndexes,
  type DatasetReadOptions,
  type DatasetStatus,
} from './dataset-source.js';

export const DATASET_EXPORTS_REL_PATH = 'data/config/dataset-exports.json';
const EXPORT_TIMEOUT_MS = 300_000;
export const DATASET_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const EXPORT_MAX_ROWS = 500_000;
const EXPORT_MAX_COLUMNS = 200;
const MAX_COMMAND_CHARS = 8_000;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const TIMER_INTERVAL_MS = 15 * 60_000;
const TIMER_FIRST_DELAY_MS = 2 * 60_000;

export interface DatasetExportRun {
  at: string;
  ok: boolean;
  rows?: number;
  code?: string;
  message: string;
}

export interface DatasetExportRegistration {
  datasetId: string;
  serverId: string;
  /** The fixed command. Its sha256 must equal the deployed one before every run. */
  command: string;
  registeredAt: string;
  lastRun?: DatasetExportRun;
  lastSuccessAt?: string;
}

interface ExportsDoc {
  version: 1;
  exports: Record<string, DatasetExportRegistration>;
}

export interface DatasetSnapshotDoc {
  schema: typeof DATASET_SNAPSHOT_SCHEMA;
  dataset_id: string;
  as_of: string;
  columns: string[];
  rows: string[][];
  row_count: number;
}

export function datasetExportsPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'config', 'dataset-exports.json');
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function loadExportsDoc(cqrRoot: string): ExportsDoc {
  const doc: ExportsDoc = { version: 1, exports: {} };
  try {
    const file = datasetExportsPath(cqrRoot);
    if (!existsSync(file)) return doc;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { exports?: unknown };
    if (!raw?.exports || typeof raw.exports !== 'object') return doc;
    for (const [id, value] of Object.entries(raw.exports as Record<string, unknown>)) {
      const row = value as Partial<DatasetExportRegistration> | null;
      if (!row || typeof row.command !== 'string' || typeof row.serverId !== 'string') continue;
      const lastRun = row.lastRun && typeof row.lastRun === 'object' && typeof row.lastRun.at === 'string'
        ? {
          at: row.lastRun.at,
          ok: row.lastRun.ok === true,
          message: str(row.lastRun.message, 400),
          ...(typeof row.lastRun.rows === 'number' ? { rows: row.lastRun.rows } : {}),
          ...(typeof row.lastRun.code === 'string' ? { code: row.lastRun.code } : {}),
        }
        : undefined;
      doc.exports[id] = {
        datasetId: id,
        serverId: row.serverId,
        command: row.command,
        registeredAt: typeof row.registeredAt === 'string' ? row.registeredAt : '',
        ...(lastRun ? { lastRun } : {}),
        ...(typeof row.lastSuccessAt === 'string' ? { lastSuccessAt: row.lastSuccessAt } : {}),
      };
    }
  } catch {
    /* unreadable file: nothing registered */
  }
  return doc;
}

function writeExportsDoc(cqrRoot: string, doc: ExportsDoc): void {
  const file = datasetExportsPath(cqrRoot);
  assertWritablePath(file, cqrRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  assertWritablePath(tmp, cqrRoot);
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function normalizeExportCommand(command: unknown): string {
  return String(command ?? '').replace(/\r\n?/g, '\n').trim();
}

/** sha256 (hex) of the normalized command — the value a dataset definition pins. */
export function datasetCommandSha256(command: unknown): string {
  return createHash('sha256').update(normalizeExportCommand(command), 'utf8').digest('hex');
}

/** A reason when the command carries a password inline, else null. */
export function findInlineSecret(command: string): string | null {
  const inline = /--password(?:=|\s+)\S/i.test(command)
    || /\b(?:PGPASSWORD|MYSQL_PWD|SSHPASS)\s*=/i.test(command)
    || /\bsshpass\b/i.test(command)
    || /\b(?:mysql|mariadb|mysqldump)\b[^\n]*\s-p\S/.test(command)
    || /(?:^|[\s;'"(])(?:password|pwd)\s*=\s*[^\s'";)]+/i.test(command);
  return inline
    ? '명령에 비밀번호를 넣을 수 없습니다. DB 접속 정보는 서버의 본인 계정 설정 파일에 두고, 배포된 명령을 그대로 쓰세요.'
    : null;
}

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Tab separated as `mysql -B` prints it: `\t`, `\n`, `\\` escaped and NULL as a word. */
function parseTsv(text: string): string[][] {
  const unescape = (value: string) => (value === 'NULL'
    ? ''
    : value.replace(/\\([\\tn0])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '' : '\\')));
  return text.split(/\r?\n/).map((line) => line.split('\t').map(unescape));
}

export function parseExportOutput(text: string, format: 'csv' | 'tsv'): { columns: string[]; rows: string[][] } {
  const body = text.replace(/^\uFEFF/, '');
  const records = (format === 'csv' ? parseCsv(body) : parseTsv(body)).filter((record) => record.some((cell) => cell !== ''));
  const [header, ...rows] = records;
  if (!header || !header.some((cell) => cell.trim())) {
    throw new DatasetError('EXPORT_OUTPUT_EMPTY', '명령 출력 첫 줄에 열 이름이 없습니다.');
  }
  if (header.length > EXPORT_MAX_COLUMNS) throw new DatasetError('EXPORT_TOO_LARGE', `열이 ${EXPORT_MAX_COLUMNS}개를 넘습니다.`);
  if (rows.length > EXPORT_MAX_ROWS) throw new DatasetError('EXPORT_TOO_LARGE', `행이 ${EXPORT_MAX_ROWS}개를 넘습니다.`);
  const columns = header.map((cell, i) => cell.trim() || `column_${i + 1}`);
  return { columns, rows: rows.map((row) => columns.map((_, i) => row[i] ?? '')) };
}

/** Keeps only the allowed columns and drops personal-information columns. */
export function buildDatasetSnapshot(
  def: DatasetDefinition,
  table: { columns: string[]; rows: string[][] },
  asOf: string,
): DatasetSnapshotDoc {
  const indexes = visibleColumnIndexes(def, table.columns);
  if (!indexes.length) {
    throw new DatasetError('EXPORT_NO_COLUMNS', '저장할 열이 없습니다. 허용 열과 개인정보 제외 열 설정을 확인하세요.');
  }
  return {
    schema: DATASET_SNAPSHOT_SCHEMA,
    dataset_id: def.id,
    as_of: asOf,
    columns: indexes.map((i) => table.columns[i]!),
    rows: table.rows.map((row) => indexes.map((i) => row[i] ?? '')),
    row_count: table.rows.length,
  };
}

/**
 * Temp file + rename in the same folder, so readers see the old or the new snapshot, never a
 * half-written one. This is the one intended write into the team shared folder; the folder
 * comes from the signed definition and the file name from the validated dataset id.
 */
function writeSnapshotAtomically(file: string, snapshot: DatasetSnapshotDoc): void {
  const folder = path.dirname(file);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new DatasetError('EXPORT_FOLDER_MISSING', '공유 폴더를 찾을 수 없습니다.');
  }
  const tmp = path.join(folder, `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

const SSH_FAILURE_MESSAGE: Record<string, string> = {
  SSH_KEY_LOCKED: '서버가 잠겨 있습니다. 설정 → SSH 서버에서 연결 준비를 하세요. 자동 갱신에는 「이 PC에 기억」이 필요합니다.',
  SSH_HOST_NOT_TRUSTED: '서버 확인이 끝나지 않았습니다. 설정 → SSH 서버에서 연결 준비를 하세요.',
  SSH_HOST_KEY_CHANGED: '서버 지문이 확인한 값과 달라 연결하지 않았습니다. 운영 담당자에게 알리세요.',
  SSH_ACCOUNT_REQUIRED: '서버 계정이 없습니다. 설정 → SSH 서버에서 계정을 입력하세요.',
  SSH_AUTH_FAILED: '서버가 계정 또는 비밀번호를 거부했습니다.',
  SSH_SERVER_BUSY: '같은 서버에서 다른 명령이 실행 중입니다. 잠시 뒤 다시 시도합니다.',
  SSH_SERVER_NOT_FOUND: '등록된 서버를 찾을 수 없습니다.',
  SSH_CONNECT_FAILED: '서버에 연결하지 못했습니다.',
};

function exportFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SshError) return { code: error.code, message: SSH_FAILURE_MESSAGE[error.code] ?? error.message };
  if (error instanceof DatasetError) return { code: error.code, message: error.message };
  const code = String((error as NodeJS.ErrnoException | null)?.code ?? '');
  if (code === 'EACCES' || code === 'EPERM') return { code: 'EXPORT_FOLDER_NO_ACCESS', message: '공유 폴더에 쓸 권한이 없습니다.' };
  if (code === 'ENOENT') return { code: 'EXPORT_FOLDER_MISSING', message: '공유 폴더를 찾을 수 없습니다.' };
  return { code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/** Register (or replace) this PC's export for a dataset after the hash check. */
export function registerDatasetExport(
  cqrRoot: string,
  input: { datasetId?: unknown; serverId?: unknown; command?: unknown },
): DatasetExportRegistration {
  const def = findDatasetDefinition(cqrRoot, input.datasetId);
  if (!def) throw new DatasetError('DATASET_NOT_FOUND', '배포된 데이터셋을 찾을 수 없습니다.');
  if (!def.export) throw new DatasetError('EXPORT_NOT_DEFINED', '이 데이터셋에는 배포된 내보내기 정의가 없습니다.');
  if (!datasetSnapshotFile(def)) {
    throw new DatasetError('EXPORT_SOURCE_UNSUPPORTED', `출처 종류 '${def.source.kind}'는 내보내기를 지원하지 않습니다.`);
  }
  const command = normalizeExportCommand(input.command);
  if (!command || command.includes('\0') || command.length > MAX_COMMAND_CHARS) {
    throw new DatasetError('EXPORT_COMMAND_INVALID', '받은 내보내기 명령을 붙여 넣으세요.');
  }
  const secret = findInlineSecret(command);
  if (secret) throw new DatasetError('EXPORT_INLINE_SECRET', secret);
  if (datasetCommandSha256(command) !== def.export.commandSha256) {
    throw new DatasetError('EXPORT_HASH_MISMATCH', '배포된 내보내기 명령과 다릅니다. 받은 명령을 한 글자도 바꾸지 말고 붙여 넣으세요.');
  }
  const serverId = str(input.serverId, 40) || def.export.serverId || '';
  if (def.export.serverId && serverId !== def.export.serverId) {
    throw new DatasetError('EXPORT_SERVER_MISMATCH', '이 내보내기는 배포에 지정된 서버에서만 실행할 수 있습니다.');
  }
  if (!serverId || !findSshServer(cqrRoot, serverId)) {
    throw new DatasetError('EXPORT_SERVER_NOT_FOUND', '내보내기를 실행할 SSH 서버를 고르세요.');
  }
  const doc = loadExportsDoc(cqrRoot);
  const before = doc.exports[def.id];
  const registration: DatasetExportRegistration = before && before.command === command && before.serverId === serverId
    ? before
    : { datasetId: def.id, serverId, command, registeredAt: new Date().toISOString() };
  doc.exports[def.id] = registration;
  writeExportsDoc(cqrRoot, doc);
  return registration;
}

export function removeDatasetExport(cqrRoot: string, datasetId: unknown): void {
  const id = str(datasetId, 40).toLowerCase();
  const doc = loadExportsDoc(cqrRoot);
  if (!doc.exports[id]) return;
  delete doc.exports[id];
  writeExportsDoc(cqrRoot, doc);
}

const running = new Set<string>();

/** Run the registered export once. Failures are recorded and returned, not thrown. */
export async function runDatasetExport(
  cqrRoot: string,
  datasetId: unknown,
  opts: { signal?: AbortSignal; now?: () => Date } = {},
): Promise<DatasetExportRun> {
  const id = str(datasetId, 40).toLowerCase();
  const registration = loadExportsDoc(cqrRoot).exports[id];
  if (!registration) throw new DatasetError('EXPORT_NOT_REGISTERED', '이 PC에 등록된 내보내기가 없습니다.');
  if (running.has(id)) throw new DatasetError('EXPORT_BUSY', '이미 갱신 중입니다.');
  running.add(id);
  const now = opts.now ?? (() => new Date());
  let run: DatasetExportRun;
  try {
    const def = findDatasetDefinition(cqrRoot, id);
    if (!def) throw new DatasetError('DATASET_NOT_FOUND', '배포된 데이터셋 정의가 없습니다.');
    const spec = def.export;
    if (!spec) throw new DatasetError('EXPORT_NOT_DEFINED', '이 데이터셋에는 배포된 내보내기 정의가 없습니다.');
    // Checked again before anything leaves this PC: an edited file or a new definition stops here.
    const secret = findInlineSecret(registration.command);
    if (secret) throw new DatasetError('EXPORT_INLINE_SECRET', secret);
    if (datasetCommandSha256(registration.command) !== spec.commandSha256) {
      throw new DatasetError('EXPORT_HASH_MISMATCH', '등록된 명령이 배포된 내보내기 명령과 달라 실행하지 않았습니다. 받은 명령으로 다시 등록하세요.');
    }
    if (spec.serverId && registration.serverId !== spec.serverId) {
      throw new DatasetError('EXPORT_SERVER_MISMATCH', '배포에 지정된 서버가 아니어서 실행하지 않았습니다.');
    }
    const file = datasetSnapshotFile(def);
    if (!file) throw new DatasetError('EXPORT_SOURCE_UNSUPPORTED', `출처 종류 '${def.source.kind}'는 내보내기를 지원하지 않습니다.`);
    const result = await execSshCommand(cqrRoot, {
      serverId: registration.serverId,
      command: registration.command,
      timeoutMs: EXPORT_TIMEOUT_MS,
      captureLimitBytes: DATASET_EXPORT_MAX_BYTES,
      signal: opts.signal,
    });
    if (result.state !== 'ok') {
      throw new DatasetError('EXPORT_COMMAND_FAILED', result.state === 'timeout'
        ? '명령이 제한 시간 안에 끝나지 않았습니다.'
        : result.state === 'cancelled' ? '갱신이 취소됐습니다.' : '서버 연결이 끊겼습니다.');
    }
    if (result.exitCode !== 0) {
      const detail = redactSshOutput(result.stderr).trim().slice(0, 300);
      throw new DatasetError('EXPORT_COMMAND_FAILED', `명령이 실패했습니다 (종료 코드 ${String(result.exitCode)}).${detail ? ` ${detail}` : ''}`);
    }
    if (result.truncated) {
      throw new DatasetError('EXPORT_TOO_LARGE', `출력이 ${DATASET_EXPORT_MAX_BYTES / 1024 / 1024}MB를 넘어 저장하지 않았습니다.`);
    }
    const asOf = now().toISOString();
    const snapshot = buildDatasetSnapshot(def, parseExportOutput(result.stdout, spec.format), asOf);
    writeSnapshotAtomically(file, snapshot);
    run = { at: asOf, ok: true, rows: snapshot.row_count, message: `${snapshot.row_count}행을 공유 폴더에 저장했습니다.` };
  } catch (error) {
    const failure = exportFailure(error);
    run = { at: now().toISOString(), ok: false, code: failure.code, message: failure.message };
  } finally {
    running.delete(id);
  }
  // Record only on the registration that ran; it may have been replaced meanwhile.
  const latest = loadExportsDoc(cqrRoot);
  const current = latest.exports[id];
  if (current && current.command === registration.command && current.serverId === registration.serverId) {
    current.lastRun = run;
    if (run.ok) current.lastSuccessAt = run.at;
    writeExportsDoc(cqrRoot, latest);
  }
  return run;
}

/** Exports whose interval has passed (twice a day by default). Failed ones wait 30 minutes. */
export async function runDueDatasetExports(cqrRoot: string, now = Date.now()): Promise<string[]> {
  const ran: string[] = [];
  for (const registration of Object.values(loadExportsDoc(cqrRoot).exports)) {
    const spec = findDatasetDefinition(cqrRoot, registration.datasetId)?.export;
    if (!spec || running.has(registration.datasetId)) continue;
    const lastSuccess = Date.parse(registration.lastSuccessAt ?? '') || 0;
    if (now - lastSuccess < spec.intervalHours * 3_600_000) continue;
    const lastTry = Date.parse(registration.lastRun?.at ?? '') || 0;
    if (registration.lastRun && !registration.lastRun.ok && now - lastTry < RETRY_AFTER_FAILURE_MS) continue;
    try {
      await runDatasetExport(cqrRoot, registration.datasetId);
      ran.push(registration.datasetId);
    } catch {
      /* busy or removed meanwhile */
    }
  }
  return ran;
}

let exportTimer: NodeJS.Timeout | null = null;
let firstTick: NodeJS.Timeout | null = null;

/** While the app runs: check every 15 minutes. PCs without a registration do nothing. */
export function startDatasetExportTimer(cqrRoot: string): void {
  if (exportTimer) return;
  const tick = () => { void runDueDatasetExports(cqrRoot).catch(() => undefined); };
  exportTimer = setInterval(tick, TIMER_INTERVAL_MS);
  exportTimer.unref?.();
  firstTick = setTimeout(tick, TIMER_FIRST_DELAY_MS);
  firstTick.unref?.();
}

export function stopDatasetExportTimer(): void {
  if (exportTimer) clearInterval(exportTimer);
  if (firstTick) clearTimeout(firstTick);
  exportTimer = null;
  firstTick = null;
}

export interface DataConnectionView {
  id: string;
  label: string;
  description?: string;
  featureLabel?: string;
  sourceKind: string;
  status: DatasetStatus;
  statusLabel: string;
  message: string;
  asOf?: string;
  asOfDisplay?: string;
  rowCount?: number;
  staleAfterHours: number;
  export?: {
    intervalHours: number;
    serverId?: string;
    registration?: {
      serverId: string;
      registeredAt: string;
      commandMatches: boolean;
      lastRun?: DatasetExportRun;
      lastSuccessAt?: string;
    };
  };
}

/** Settings view: status and as-of time per dataset. Never a row, never the command text. */
export async function listDataConnectionViews(cqrRoot: string, opts: DatasetReadOptions = {}): Promise<DataConnectionView[]> {
  const exports = loadExportsDoc(cqrRoot).exports;
  return Promise.all(listDatasetDefinitions(cqrRoot).map(async (def): Promise<DataConnectionView> => {
    const status = await loadDatasetStatus(def, opts);
    const registration = exports[def.id];
    return {
      id: def.id,
      label: def.label,
      ...(def.description ? { description: def.description } : {}),
      ...(def.featureLabel ? { featureLabel: def.featureLabel } : {}),
      sourceKind: def.source.kind,
      status: status.status,
      statusLabel: DATASET_STATUS_LABEL[status.status],
      message: status.message,
      ...(status.asOf ? { asOf: status.asOf, asOfDisplay: formatDatasetAsOf(status.asOf) } : {}),
      ...(status.rowCount !== undefined ? { rowCount: status.rowCount } : {}),
      staleAfterHours: def.staleAfterHours,
      ...(def.export
        ? {
          export: {
            intervalHours: def.export.intervalHours,
            ...(def.export.serverId ? { serverId: def.export.serverId } : {}),
            ...(registration
              ? {
                registration: {
                  serverId: registration.serverId,
                  registeredAt: registration.registeredAt,
                  commandMatches: datasetCommandSha256(registration.command) === def.export.commandSha256,
                  ...(registration.lastRun ? { lastRun: registration.lastRun } : {}),
                  ...(registration.lastSuccessAt ? { lastSuccessAt: registration.lastSuccessAt } : {}),
                },
              }
              : {}),
          },
        }
        : {}),
    };
  }));
}

/**
 * `GET /datasets`. `sshServerCount` counts this PC's own SSH servers only: managed
 * connections reach every PC with the feature and must not reveal the operator screens.
 */
export async function dataConnectionOverview(cqrRoot: string): Promise<{
  operatorMode: boolean;
  sshServerCount: number;
  datasets: DataConnectionView[];
}> {
  return {
    operatorMode: loadDataConnectionSettings(cqrRoot).operatorMode,
    sshServerCount: loadSshServers(cqrRoot).servers.length,
    datasets: await listDataConnectionViews(cqrRoot),
  };
}
