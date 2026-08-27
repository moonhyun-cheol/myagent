/**
 * Same-PC regular NOPS login (not AI / ai_bridge.json).
 * Log file: YYYY-MM-DD_<userId>.Log under NOPSPro\LogFiles.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_NOPS_LOG_DIR = String.raw`C:\GoodApp\NOPSPro\NOPSPro\LogFiles`;
export const DEFAULT_NOPS_EXE = String.raw`C:\GoodApp\NOPSPro\NOPSpro.exe`;

const LOG_NAME = /^(\d{4}-\d{2}-\d{2})_([A-Za-z][A-Za-z0-9]*)\.Log$/i;
const SKIP_USER_IDS = new Set(['FILE', 'NC_MAIN', 'ADMIN']);
const PROCESS_LOOKUP_TTL_MS = 60_000;

export function localDateStamp(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseNopsUserLogName(
  fileName: string,
): { date: string; userId: string } | null {
  const name = pathBasename(fileName);
  const match = LOG_NAME.exec(name);
  if (!match) return null;
  const date = match[1];
  const userId = match[2];
  if (SKIP_USER_IDS.has(userId.toUpperCase())) return null;
  if (!/[0-9]/.test(userId)) return null;
  return { date, userId };
}

function pathBasename(fileName: string): string {
  const parts = String(fileName || '').replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] || '';
}

export function pickLocalNopsUserId(
  fileNames: string[],
  today = localDateStamp(),
): string {
  const rows = fileNames
    .map((name) => parseNopsUserLogName(name))
    .filter((row): row is { date: string; userId: string } => row != null);
  if (!rows.length) return '';

  const todayRows = rows.filter((row) => row.date === today);
  const uniqueToday = [...new Set(todayRows.map((row) => row.userId))];
  if (uniqueToday.length === 1) return uniqueToday[0];
  if (uniqueToday.length > 1) return '';

  const latest = rows.reduce((a, b) => (a.date >= b.date ? a : b));
  const sameDay = [...new Set(rows.filter((row) => row.date === latest.date).map((row) => row.userId))];
  return sameDay.length === 1 ? sameDay[0] : '';
}

/** LogFiles next to NOPSpro.exe (regular install, not AI\). */
export function logDirsFromNopsExeDir(exeDir: string): string[] {
  const root = String(exeDir || '').trim();
  if (!root) return [];
  return [
    path.join(root, 'NOPSPro', 'LogFiles'),
    path.join(root, 'LogFiles'),
  ];
}

/** Same GoodApp layout on every drive letter. */
export function listGoodAppNopsLogDirs(): string[] {
  const dirs: string[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    dirs.push(`${letter}:\\GoodApp\\NOPSPro\\NOPSPro\\LogFiles`);
  }
  return dirs;
}

let cachedExeDir: { value: string | undefined; expires: number } | null = null;

function runningNopsproExeDir(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const now = Date.now();
  if (cachedExeDir && cachedExeDir.expires > now) return cachedExeDir.value;
  let value: string | undefined;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process -Name NOPSpro -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)',
      ],
      { timeout: 3_000, windowsHide: true, encoding: 'utf8' },
    ).trim();
    const exe = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => (
        line.toLowerCase().endsWith('nopspro.exe')
        && !/(^|[\\/])AI[\\/]/i.test(line)
      ));
    if (exe && existsSync(exe)) value = path.dirname(exe);
  } catch {
    value = undefined;
  }
  cachedExeDir = { value, expires: now + PROCESS_LOOKUP_TTL_MS };
  return value;
}

function listLogNames(logDir: string): string[] {
  try {
    return existsSync(logDir) ? readdirSync(logDir) : [];
  } catch {
    return [];
  }
}

function hasTodayUser(fileNames: string[], today: string): boolean {
  return fileNames.some((name) => parseNopsUserLogName(name)?.date === today);
}

function discoverNopsLogNames(today: string): string[] {
  const goodAppNames = listGoodAppNopsLogDirs().flatMap(listLogNames);
  if (hasTodayUser(goodAppNames, today)) return goodAppNames;
  const extraDirs = [
    ...logDirsFromNopsExeDir(runningNopsproExeDir() ?? ''),
    ...logDirsFromNopsExeDir(existsSync(DEFAULT_NOPS_EXE) ? path.dirname(DEFAULT_NOPS_EXE) : ''),
  ];
  return [...goodAppNames, ...extraDirs.flatMap(listLogNames)];
}

export function readLocalNopsUserId(logDir?: string, now = new Date()): string {
  const today = localDateStamp(now);
  if (logDir != null && logDir !== '') {
    return pickLocalNopsUserId(listLogNames(logDir), today);
  }
  return pickLocalNopsUserId(discoverNopsLogNames(today), today);
}

export function attachLocalNopsUserId<T extends Record<string, unknown>>(
  rawRequest: T,
  args: Record<string, unknown>,
  userId = readLocalNopsUserId(),
): T {
  const id = String(userId || '').trim();
  if (!id) return rawRequest;
  args.nopspro_user_id = id;
  (rawRequest as Record<string, unknown>).nopspro_user_id = id;
  return rawRequest;
}
