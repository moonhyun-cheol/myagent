/** Chat acknowledgement for an organization automation dispatched in background. */
import type { AutomatonResponseContract } from './tool-catalog.js';

export function hasRunnableAutomatonArg(command: string): boolean {
  return /^\/\S+\s+\S+/.test(command.trim());
}

function commaBatchCount(commandText: string): number {
  const args = commandText.trim().replace(/^\/\S+\s*/, '').trim();
  if (!args.includes(',')) return 1;
  return args.split(',').map((part) => part.trim()).filter(Boolean).length || 1;
}

export function formatUnsupportedAutomatonBatch(
  commandText: string,
  response: AutomatonResponseContract | undefined,
): string | null {
  if (response?.batch?.supported !== false || commaBatchCount(commandText) <= 1) return null;
  const label = response.batch.label_ko?.trim() || '명령';
  return `${label}: 이 명령은 쉼표(,) 배치 입력을 지원하지 않습니다. 한 번에 하나씩 요청하세요.`;
}

export function buildAutomatonAckContent(
  commandText: string,
  toolId?: string,
  opts?: {
    nopsUserId?: string;
    requestId?: string;
    response?: AutomatonResponseContract;
    /** Korean task label (manifest response.label_ko → description_ko). */
    label?: string;
  },
): string {
  const requestId = opts?.requestId?.trim() || 'unknown';
  const info: AutomatonFrameInfo = {
    label: resolveAutomatonLabel(toolId, opts?.response, opts?.label),
    commandText,
    requestId,
  };
  const lines = [frameHeader(info, '접수')];
  const batch = opts?.response?.batch;
  const count = batch?.supported ? commaBatchCount(commandText) : 1;
  if (batch?.supported && count > 1) {
    const cap = batch.cap == null ? '무제한' : `${batch.cap}건`;
    lines.push(`- 처리 건수: ${count}건 일괄 실행 (상한 ${cap})`);
    const hint = opts?.response?.ack?.batch_time_hint?.trim();
    if (hint) lines.push(`- 예상 소요: ${hint}`);
  }
  lines.push(
    `- 요청 번호: \`${requestId}\``,
    '',
    '백그라운드에서 실행합니다. 진행 상황과 결과는 이 대화에 표시됩니다.',
  );
  return lines.join('\n');
}

/** Fixed identity shown on every message of one background command (no model wording). */
export interface AutomatonFrameInfo {
  label: string;
  commandText: string;
  requestId: string;
}

export function resolveAutomatonLabel(
  toolId: string | undefined,
  response?: AutomatonResponseContract,
  descriptionKo?: string,
): string {
  return response?.label_ko?.trim() || descriptionKo?.trim() || toolId?.trim() || '업무 명령';
}

function frameHeader(info: AutomatonFrameInfo, state: string): string {
  const command = info.commandText.trim().replace(/`/g, "'") || '(명령)';
  return `**${info.label} ${state}** (\`${command}\`)`;
}

function asBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('- ') ? line : `- ${line}`));
}

/** Progress update: replaces the ACK in place. statusText lines become bullets. */
export function formatAutomatonProgressFrame(info: AutomatonFrameInfo, statusText: string): string {
  return [
    frameHeader(info, '진행 중'),
    ...asBullets(statusText),
    `- 요청 번호: \`${info.requestId}\``,
  ].join('\n');
}

/** Final success message. body comes verbatim from the manifest response renderer. */
export function formatAutomatonCompletedFrame(info: AutomatonFrameInfo, body: string): string {
  return [
    frameHeader(info, '완료'),
    '',
    body.trim() || '- 상태: 완료',
    '',
    `요청 번호: \`${info.requestId}\``,
  ].join('\n');
}

/** Final failure message. body is the deterministic error renderer output. */
export function formatAutomatonFailedFrame(info: AutomatonFrameInfo, body: string): string {
  return [
    frameHeader(info, '실패'),
    '',
    body.trim() || '- 상태: 실패',
    '',
    `요청 번호: \`${info.requestId}\``,
  ].join('\n');
}
