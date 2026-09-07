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
  return [`접수: \`${shown}\``, '', '상태: **명령어 접수**'].join('\n');
}
