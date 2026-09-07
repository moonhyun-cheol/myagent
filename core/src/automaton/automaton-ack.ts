/** Chat acknowledgement for an organization automation dispatched in background. */

export function hasRunnableAutomatonArg(command: string): boolean {
  return /^\/\S+\s+\S+/.test(command.trim());
}

export function buildAutomatonAckContent(
  commandText: string,
  toolId?: string,
  _opts?: { nopsUserId?: string },
): string {
  const cmd = commandText.trim() || (toolId ? `/${toolId}` : '');
  const shown = cmd || '(명령)';
  // Do not assert NOPSPro recipient at accept time — Adapter reports delivery_status later.
  return [
    `접수: \`${shown}\``,
    '',
    '중앙 허브에서 백그라운드로 실행합니다.',
    '완료 알림과 결과 파일 경로는 Adapter가 사용 가능한 전달 경로로 보냅니다.',
  ].join('\n');
}
