import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 「문제 해결」 화면용: 셸·로컬 서비스 기록을 읽어 사람이 읽을 수 있는 문제 목록으로 정리한다.
 *
 * Sources (all local, read-only):
 * - `{root}/data/logs/shell-startup.log(.1)` and `%LOCALAPPDATA%/MYAgent/shell-startup.log`
 *   — `yyyy-MM-dd HH:mm:ss.fff +09:00 pid=N message` (written by the WPF shell)
 * - `{root}/logs/api-runtime.log(.1)` — `ISO-8601Z pid=N message` (process-health-log.ts)
 *
 * Only known event prefixes are classified; everything else is ignored, so ordinary
 * startup lines never show up as problems. Never throws.
 */

export type ProblemKind =
  | 'startup_failed'
  | 'abnormal_end'
  | 'app_error'
  | 'app_hang'
  | 'screen_crash'
  | 'screen_gave_up'
  | 'service_crash'
  | 'service_restart'
  | 'service_gave_up'
  | 'service_unresponsive'
  | 'service_stall'
  | 'stuck_instance';

/** recovered = 자동으로 해결됨, warn = 한 번은 괜찮지만 반복되면 확인, error = 사용자가 도움을 받아야 함. */
export type ProblemSeverity = 'recovered' | 'warn' | 'error';

export interface ProblemEvent {
  at: string;
  kind: ProblemKind;
  detail?: string;
  /** Plain-language cause for this occurrence (e.g. what the startup failure dialog said). */
  cause?: string;
  /** Occurrence-specific advice; replaces the kind's default advice. */
  advice?: string;
  /** Installer download page, when reinstalling is the fix. */
  download_url?: string;
}

export interface ProblemGroup {
  kind: ProblemKind;
  title: string;
  severity: ProblemSeverity;
  count: number;
  first_at: string;
  last_at: string;
  /** Cause of the latest occurrence, when known. */
  cause?: string;
  advice: string;
  /** Installer download page for the latest occurrence, when reinstalling is the fix. */
  download_url?: string;
}

export interface ProblemHistory {
  days: number;
  generated_at: string;
  status: 'ok' | 'recovered' | 'attention';
  headline: string;
  groups: ProblemGroup[];
  recent: Array<ProblemEvent & { title: string; severity: ProblemSeverity }>;
  sources_found: number;
}

interface KindInfo {
  title: string;
  severity: ProblemSeverity;
  advice: string;
  /** Appended when the same problem happened this many times or more. */
  repeatAt?: number;
  repeatAdvice?: string;
  /** Severity once repeated (default: recovered → warn, others unchanged). */
  repeatSeverity?: ProblemSeverity;
}

const SEND_LOGS = '아래 「담당자에게 보낼 기록 저장」으로 기록을 저장해 담당자에게 보내 주세요.';

const KINDS: Record<ProblemKind, KindInfo> = {
  startup_failed: {
    title: 'MY Agent를 시작하지 못함',
    // The app is running when this screen is open, so a single past failure is not urgent.
    severity: 'warn',
    advice: '같은 문제가 다시 생기면 PC를 다시 시작한 뒤 실행해 보고, 그래도 안 되면 ' + SEND_LOGS,
    repeatAt: 2,
    repeatSeverity: 'error',
  },
  abnormal_end: {
    title: 'MY Agent가 정상적으로 닫히지 않음',
    severity: 'warn',
    advice: '작업 관리자에서 강제로 끝냈거나, 프로그램이 갑자기 꺼졌거나, PC 전원이 꺼진 경우입니다. 한 번이면 신경 쓰지 않아도 됩니다.',
    repeatAt: 3,
    repeatAdvice: '여러 번 반복됐습니다. ' + SEND_LOGS,
  },
  app_error: {
    title: '창(프로그램)에서 오류가 발생함',
    severity: 'error',
    advice: '프로그램을 다시 시작해 주세요. 반복되면 ' + SEND_LOGS,
  },
  app_hang: {
    title: '창이 잠시 응답하지 않음',
    severity: 'recovered',
    advice: '잠시 뒤 스스로 다시 움직였습니다. 큰 파일을 열거나 PC가 바쁠 때 생길 수 있습니다.',
    repeatAt: 5,
    repeatAdvice: '자주 반복됩니다. 다른 무거운 프로그램을 닫아 보고, 그래도 계속되면 ' + SEND_LOGS,
  },
  screen_crash: {
    title: '화면 엔진이 꺼짐',
    severity: 'recovered',
    advice: 'MY Agent가 화면을 자동으로 다시 불러왔습니다. 따로 할 일은 없습니다.',
    repeatAt: 3,
    repeatAdvice: '자주 반복됩니다. Microsoft Edge WebView2 런타임을 업데이트하거나 PC를 다시 시작해 보세요.',
  },
  screen_gave_up: {
    title: '화면이 반복해서 꺼져 자동 복구를 멈춤',
    severity: 'error',
    advice: 'PC를 다시 시작한 뒤 MY Agent를 열어 주세요. 계속되면 ' + SEND_LOGS,
  },
  service_crash: {
    title: '로컬 서비스가 오류로 꺼짐',
    severity: 'warn',
    advice: '자동으로 다시 시작되기 전에 MY Agent가 닫혔습니다. 지금 정상적으로 쓰고 있다면 따로 할 일은 없습니다.',
    repeatAt: 2,
    repeatAdvice: '여러 번 반복됐습니다. ' + SEND_LOGS,
  },
  service_restart: {
    title: '로컬 서비스가 꺼졌다가 자동으로 다시 시작됨',
    severity: 'recovered',
    advice: '자동으로 복구됐습니다. 그때 진행 중이던 답변이 끊겼다면 다시 요청해 주세요.',
    repeatAt: 3,
    repeatAdvice: '자주 반복됩니다. ' + SEND_LOGS,
  },
  service_gave_up: {
    title: '로컬 서비스가 반복해서 꺼져 자동 재시작을 멈춤',
    severity: 'error',
    advice: 'MY Agent를 완전히 종료(트레이 메뉴 → 종료)한 뒤 다시 열어 주세요. 계속되면 ' + SEND_LOGS,
  },
  service_unresponsive: {
    title: '로컬 서비스가 한동안 응답하지 않음',
    severity: 'recovered',
    advice: '긴 작업 중이거나 PC가 바쁠 때 생길 수 있습니다. 대부분 스스로 다시 응답합니다.',
    repeatAt: 5,
    repeatAdvice: '자주 반복됩니다. 계속되면 ' + SEND_LOGS,
  },
  service_stall: {
    title: '로컬 서비스가 10초 넘게 멈춤',
    severity: 'recovered',
    advice: '큰 작업을 처리하는 동안 잠시 멈췄다가 다시 움직였습니다.',
    repeatAt: 5,
    repeatAdvice: '자주 반복됩니다. 계속되면 ' + SEND_LOGS,
  },
  stuck_instance: {
    title: '응답하지 않던 이전 MY Agent를 끝내고 새로 시작함',
    severity: 'recovered',
    advice: '새로 실행할 때 멈춰 있던 이전 창을 정리했습니다.',
  },
};

const SERVICE_STALL_MIN_MS = 10_000;
/** A crash followed by a restart/give-up within this window is one incident. */
const SERVICE_RECOVERY_PAIR_MS = 3 * 60_000;
/** A `problem_shown` line this soon after a startup failure is that failure's dialog. */
const STARTUP_DIALOG_PAIR_MS = 2 * 60_000;
const MAX_DETAIL = 160;
const MAX_RECENT = 30;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const SHELL_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2}:\d{2}) pid=\d+ (.*)$/;
const API_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) pid=\d+ (.*)$/;

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL)}…` : t;
}

const DISK_ADVICE = '디스크 여유 공간을 늘려 주세요. 공간이 부족하면 다시 시작하지 못할 수 있습니다.';

/** Public download page for MY Agent installers (same as the shell's ShellProblems.ReleasesUrl). */
export const MY_AGENT_RELEASES_URL = 'https://github.com/moonhyun-cheol/myagent/releases/latest';

/** Plain-language cause/advice for `startup: api start failed kind=X`. */
function startupFailure(kind: string | undefined): { cause: string; advice: string; download_url?: string } {
  switch (kind) {
    case 'FilesMissing':
      return {
        cause: '프로그램 파일 일부가 없어 로컬 서비스를 시작하지 못했습니다.',
        advice: '같은 문제가 다시 생기면 「설치 파일 받기」로 최신 설치 파일을 받아 MY Agent를 다시 설치해 주세요. 백신이 파일을 격리했다면 격리 목록에서 복원해도 됩니다.',
        download_url: MY_AGENT_RELEASES_URL,
      };
    case 'Blocked':
      return {
        cause: '백신 프로그램이나 보안 정책이 로컬 서비스(node.exe) 실행을 막았습니다.',
        advice: '같은 문제가 다시 생기면 백신 프로그램에서 MY Agent가 차단됐는지 확인하고, 회사 PC라면 ' + SEND_LOGS,
      };
    case 'InstallRoot':
      return {
        cause: 'MY Agent 설치 폴더를 찾지 못했습니다.',
        advice: '같은 문제가 다시 생기면 「설치 파일 받기」로 최신 설치 파일을 받아 MY Agent를 다시 설치해 주세요.',
        download_url: MY_AGENT_RELEASES_URL,
      };
    default:
      return { cause: '로컬 서비스를 실행하지 못했습니다.', advice: KINDS.startup_failed.advice };
  }
}

/** Classify one shell-log message (without timestamp/pid). Exported for tests. */
export function classifyShellMessage(message: string): Omit<ProblemEvent, 'at'> | null {
  if (message.startsWith('previous_session: abnormal_end')) return { kind: 'abnormal_end' };
  if (message.startsWith('startup: install root not found')) {
    return { kind: 'startup_failed', ...startupFailure('InstallRoot') };
  }
  if (message.startsWith('startup: api start failed')) {
    const m = /\((.*)\)\s*$/.exec(message);
    const kind = /kind=(\w+)/.exec(message)?.[1];
    return { kind: 'startup_failed', detail: m ? clip(m[1]) : undefined, ...startupFailure(kind) };
  }
  if (message.startsWith('dispatcher unhandled exception')) {
    const first = message.split(/\r?\n/)[0].replace(/^dispatcher unhandled exception:\s*/, '');
    return { kind: 'app_error', detail: clip(first) };
  }
  if (message.startsWith('ui_hang:')) {
    const m = /(\d+)초째/.exec(message);
    return { kind: 'app_hang', detail: m ? `${m[1]}초 넘게 멈춤` : undefined };
  }
  if (message.startsWith('webview_process_failed:')) return { kind: 'screen_crash' };
  if (message.startsWith('webview_recovery: gave up')) return { kind: 'screen_gave_up' };
  if (message.startsWith('api_restarted:')) return { kind: 'service_restart' };
  if (message.startsWith('api_gave_up:')) {
    return { kind: 'service_gave_up', detail: clip(message.replace(/^api_gave_up:\s*/, '')) };
  }
  if (message.startsWith('api_unresponsive:')) return { kind: 'service_unresponsive' };
  if (message.startsWith('single_instance: ended unresponsive instance')) return { kind: 'stuck_instance' };
  return null;
}

/** Classify one api-runtime message. `next` is the following raw line (crash stack head). */
export function classifyApiMessage(message: string, next?: string): Omit<ProblemEvent, 'at'> | null {
  if (message.startsWith('crash ')) {
    const head = next && !API_LINE.test(next) ? next : undefined;
    return { kind: 'service_crash', detail: head ? clip(head) : undefined };
  }
  if (message.startsWith('event_loop_stall ')) {
    const m = /ms=(\d+)/.exec(message);
    const ms = m ? Number(m[1]) : 0;
    if (ms < SERVICE_STALL_MIN_MS) return null;
    return { kind: 'service_stall', detail: `약 ${Math.round(ms / 1000)}초` };
  }
  return null;
}

function readText(file: string): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const text = readFileSync(file, 'utf8');
    return text.length > MAX_FILE_BYTES ? text.slice(-MAX_FILE_BYTES) : text;
  } catch {
    return null;
  }
}

/** Parse shell-startup.log text. Exported for tests. */
export function parseShellLog(text: string): ProblemEvent[] {
  const out: ProblemEvent[] = [];
  const lines = text.split(/\r?\n/);
  let lastStartup: ProblemEvent | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = SHELL_LINE.exec(lines[i]);
    if (!m) continue;
    const at = new Date(`${m[1]}T${m[2]}${m[3]}`);
    if (Number.isNaN(at.getTime())) continue;
    // The dialog shown right after a startup failure states the real cause (e.g. low disk).
    if (m[4].startsWith('problem_shown:')) {
      if (lastStartup && at.getTime() - Date.parse(lastStartup.at) <= STARTUP_DIALOG_PAIR_MS) {
        const shown = m[4].replace(/^problem_shown:\s*/, '');
        const sep = shown.indexOf(' | ');
        const cause = clip(sep >= 0 ? shown.slice(sep + 3) : shown);
        if (cause) lastStartup.cause = cause;
        if (/디스크/.test(cause)) {
          lastStartup.advice = DISK_ADVICE;
          delete lastStartup.download_url;
        }
      }
      lastStartup = null;
      continue;
    }
    // Exceptions span several lines; only the first line is classified.
    const hit = classifyShellMessage(m[4]);
    if (hit) {
      const event: ProblemEvent = { at: at.toISOString(), ...hit };
      out.push(event);
      lastStartup = event.kind === 'startup_failed' ? event : null;
    }
  }
  return out;
}

/** Parse api-runtime.log text. Exported for tests. */
export function parseApiRuntimeLog(text: string): ProblemEvent[] {
  const out: ProblemEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = API_LINE.exec(lines[i]);
    if (!m) continue;
    const at = new Date(m[1]);
    if (Number.isNaN(at.getTime())) continue;
    const hit = classifyApiMessage(m[2], lines[i + 1]);
    if (hit) out.push({ at: at.toISOString(), ...hit });
  }
  return out;
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warn: 1, recovered: 2 };

/**
 * A service crash that the shell restarted (or gave up on) shortly after is one incident:
 * keep only the restart/give-up line, carrying the crash detail. Exported for tests.
 */
export function mergeServiceRecoveries(events: ProblemEvent[]): ProblemEvent[] {
  const asc = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const pending: number[] = [];
  const dropped = new Set<number>();
  const out = asc.map((e) => ({ ...e }));
  out.forEach((e, index) => {
    if (e.kind === 'service_crash') {
      pending.push(index);
      return;
    }
    if (e.kind !== 'service_restart' && e.kind !== 'service_gave_up') return;
    const t = Date.parse(e.at);
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      const crash = out[pending[p]];
      const gap = t - Date.parse(crash.at);
      if (gap < 0 || gap > SERVICE_RECOVERY_PAIR_MS) continue;
      dropped.add(pending[p]);
      pending.splice(p, 1);
      if (!e.detail && crash.detail) e.detail = crash.detail;
      break;
    }
  });
  return out.filter((_, index) => !dropped.has(index));
}

/** Build the summary from already-parsed events. Exported for tests. */
export function summarizeProblems(
  events: ProblemEvent[],
  opts: { days: number; now?: Date; sourcesFound?: number },
): ProblemHistory {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - opts.days * 86_400_000;
  const inRange = events
    .filter((e) => {
      const t = Date.parse(e.at);
      return t >= cutoff && t <= now.getTime() + 60_000;
    })
    .sort((a, b) => b.at.localeCompare(a.at));

  // Same event can be logged by two overlapping files (rotation edge): drop exact duplicates.
  const seen = new Set<string>();
  const deduped = inRange.filter((e) => {
    const key = `${e.at}|${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const unique = mergeServiceRecoveries(deduped).sort((a, b) => b.at.localeCompare(a.at));

  const byKind = new Map<ProblemKind, ProblemEvent[]>();
  for (const e of unique) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  const groups: ProblemGroup[] = [...byKind.entries()].map(([kind, list]) => {
    const info = KINDS[kind];
    const repeated = info.repeatAt !== undefined && list.length >= info.repeatAt;
    const severity: ProblemSeverity = repeated
      ? info.repeatSeverity ?? (info.severity === 'recovered' ? 'warn' : info.severity)
      : info.severity;
    const latest = list[0];
    return {
      kind,
      title: info.title,
      severity,
      count: list.length,
      first_at: list[list.length - 1].at,
      last_at: latest.at,
      ...(latest.cause ? { cause: latest.cause } : {}),
      advice: repeated && info.repeatAdvice ? info.repeatAdvice : latest.advice ?? info.advice,
      ...(latest.download_url ? { download_url: latest.download_url } : {}),
    };
  });
  groups.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.last_at.localeCompare(a.last_at));

  const needsHelp = groups.some((g) => g.severity !== 'recovered');
  const total = unique.length;
  const status: ProblemHistory['status'] = total === 0 ? 'ok' : needsHelp ? 'attention' : 'recovered';
  const headline =
    status === 'ok'
      ? `최근 ${opts.days}일 동안 기록된 문제가 없습니다.`
      : status === 'recovered'
        ? `최근 ${opts.days}일 동안 문제가 ${total}번 있었지만 모두 자동으로 해결됐습니다.`
        : `최근 ${opts.days}일 동안 확인이 필요한 문제가 있습니다.`;

  return {
    days: opts.days,
    generated_at: now.toISOString(),
    status,
    headline,
    groups,
    recent: unique.slice(0, MAX_RECENT).map((e) => {
      const group = groups.find((g) => g.kind === e.kind);
      return { ...e, title: KINDS[e.kind].title, severity: group?.severity ?? KINDS[e.kind].severity };
    }),
    sources_found: opts.sourcesFound ?? 0,
  };
}

export function problemHistorySources(cqrRoot: string, env: NodeJS.ProcessEnv = process.env): {
  shell: string[];
  api: string[];
} {
  const shell = [
    path.join(cqrRoot, 'data', 'logs', 'shell-startup.log.1'),
    path.join(cqrRoot, 'data', 'logs', 'shell-startup.log'),
  ];
  const local = env.LOCALAPPDATA?.trim();
  if (local) shell.push(path.join(local, 'MYAgent', 'shell-startup.log'));
  const api = [
    path.join(cqrRoot, 'logs', 'api-runtime.log.1'),
    path.join(cqrRoot, 'logs', 'api-runtime.log'),
  ];
  return { shell, api };
}

export function loadProblemHistory(
  cqrRoot: string,
  opts: { days?: number; now?: Date; env?: NodeJS.ProcessEnv } = {},
): ProblemHistory {
  const days = Math.min(90, Math.max(1, Math.round(opts.days ?? 14)));
  const sources = problemHistorySources(cqrRoot, opts.env);
  const events: ProblemEvent[] = [];
  let found = 0;
  for (const file of sources.shell) {
    const text = readText(file);
    if (text === null) continue;
    found += 1;
    events.push(...parseShellLog(text));
  }
  for (const file of sources.api) {
    const text = readText(file);
    if (text === null) continue;
    found += 1;
    events.push(...parseApiRuntimeLog(text));
  }
  return summarizeProblems(events, { days, now: opts.now, sourcesFound: found });
}
