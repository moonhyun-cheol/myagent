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
  },
): string {
  const commandId = opts?.response?.ack?.command_id?.trim() || toolId?.trim() || 'unknown';
  const requestId = opts?.requestId?.trim() || 'unknown';
  const lines = [
    '처리 접수 완료',
    `- command: ${commandId}`,
  ];
  const batch = opts?.response?.batch;
  const count = batch?.supported ? commaBatchCount(commandText) : 1;
  if (batch?.supported && count > 1) {
    const cap = batch.cap == null ? '무제한' : `${batch.cap}건`;
    lines.push(`- batch: ${count}건 (한 번에 실행, 상한 ${cap})`);
    const hint = opts?.response?.ack?.batch_time_hint?.trim();
    if (hint) lines.push(`- ${count}건 배치 접수 · 완료까지 ${hint} 소요될 수 있습니다.`);
  }
  lines.push(
    `- request_id: \`${requestId}\``,
    '작업이 길어질 수 있어 백그라운드에서 실행합니다.',
    '결과가 준비되면 이 채널로 안내됩니다.',
  );
  return lines.join('\n');
}
