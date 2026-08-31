/** Chat acknowledgement for an organization automation dispatched in background. */

export function hasRunnableAutomatonArg(command: string): boolean {
  return /^\/\S+\s+\S+/.test(command.trim());
}

export function buildAutomatonAckContent(
  commandText: string,
  toolId?: string,
  opts?: { nopsUserId?: string },
): string {
  const cmd = commandText.trim() || (toolId ? `/${toolId}` : '');
  const shown = cmd || '(명령)';
  const nops = String(opts?.nopsUserId ?? '').trim();
  if (!nops) {
    return [
      `접수: \`${shown}\``,
      '',
      '백그라운드에서 실행합니다.',
      '**쪽지 수신자를 찾지 못했습니다.** NOPSPro 로그인 계정이 확인되면 쪽지로, 아니면 실행 결과를 이 대화에 남깁니다.',
    ].join('\n');
  }
  return [
    `접수: \`${shown}\``,
    '',
    '백그라운드에서 실행합니다. **회신은 놉스 프로 쪽지**입니다.',
  ].join('\n');
}
