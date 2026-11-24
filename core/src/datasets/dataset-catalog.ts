/**
 * Team datasets deployed by signed Organization Features (`datasets.json`, never a secret).
 *
 * Every dataset names its source kind. v1 reads a snapshot from a team shared folder that an
 * operator PC refreshes with a fixed, hash-pinned export. Later kinds (a query over a managed
 * connection once each employee has an account, a cloud store) only add a reader for their
 * kind; definitions of an unknown kind are listed as `unsupported` and never read.
 *
 * `data/config/data-connection.json` keeps one local choice: whether this PC shows the
 * operator screens (SSH servers, export registration).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readEnabledFeatureEntrypointDocuments } from '../features/organization-feature-manager.js';
import { assertWritablePath } from '../security/path-guard.js';

/** Source kinds this build can read. */
export const SUPPORTED_DATASET_SOURCE_KINDS = ['shared_folder'] as const;
export type DatasetSourceKind = (typeof SUPPORTED_DATASET_SOURCE_KINDS)[number];

export interface DatasetSource {
  /** `shared_folder` in v1; any other value is kept so the UI can say it is not supported yet. */
  kind: string;
  /** shared_folder: absolute folder (UNC or drive path) holding `<id>.snapshot.json`. */
  folder?: string;
}

export interface DatasetExportSpec {
  /** sha256 (hex) of the only command the operator PC may run for this dataset. */
  commandSha256: string;
  format: 'csv' | 'tsv';
  intervalHours: number;
  /** When set, the export must run on this server id (usually a managed connection). */
  serverId?: string;
}

export interface DatasetDefinition {
  id: string;
  label: string;
  description?: string;
  featureId: string;
  featureLabel?: string;
  source: DatasetSource;
  /** Allowlist of columns, in order. Missing means every column the export returns. */
  columns?: string[];
  /** Personal-information columns: removed on export and hidden again on every read. */
  excludeColumns: string[];
  staleAfterHours: number;
  export?: DatasetExportSpec;
}

export class DatasetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DATASET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MAX_DATASETS = 50;
const MAX_COLUMNS = 200;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function columnList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, MAX_COLUMNS)) {
    const name = text(item, 80);
    if (name && !out.some((existing) => existing.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Absolute folder: `\\server\share\...`, `X:\...`, or `/...` off Windows. */
export function isAbsoluteDatasetFolder(folder: string): boolean {
  if (/[\0\r\n]/.test(folder)) return false;
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(folder)) return true;
  if (/^[A-Za-z]:[\\/]/.test(folder)) return true;
  return process.platform !== 'win32' && folder.startsWith('/');
}

function cleanDataset(raw: unknown, featureId: string, featureLabel?: string): DatasetDefinition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = text(row.id, 40).toLowerCase();
  if (!DATASET_ID_RE.test(id)) return null;
  const sourceRaw = row.source && typeof row.source === 'object' ? (row.source as Record<string, unknown>) : null;
  const kind = text(sourceRaw?.kind, 40);
  if (!kind) return null;
  const source: DatasetSource = { kind };
  if (kind === 'shared_folder') {
    const folder = text(sourceRaw?.folder, 1024);
    if (!folder || !isAbsoluteDatasetFolder(folder)) return null;
    source.folder = folder;
  }
  let exportSpec: DatasetExportSpec | undefined;
  const exportRaw = row.export && typeof row.export === 'object' ? (row.export as Record<string, unknown>) : null;
  if (exportRaw) {
    const hash = text(exportRaw.command_sha256, 64).toLowerCase();
    if (SHA256_HEX_RE.test(hash)) {
      const serverId = text(exportRaw.server_id, 40);
      exportSpec = {
        commandSha256: hash,
        format: exportRaw.format === 'csv' ? 'csv' : 'tsv',
        intervalHours: clampNumber(exportRaw.interval_hours, 12, 1, 168),
        ...(serverId ? { serverId } : {}),
      };
    }
  }
  const columns = columnList(row.columns);
  const description = text(row.description, 300);
  return {
    id,
    label: text(row.label, 80) || id,
    ...(description ? { description } : {}),
    featureId,
    ...(featureLabel ? { featureLabel } : {}),
    source,
    ...(columns.length ? { columns } : {}),
    excludeColumns: columnList(row.exclude_columns),
    staleAfterHours: clampNumber(row.stale_after_hours, exportSpec ? exportSpec.intervalHours * 2 + 2 : 26, 1, 24 * 31),
    ...(exportSpec ? { export: exportSpec } : {}),
  };
}

/** Definitions from every enabled feature; the first feature wins on a duplicate id. */
export function listDatasetDefinitions(cqrRoot: string): DatasetDefinition[] {
  const out: DatasetDefinition[] = [];
  for (const { featureId, featureLabel, document } of readEnabledFeatureEntrypointDocuments(cqrRoot, 'datasets')) {
    const rows = (document as { datasets?: unknown } | null)?.datasets;
    if (!Array.isArray(rows)) continue;
    for (const row of rows.slice(0, MAX_DATASETS)) {
      const dataset = cleanDataset(row, featureId, featureLabel);
      if (dataset && !out.some((existing) => existing.id === dataset.id)) out.push(dataset);
    }
  }
  return out;
}

export function findDatasetDefinition(cqrRoot: string, id: unknown): DatasetDefinition | null {
  const wanted = text(id, 40).toLowerCase();
  if (!wanted) return null;
  return listDatasetDefinitions(cqrRoot).find((dataset) => dataset.id === wanted) ?? null;
}

export function isSupportedDatasetSource(source: DatasetSource): source is DatasetSource & { kind: DatasetSourceKind } {
  return (SUPPORTED_DATASET_SOURCE_KINDS as readonly string[]).includes(source.kind);
}

export const DATA_CONNECTION_SETTINGS_REL_PATH = 'data/config/data-connection.json';

export interface DataConnectionSettings {
  /** Show the operator screens (SSH servers, export registration) on this PC. */
  operatorMode: boolean;
}

function settingsPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'config', 'data-connection.json');
}

export function loadDataConnectionSettings(cqrRoot: string): DataConnectionSettings {
  try {
    const file = settingsPath(cqrRoot);
    if (!existsSync(file)) return { operatorMode: false };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { operatorMode?: unknown };
    return { operatorMode: raw?.operatorMode === true };
  } catch {
    return { operatorMode: false };
  }
}

export function saveDataConnectionSettings(cqrRoot: string, settings: DataConnectionSettings): DataConnectionSettings {
  const file = settingsPath(cqrRoot);
  assertWritablePath(file, cqrRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const next: DataConnectionSettings = { operatorMode: settings.operatorMode === true };
  const tmp = `${file}.tmp`;
  assertWritablePath(tmp, cqrRoot);
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return next;
}
