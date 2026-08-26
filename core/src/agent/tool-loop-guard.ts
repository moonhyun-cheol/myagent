import type { ChatMessage } from '../providers/openai-compatible.js';
import { chatContentToText } from '../providers/openai-compatible.js';
import type { AgentToolCall } from './tools.js';
import { normalizeToolCall } from './tools.js';

type ToolLoopErrorClass =
  | 'validation'
  | 'not_found'
  | 'permission'
  | 'timeout'
  | 'tool_error'
  | 'success'
  | 'unknown';

const EXPLORATION_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'query_repo_map',
  'search_embeddings',
]);

export interface ToolLoopGuardDecision {
  triggered: boolean;
  fingerprint: string;
  repeatCount: number;
  maxRepeat: number;
  errorClass: ToolLoopErrorClass;
}

export interface ToolLoopGuard {
  /** Call once before executing a tool; increments loop counters. */
  admit(call: AgentToolCall): ToolLoopGuardDecision;
  /** Update last error class for a tool after execution. */
  noteResult(call: AgentToolCall, output: string): void;
}

function parseMaxRepeat(): number {
  const raw = process.env.MY_AGENT_TOOL_LOOP_MAX_REPEAT;
  if (!raw) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function argFingerprint(raw: string): string {
  try {
    return hashString(JSON.stringify(canonicalize(JSON.parse(raw || '{}'))));
  } catch {
    return `invalid:${hashString(raw)}`;
  }
}

function coarseFingerprint(
  toolName: string,
  rawArguments: string,
  errorClass: ToolLoopErrorClass,
): string {
  if (toolName === 'edit_file' && errorClass !== 'success') {
    try {
      const args = JSON.parse(rawArguments || '{}') as { path?: unknown };
      const path = typeof args.path === 'string' ? args.path.replace(/\\/g, '/').trim() : '';
      if (path) return `${toolName}|path:${hashString(path)}|fail`;
    } catch {
      /* fall through to tool-wide fingerprint */
    }
  }
  return `${toolName}|${errorClass}`;
}

function classifyToolResult(output: string): ToolLoopErrorClass {
  const text = output.trim().toLowerCase();
  if (!text) return 'unknown';
  // Soft exploration re-hit must stay `success` so further identical admits keep blocking.
  // Classifying TOOL_LOOP_GUARD as validation (old bug) re-allowed the same search_files.
  if (text.includes('tool_loop_guard') && text.includes(', success)')) {
    return 'success';
  }
  if (text.includes('already_read') || text.includes('already_searched')) {
    return 'success';
  }
  if (
    text.includes('edit_file_failed')
    || text.includes('apply_patch_failed')
    || /"ok"\s*:\s*false/.test(text)
    || text.includes('old_text not found')
  ) {
    return 'tool_error';
  }
  if (
    text.includes('missing required')
    || text.includes('invalid tool arguments')
    || text.includes('expected string')
    || text.includes('remove unsupported')
    || text.includes('tool_loop_guard')
  ) {
    return 'validation';
  }
  if (text.includes('not found') || text.includes('enoent') || text.includes('no such file')) {
    return 'not_found';
  }
  if (/permission denied|eacces|eperm|access is denied|unauthorizedaccess|sharing violation|office_file_locked|forbidden/i.test(text)) {
    return 'permission';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'timeout';
  }
  if (
    text.startsWith('error:')
    || text.includes('error: tool_call_failed')
    || text.includes('unknown tool')
    || text.includes('edit_file_failed')
    || text.includes('apply_patch_failed')
    || /"ok"\s*:\s*false/.test(text)
  ) {
    return 'tool_error';
  }
  // Non-error payloads (read_file body, list_directory, search hits, wrote …) count as
  // success so identical exploration re-calls are loop-guarded. Previously these were
  // "unknown" and allowed maxRepeat*5 identical read_file hits → context balloon.
  return 'success';
}

function explorationSoftHint(fingerprint: string): string {
  if (fingerprint.startsWith('read_file|')) {
    return ' Path content is already in prior tool results — call edit_file / apply_patch / write_file now (do not read_file again).';
  }
  if (fingerprint.startsWith('search_files|') || fingerprint.startsWith('search_embeddings|')) {
    return ' Search hits are already in prior tool results — read_file the hit paths, then edit_file / apply_patch / write_file. Do NOT re-call the same search.';
  }
  if (fingerprint.startsWith('list_directory|') || fingerprint.startsWith('query_repo_map|')) {
    return ' Listing/map results are already in prior tool results — read_file a concrete path, then mutate. Do NOT repeat the same exploration call.';
  }
  return ' Prior tool results already have this payload — change tool/args or mutate; do not retry the identical call.';
}

function seedFromMessages(messages: ChatMessage[]): {
  strictCounts: Map<string, number>;
  coarseCounts: Map<string, number>;
  lastByTool: Map<string, ToolLoopErrorClass>;
} {
  const strictCounts = new Map<string, number>();
  const coarseCounts = new Map<string, number>();
  const lastByTool = new Map<string, ToolLoopErrorClass>();
  const resultByCallId = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      resultByCallId.set(m.tool_call_id, chatContentToText(m.content));
    }
  }

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (const raw of m.tool_calls) {
      const call = normalizeToolCall(raw as AgentToolCall);
      const output = resultByCallId.get(call.id) ?? '';
      const errorClass = classifyToolResult(output);
      lastByTool.set(call.function.name, errorClass);
      if (errorClass === 'success') {
        const fp = `${call.function.name}|values:${argFingerprint(call.function.arguments)}|success`;
        strictCounts.set(fp, (strictCounts.get(fp) ?? 0) + 1);
        continue;
      }
      const strict = `${call.function.name}|${argFingerprint(call.function.arguments)}|${errorClass}`;
      const coarse = coarseFingerprint(
        call.function.name,
        call.function.arguments,
        errorClass,
      );
      strictCounts.set(strict, (strictCounts.get(strict) ?? 0) + 1);
      coarseCounts.set(coarse, (coarseCounts.get(coarse) ?? 0) + 1);
    }
  }

  return { strictCounts, coarseCounts, lastByTool };
}

function admitCall(
  toolName: string,
  rawArguments: string,
  errorClass: ToolLoopErrorClass,
  strictCounts: Map<string, number>,
  coarseCounts: Map<string, number>,
  maxRepeat: number,
): ToolLoopGuardDecision {
  const exploration = EXPLORATION_TOOLS.has(toolName);
  // Successful identical exploration (esp. read_file) must stop after 1 hit —
  // re-appending the same file body balloons context (100KB→400KB+) without progress.
  // Exploration *failures* get a modest retry budget (not *5).
  const editFailure =
    toolName === 'edit_file'
    && errorClass !== 'success'
    && errorClass !== 'unknown';
  const effectiveMax =
    errorClass === 'success' && exploration
      ? 1
      : editFailure
        ? 2
      : exploration
        ? Math.max(maxRepeat * 2, 4)
        : maxRepeat;
  const coarseMax = editFailure ? 2 : maxRepeat * 3;

  if (errorClass === 'success') {
    const fp = `${toolName}|values:${argFingerprint(rawArguments)}|success`;
    const repeatCount = (strictCounts.get(fp) ?? 0) + 1;
    strictCounts.set(fp, repeatCount);
    return {
      triggered: repeatCount > effectiveMax,
      fingerprint: fp,
      repeatCount,
      maxRepeat: effectiveMax,
      errorClass,
    };
  }

  const strictFp = `${toolName}|${argFingerprint(rawArguments)}|${errorClass}`;
  const coarseFp = coarseFingerprint(toolName, rawArguments, errorClass);
  const strictCount = (strictCounts.get(strictFp) ?? 0) + 1;
  strictCounts.set(strictFp, strictCount);
  const strictTriggered = strictCount > effectiveMax;

  if (exploration) {
    return {
      triggered: strictTriggered,
      fingerprint: strictFp,
      repeatCount: strictCount,
      maxRepeat: effectiveMax,
      errorClass,
    };
  }

  const coarseCount = (coarseCounts.get(coarseFp) ?? 0) + 1;
  coarseCounts.set(coarseFp, coarseCount);
  const coarseTriggered = coarseCount > coarseMax;

  if (coarseTriggered && !strictTriggered) {
    return {
      triggered: true,
      fingerprint: coarseFp,
      repeatCount: coarseCount,
      maxRepeat: coarseMax,
      errorClass,
    };
  }

  return {
    triggered: strictTriggered,
    fingerprint: strictFp,
    repeatCount: strictCount,
    maxRepeat: effectiveMax,
    errorClass,
  };
}

export function createToolLoopGuard(messages: ChatMessage[]): ToolLoopGuard {
  const maxRepeat = parseMaxRepeat();
  const seeded = seedFromMessages(messages);
  const strictCounts = new Map(seeded.strictCounts);
  const coarseCounts = new Map(seeded.coarseCounts);
  const lastByTool = new Map(seeded.lastByTool);

  return {
    admit(call) {
      const normalized = normalizeToolCall(call);
      const name = normalized.function.name;
      const args = normalized.function.arguments;
      // Exact-args exploration that already succeeded must use the success budget
      // even if the prior admit was classified as `unknown` (first call in a step).
      const successFp = `${name}|values:${argFingerprint(args)}|success`;
      const priorSuccess = strictCounts.get(successFp) ?? 0;
      const errorClass =
        EXPLORATION_TOOLS.has(name) && priorSuccess >= 1
          ? 'success'
          : (lastByTool.get(name) ?? 'unknown');
      return admitCall(name, args, errorClass, strictCounts, coarseCounts, maxRepeat);
    },

    noteResult(call, output) {
      const normalized = normalizeToolCall(call);
      const name = normalized.function.name;
      const cls = classifyToolResult(output);
      lastByTool.set(name, cls);
      // First explore admit often uses `unknown`; after a real success, mark the
      // success fingerprint so the next identical call soft-blocks (count 2/1).
      if (cls === 'success' && EXPLORATION_TOOLS.has(name)) {
        const fp = `${name}|values:${argFingerprint(normalized.function.arguments)}|success`;
        if ((strictCounts.get(fp) ?? 0) < 1) strictCounts.set(fp, 1);
      }
    },
  };
}

export function formatLoopGuardStop(decision: ToolLoopGuardDecision): string {
  const mutateHint =
    decision.fingerprint.startsWith('edit_file|') && decision.errorClass !== 'success'
      ? ' edit_file failed twice on this path — do not retry it. Use write_file with the complete file body (or apply_patch with fresh exact context), then verify.'
      : decision.errorClass === 'success'
        ? explorationSoftHint(decision.fingerprint)
        : '';
  return [
    'ERROR: TOOL_LOOP_GUARD',
    `Repeated tool call blocked (${decision.repeatCount}/${decision.maxRepeat}, ${decision.errorClass}).`,
    `Change strategy: different path/args, another tool, or answer the user without retrying the same call.${mutateHint}`,
    `Fingerprint: ${decision.fingerprint}`,
  ].join(' ');
}

/**
 * Soft exploration re-hit feedback for the model (run continues).
 * Explicitly forbids dumping TOOL_LOOP_GUARD to the user — that was the UX failure mode
 * when search_files succeeded once then the model re-called the same query.
 */
export function formatSoftExplorationLoopCorrection(
  decision: ToolLoopGuardDecision,
  toolName: string,
): string {
  const next =
    toolName === 'edit_file'
      ? 'The same-path edit_file failure budget is exhausted. Do NOT call edit_file again on this path. Use write_file with the full current file body, or apply_patch after fresh exact context, then run diagnostics/tests.'
      : toolName === 'search_files' || toolName === 'search_embeddings'
      ? 'Call read_file on the hit path(s) from the prior search result, then edit_file / apply_patch / write_file to fulfill the user request.'
      : toolName === 'read_file'
        ? 'Call edit_file / apply_patch / write_file now using the prior read body. Do not read_file the same path again.'
        : 'Pick a concrete unread path (read_file) or mutate (edit_file / apply_patch / write_file). Do not repeat the identical exploration call.';
  return [
    formatLoopGuardStop(decision),
    '',
    'Instructions for the model (do not show to user):',
    '- This is NOT a hard failure — the identical successful exploration was blocked to avoid context bloat.',
    `- ${next}`,
    '- Do NOT paste TOOL_LOOP_GUARD / Fingerprint into the user-visible reply.',
    '- Do NOT claim 완료 until mutate + disk evidence exist.',
    '- User-facing status should stay 「해결 중…」 while you continue.',
  ].join('\n');
}

export function formatLoopGuardUserMessage(decision: ToolLoopGuardDecision): string {
  const isSuccessLoop = decision.errorClass === 'success';
  const nextHint = isSuccessLoop
    ? decision.fingerprint.startsWith('search_files|')
      || decision.fingerprint.startsWith('search_embeddings|')
      ? '다음에: 이전 검색 히트 경로를 read_file 한 뒤 edit_file / apply_patch / write_file (같은 search 금지).'
      : '다음에: 이미 읽은 내용으로 edit_file / apply_patch / write_file을 호출하세요 (같은 read/탐색 금지).'
    : '다음에: 경로·인자·도구를 바꾼 뒤 같은 요청을 다시 보내 주세요.';
  return [
    isSuccessLoop
      ? '중단: 동일 탐색 도구 재호출로 code-agent를 멈췄습니다 (실패가 아님).'
      : '중단: 동일 도구 실패 반복으로 code-agent를 멈췄습니다.',
    `원인: ${decision.errorClass} (${decision.repeatCount}회, 한도 ${decision.maxRepeat})`,
    '실제 반영: 없음 또는 부분 — 이 상태에서 「수정 완료」라고 쓰지 마세요.',
    nextHint,
  ].join('\n');
}

/** True when the run can recover by changing tactic instead of aborting. */
export function isSoftLoopGuardStop(decision: ToolLoopGuardDecision): boolean {
  return (
    decision.errorClass === 'success'
    || (
      decision.fingerprint.startsWith('edit_file|')
      && decision.errorClass !== 'unknown'
    )
  );
}
