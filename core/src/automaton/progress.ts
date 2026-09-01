import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { AutomatonDispatchError } from './errors.js';

interface ProgressSidecar {
  status?: string;
  last_segment?: string;
  last_status?: string;
  command_id?: string;
  completed?: number;
  total?: number;
  updated_at?: string;
  pid?: number;
}

interface ActivityLine {
  ts?: string;
  line?: string;
}

export function buildAutomatonProgressPath(
  automatonRoot: string,
  sessionId: string,
  tool: string,
): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return path.join(
    automatonRoot,
    'data',
    'output',
    'batch_progress',
    `cqr_${safeSession}_${safeTool}_${Date.now()}.json`,
  );
}

export function activityLogPath(progressFile: string): string {
  const base = path.basename(progressFile, path.extname(progressFile));
  return path.join(path.dirname(progressFile), `${base}.activity.jsonl`);
}

function formatElapsed(startedMs: number): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
}

function readProgressSidecar(progressFile: string): ProgressSidecar | null {
  if (!existsSync(progressFile)) return null;
  try {
    return JSON.parse(readFileSync(progressFile, 'utf8')) as ProgressSidecar;
  } catch {
    return null;
  }
}

export function readActivityLog(progressFile: string, maxLines = 40): string {
  const logPath = activityLogPath(progressFile);
  if (!existsSync(logPath)) return '';
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxLines);
    const rendered: string[] = [];
    for (const raw of tail) {
      try {
        const payload = JSON.parse(raw) as ActivityLine;
        const ts = payload.ts ? `[${payload.ts}] ` : '';
        const line = String(payload.line ?? '').trim();
        if (line) rendered.push(`${ts}${line}`);
      } catch {
        // skip malformed line
      }
    }
    return rendered.join('\n');
  } catch {
    return '';
  }
}

export function formatAutomatonProgressStatus(
  progressFile: string,
  startedMs: number,
): string {
  const elapsed = formatElapsed(startedMs);
  const sidecar = readProgressSidecar(progressFile);
  if (!sidecar) {
    return `my_live_automaton 시작 중… (${elapsed})`;
  }

  const segment = String(sidecar.last_segment || sidecar.command_id || '').trim();
  const status = String(sidecar.status || 'running');
  if (segment) {
    return `my_live_automaton — ${segment} (${elapsed})`;
  }
  if (status === 'running') {
    return `my_live_automaton 실행 중… (${elapsed})`;
  }
  return `my_live_automaton ${status} (${elapsed})`;
}

export interface AutomatonProgressCallbacks {
  onStatus?: (text: string) => void;
  onThought?: (text: string) => void;
}

export function startAutomatonProgressPolling(
  progressFile: string,
  callbacks: AutomatonProgressCallbacks | ((text: string) => void),
  intervalMs = 2000,
): () => void {
  const handlers: AutomatonProgressCallbacks = typeof callbacks === 'function'
    ? { onStatus: callbacks }
    : callbacks;

  const startedMs = Date.now();
  let lastStatus = '';
  let lastThought = '';

  const tick = () => {
    const statusText = formatAutomatonProgressStatus(progressFile, startedMs);
    if (statusText !== lastStatus) {
      lastStatus = statusText;
      handlers.onStatus?.(statusText);
    }

    const thoughtText = readActivityLog(progressFile);
    if (thoughtText && thoughtText !== lastThought) {
      // 로그는 append-only이므로 새로 추가된 suffix(델타)만 전달한다.
      // (40줄 롤링 윈도로 prefix가 어긋나는 드문 경우에만 전체 스냅샷을 이어붙임)
      const delta = thoughtText.startsWith(lastThought)
        ? thoughtText.slice(lastThought.length)
        : (lastThought ? `\n${thoughtText}` : thoughtText);
      lastThought = thoughtText;
      if (delta) handlers.onThought?.(delta);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

export interface PollProgressSidecarOptions {
  progressFile: string;
  jsonOutputPath: string;
  stallTimeoutMin: number;
  hardTimeoutSec: number;
  pollIntervalMs?: number;
  onStatus?: (text: string) => void;
  onThought?: (text: string) => void;
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function progressSnapshotKey(sidecar: ProgressSidecar | null, mtimeMs: number): string {
  if (!sidecar) return `missing:${mtimeMs}`;
  return [
    sidecar.status ?? '',
    sidecar.completed ?? '',
    sidecar.last_segment ?? '',
    sidecar.last_status ?? '',
    mtimeMs,
  ].join('|');
}

function readJsonOutput(jsonOutputPath: string): Record<string, unknown> {
  if (!existsSync(jsonOutputPath)) {
    throw new AutomatonDispatchError(
      'AUTOMATON_STALL_DETECTED',
      `결과 파일이 없습니다: ${jsonOutputPath}`,
    );
  }
  try {
    return JSON.parse(readFileSync(jsonOutputPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new AutomatonDispatchError(
      'AUTOMATON_STALL_DETECTED',
      `결과 JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function wrapDirectCommandEnvelope(
  toolId: string,
  jsonOutputPath: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const dcStatus = String(result.status ?? '').toLowerCase();
  const failed = dcStatus === 'failed' || dcStatus === 'error';
  const envelope: Record<string, unknown> = {
    status: failed ? 'failed' : 'success',
    command_id: toolId,
    tool: toolId,
    json_output_path: jsonOutputPath,
    result,
  };
  if (result.reason_code) envelope.reason_code = result.reason_code;
  return envelope;
}

/** detached subprocess 완료까지 sidecar JSON 폴링 (MCP blocking 없음) */
export async function pollProgressSidecar(
  toolId: string,
  options: PollProgressSidecarOptions,
): Promise<Record<string, unknown>> {
  const {
    progressFile,
    jsonOutputPath,
    stallTimeoutMin,
    hardTimeoutSec,
    pollIntervalMs = 5000,
    onStatus,
    onThought,
  } = options;

  const startedMs = Date.now();
  const hardDeadlineMs = startedMs + hardTimeoutSec * 1000;
  const stallTimeoutMs = stallTimeoutMin * 60 * 1000;

  let lastProgressMs = startedMs;
  let lastSnapshot = '';
  let lastThought = '';
  let pollCount = 0;

  while (Date.now() < hardDeadlineMs) {
    pollCount += 1;
    const sidecar = readProgressSidecar(progressFile);
    let mtimeMs = 0;
    if (existsSync(progressFile)) {
      try {
        mtimeMs = statSync(progressFile).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
    }

    const snapshot = progressSnapshotKey(sidecar, mtimeMs);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      lastProgressMs = Date.now();
    }

    const statusText = formatAutomatonProgressStatus(progressFile, startedMs);
    onStatus?.(statusText);

    const thoughtText = readActivityLog(progressFile);
    if (thoughtText && thoughtText !== lastThought) {
      // append-only 로그이므로 새 suffix(델타)만 전달 — UI가 그대로 이어붙일 수 있게.
      const delta = thoughtText.startsWith(lastThought)
        ? thoughtText.slice(lastThought.length)
        : (lastThought ? `\n${thoughtText}` : thoughtText);
      lastThought = thoughtText;
      if (delta) onThought?.(delta);
      lastProgressMs = Date.now();
    }

    const actPath = activityLogPath(progressFile);
    if (existsSync(actPath)) {
      try {
        const actMtime = statSync(actPath).mtimeMs;
        if (actMtime > lastProgressMs) {
          lastProgressMs = actMtime;
        }
      } catch {
        // ignore stat errors
      }
    }

    const status = String(sidecar?.status ?? '').toLowerCase();
    if (status === 'done') {
      if (!existsSync(jsonOutputPath)) {
        // sidecar done 은 chi-squared/json 기록보다 먼저 올 수 있음 — json flush 대기
      } else {
        const result = readJsonOutput(jsonOutputPath);
        return wrapDirectCommandEnvelope(toolId, jsonOutputPath, result);
      }
    }
    if (status === 'error') {
      const result = existsSync(jsonOutputPath)
        ? readJsonOutput(jsonOutputPath)
        : { status: 'failed', errors: ['progress sidecar status: error'] };
      return wrapDirectCommandEnvelope(toolId, jsonOutputPath, result);
    }

    if (Date.now() - lastProgressMs >= stallTimeoutMs) {
      throw new AutomatonDispatchError(
        'AUTOMATON_STALL_DETECTED',
        `${stallTimeoutMin}분간 진행률 변화가 없습니다.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new AutomatonDispatchError(
    'AUTOMATON_HARD_TIMEOUT',
    `최대 제한 시간(${Math.floor(hardTimeoutSec / 3600)}시간)을 초과했습니다.`,
  );
}
