import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ErrorReportSettings } from '../config/user-overrides.js';
import { loadUserOverrides, userConfigPath } from '../config/user-overrides.js';
import { readProductVersion } from '../config/product-version.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface ErrorReportPayload {
  subject: string;
  summary: string;
  mode?: string;
  rawError?: string;
}

export interface LocalErrorReportResult {
  ok: boolean;
  message: string;
  report_id?: string;
  log_path?: string;
}

function errorLogPath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'error-reports.jsonl');
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return;
  try {
    if (statSync(logPath).size < MAX_LOG_BYTES) return;
    const rotated = `${logPath}.1`;
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(logPath, rotated);
  } catch {
    // A rotation failure must not discard the current report.
  }
}

export function getEffectiveErrorReportSettings(dataDir: string): ErrorReportSettings {
  const user = loadUserOverrides(userConfigPath(dataDir)).error_report ?? {};
  return { enabled: user.enabled !== false };
}

export function getErrorReportPublicConfig(_cqrRoot: string, dataDir: string, _vaultDir?: string) {
  const settings = getEffectiveErrorReportSettings(dataDir);
  return {
    enabled: settings.enabled === true,
    configured: true,
    storage: 'local_jsonl' as const,
    log_path: 'data/logs/error-reports.jsonl',
  };
}

export async function sendErrorReportNow(
  cqrRoot: string,
  dataDir: string,
  _vaultDir: string,
  payload: ErrorReportPayload,
  force = false,
): Promise<LocalErrorReportResult> {
  const settings = getEffectiveErrorReportSettings(dataDir);
  if (!force && settings.enabled !== true) {
    return { ok: false, message: '로컬 오류 기록이 비활성화되어 있습니다.' };
  }

  const reportId = `ERR-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const logPath = errorLogPath(dataDir);
  const entry = {
    schema_version: 1,
    report_id: reportId,
    at: new Date().toISOString(),
    version: readProductVersion(cqrRoot),
    mode: payload.mode ?? 'unknown',
    subject: redactSecrets(payload.subject).slice(0, 240),
    summary: redactSecrets(payload.summary).slice(0, 4000),
    raw_error: payload.rawError ? redactSecrets(payload.rawError).slice(0, 12_000) : undefined,
    related_logs: {
      llm_wire: 'data/logs/llm-wire.jsonl',
      agent_audit: 'data/audit/agent-ledger.jsonl',
      debug: 'logs/cqr-debug.log',
      diagnostics: '/admin/diagnostics',
    },
  };

  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath);
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return {
      ok: true,
      report_id: reportId,
      log_path: 'data/logs/error-reports.jsonl',
      message: `로컬 오류 기록 완료 · ${reportId}`,
    };
  } catch (error) {
    return { ok: false, message: `로컬 오류 기록 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Startup compatibility hook. No polling or external transmission occurs. */
export function startAutoLogReportLoop(_cqrRoot: string, _dataDir: string, _vaultDir: string): void {
  // Runtime exceptions are recorded directly through queueAutoErrorReport.
}

export function queueAutoErrorReport(
  cqrRoot: string,
  dataDir: string,
  vaultDir: string,
  payload: ErrorReportPayload,
): void {
  void sendErrorReportNow(cqrRoot, dataDir, vaultDir, payload, false);
}
