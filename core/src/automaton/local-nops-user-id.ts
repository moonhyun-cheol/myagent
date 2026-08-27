/**
 * Same-PC regular NOPS login (not AI / ai_bridge.json).
 * Log file: C:\GoodApp\NOPSPro\NOPSPro\LogFiles\YYYY-MM-DD_<userId>.Log
 */
import { readdirSync } from 'node:fs';

export const DEFAULT_NOPS_LOG_DIR = String.raw`C:\GoodApp\NOPSPro\NOPSPro\LogFiles`;

const LOG_NAME = /^(\d{4}-\d{2}-\d{2})_([A-Za-z][A-Za-z0-9]*)\.Log$/i;
const SKIP_USER_IDS = new Set(['FILE', 'NC_MAIN', 'ADMIN']);

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

export function readLocalNopsUserId(logDir = DEFAULT_NOPS_LOG_DIR): string {
  try {
    return pickLocalNopsUserId(readdirSync(logDir));
  } catch {
    return '';
  }
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
