/** Chat acknowledgement for an organization automation dispatched in background. */

export function hasRunnableAutomatonArg(command: string): boolean {
  return /^\/\S+\s+\S+/.test(command.trim());
}

export function buildAutomatonAckContent(commandText: string, toolId?: string): string {
  const cmd = commandText.trim() || (toolId ? `/${toolId}` : '');
  const shown = cmd || '(명령)';
  return [
    `접수: \`${shown}\``,
    '',
    '백그라운드에서 실행합니다. **회신은 놉스 프로 쪽지**입니다.',
  ].join('\n');
}
