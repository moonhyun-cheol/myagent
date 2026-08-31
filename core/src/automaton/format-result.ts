import type { AutomatonErrorCode } from './errors.js';
import { AutomatonDispatchError } from './errors.js';

export function formatAutomatonError(err: unknown): string {
  if (err instanceof AutomatonDispatchError) {
    switch (err.code) {
      case 'AUTOMATON_HARD_TIMEOUT':
        return [
          '**분석 시간 초과**',
          '',
          '배치 분석이 최대 제한 시간(4시간)을 초과하여 중단되었습니다. 데이터 범위를 분할하여 재시도하십시오.',
          '',
          err.message,
        ].join('\n');
      case 'AUTOMATON_STALL_DETECTED':
        return [
          '**프로세스 정지(Stall) 감지**',
          '',
          '15분간 진행률 변화가 없습니다. activity.jsonl 로그 파일 점검이 필요합니다.',
          '',
          err.message,
          '',
          '확인: progress sidecar JSON, 동일 디렉터리의 `.activity.jsonl`',
        ].join('\n');
      case 'MCP_SPAWN_FAILED':
        return [
          '**Automaton 프로세스 기동 실패**',
          '',
          err.message,
          '',
          '확인: `LIVE_AUTOMATON_ROOT`, `.venv` Python 경로, direct command 스크립트 존재 여부',
        ].join('\n');
      default:
        return err.message;
    }
  }

  const code = (err as { code?: AutomatonErrorCode })?.code;
  if (code === 'AUTOMATON_HARD_TIMEOUT' || code === 'AUTOMATON_STALL_DETECTED') {
    return formatAutomatonError(new AutomatonDispatchError(code, String(err)));
  }

  return err instanceof Error ? err.message : String(err);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nonEmptyString(v: unknown, max = 4_000): string {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}

const ENGINE_STATUS_PREFIX =
  /^(?:작업 실행 결과\s*)?(?:[A-Za-z0-9_]+ completed successfully\.\s*\|\s*status=\S+\s*\|\s*message=?)/i;

/** Drop engine `cmd completed successfully. | status=ok | message=` so only the 작업 완료 body remains. */
export function stripAutomatonEngineStatus(text: string): string {
  let s = String(text ?? '').trim();
  if (!s) return '';
  const marker = '======작업';
  const idx = s.indexOf(marker);
  if (idx >= 0) return s.slice(idx).trim();
  s = s.replace(/^작업 실행 결과\s*/u, '').trim();
  s = s.replace(ENGINE_STATUS_PREFIX, '').trim();
  if (/completed successfully/i.test(s) && /\|\s*status=/i.test(s)) return '';
  return s;
}

/**
 * OpenClaw / live automaton payloads nest the real user text under:
 * result.output.summary | last_stdout | result.output.result.message
 */
export function pickAutomatonUserFacingText(payload: Record<string, unknown>): string {
  const result = asRecord(payload.result) ?? payload;
  const output = asRecord(result.output) ?? {};
  const deep = asRecord(output.result) ?? asRecord(result.result) ?? result;

  const events = Array.isArray(result.progress_events)
    ? (result.progress_events as Record<string, unknown>[])
    : [];
  const lastEvent = events.length ? events[events.length - 1] : null;
  const eventStdout = lastEvent ? nonEmptyString(lastEvent.stdout) : '';

  return stripAutomatonEngineStatus(
    nonEmptyString(output.summary)
    || nonEmptyString(output.last_stdout)
    || nonEmptyString(deep.message)
    || nonEmptyString(deep.summary)
    || nonEmptyString(payload.user_message)
    || nonEmptyString(result.stdout)
    || eventStdout
    || '',
  );
}

/** Deep business result node for fact bullets (qty, stock_label, …). */
export function pickAutomatonDeepResult(payload: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(payload.result) ?? payload;
  const output = asRecord(result.output) ?? {};
  return asRecord(output.result) ?? asRecord(result.result) ?? result;
}

function formatFactBullets(deep: Record<string, unknown>): string[] {
  const facts: Array<[string, unknown]> = [
    ['조회상태', deep.status],
    ['스탁', deep.stock_label ?? deep.stock_key],
    ['수량', deep.qty],
    ['SKU', deep.form_fields && asRecord(deep.form_fields)?.SKU],
    ['재고위치', deep.form_fields && asRecord(deep.form_fields)?.['재고위치']],
    ['출처', deep.source],
    ['기준일', deep.matched_date],
  ];
  const lines: string[] = [];
  for (const [label, raw] of facts) {
    if (raw == null || raw === '') continue;
    const s = String(raw).trim();
    if (!s || s === 'success' || s === 'ok' || s === 'completed') continue;
    lines.push(`- **${label}:** ${s}`);
  }
  // inven_SKU from row if present
  const row = asRecord(deep.row);
  const inven = row?.inven_SKU ?? row?.['인벤SKU'];
  if (inven != null && String(inven).trim()) {
    lines.push(`- **인벤SKU:** ${String(inven).trim()}`);
  }
  return lines;
}

function formatArtifactPaths(result: Record<string, unknown>): string[] {
  const arts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const lines: string[] = [];
  for (const a of arts) {
    const rec = asRecord(a);
    if (!rec) continue;
    const name = nonEmptyString(rec.name, 80) || 'artifact';
    const p = nonEmptyString(rec.path, 400) || nonEmptyString(rec.url, 400);
    if (p) lines.push(`- ${name}: \`${p}\``);
  }
  return lines;
}

export function formatAutomatonEnvelope(
  toolId: string,
  envelope: Record<string, unknown>,
): string {
  const status = String(envelope.status ?? 'unknown');

  if (status === 'integrity_failed') {
    const integrity = envelope.integrity as { messages?: string[] } | undefined;
    const lines = integrity?.messages?.filter((m) => m.startsWith('FAIL')) ?? [];
    return [
      '**무결성 검증 실패** — direct command 실행이 차단되었습니다.',
      '',
      `command: \`${toolId}\``,
      ...lines.map((l) => `- ${l}`),
      '',
      'automaton 코드 변경 후 `direct_command_integrity.json` 해시를 갱신하세요.',
    ].join('\n');
  }

  if (status === 'mcp_transport_error') {
    return [
      '**MCP 연결 오류**',
      '',
      String(envelope.message ?? 'unknown transport error'),
      '',
      '확인: `LIVE_AUTOMATON_ROOT`, `.venv`, `pip install -r requirements-mcp.txt`',
      '(Python 3.14: `pyarrow>=24` wheel 필요 — `requirements-direct-commands.txt` 참고)',
      '반품 분석은 수 분~수십 분 걸릴 수 있습니다.',
    ].join('\n');
  }

  const result = asRecord(envelope.result) ?? {};
  const nested = asRecord(result.result) ?? result;
  const deep = pickAutomatonDeepResult(envelope);
  const narrative = pickAutomatonUserFacingText(envelope);

  const excel = nested.excel_file ?? result.excel_file ?? deep.excel_file;
  const outputPath =
    envelope.json_output_path
    ?? deep.json_output
    ?? nested.json_output_path
    ?? nested.output_path;

  const deepStatus = nonEmptyString(deep.status, 80);
  const titleStatus =
    deepStatus && deepStatus !== 'success' && deepStatus !== 'ok'
      ? deepStatus
      : status === 'completed' || status === 'success' || status === 'ok'
        ? (deepStatus || 'ok')
        : status;

  const lines = [
    `**my_live_automaton 실행 완료** (\`${toolId}\`)`,
    '',
    `- status: **${titleStatus}**`,
  ];

  if (excel) lines.push(`- excel: \`${String(excel)}\``);
  if (outputPath) lines.push(`- json: \`${String(outputPath)}\``);
  if (envelope.reason_code) lines.push(`- reason: ${String(envelope.reason_code)}`);
  const factLines = formatFactBullets(deep);
  if (factLines.length) {
    lines.push('', ...factLines);
  }

  const artLines = formatArtifactPaths(result);
  if (artLines.length) {
    lines.push('', '**산출물**', ...artLines);
  }

  if (narrative) {
    lines.push('', '### 결과', '', narrative);
  }

  const missing = (result.missing_modules ?? nested.missing_modules ?? deep.missing_modules) as
    | string[]
    | undefined;
  const fixHint = result.fix_hint ?? nested.fix_hint ?? deep.fix_hint;
  if (envelope.reason_code === 'DIRECT_COMMAND_MISSING_MODULE' || missing?.length) {
    if (missing?.length) {
      lines.push(`- missing: ${missing.map((m) => `\`${m}\``).join(', ')}`);
    }
    if (fixHint) {
      lines.push('', '**설치:**', '```', String(fixHint), '```');
    }
  }

  if (envelope.stderr) {
    lines.push('', '```', String(envelope.stderr).slice(-1500), '```');
  }

  // Bare success with no narrative — tell user the payload lacked body fields.
  if (!narrative && !excel && !outputPath && factLines.length === 0 && artLines.length === 0) {
    lines.push(
      '',
      '_어댑터 응답에 요약/재고 본문이 없습니다. OpenClaw command stdout·summary를 확인해 주세요._',
    );
  }

  return lines.join('\n');
}

const AUTOMATON_QUIET_STATUSES = new Set([
  'ok',
  'success',
  'completed',
  'accepted',
  'queued',
  'running',
]);

/**
 * Background slash jobs ACK immediately. Chat must still get a follow-up when
 * the adapter failed, or when NOPSPro 쪽지 has no recipient.
 */
export function automatonBackgroundNeedsChatFollowUp(
  envelope: Record<string, unknown> | undefined,
  nopsUserId?: string,
): boolean {
  const status = String(envelope?.status ?? '').trim().toLowerCase();
  if (!status || !AUTOMATON_QUIET_STATUSES.has(status)) return true;
  return !String(nopsUserId ?? '').trim();
}
