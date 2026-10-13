import path from 'node:path';

/** Literal Windows/UNC targets for approval UX, not a shell sandbox/parser. */
export function terminalAbsolutePaths(command: string): string[] {
  const paths: string[] = [];
  const pattern = /(["'])((?:[A-Za-z]:[\\/]|\\\\)[^"'\r\n]+)\1|((?:\b[A-Za-z]:[\\/]|\\\\)[^\s"'`;|&()<> ,}\]]+)/g;
  for (const match of command.matchAll(pattern)) {
    const target = match[2] ?? match[3];
    if (target) paths.push(path.win32.normalize(target));
  }
  return [...new Set(paths)];
}

export function externalTerminalPaths(command: string, workspaceRoot: string): string[] {
  return terminalAbsolutePaths(command).filter((target) => {
    const rel = path.win32.relative(workspaceRoot, target);
    return rel === '..' || rel.startsWith('..\\') || path.win32.isAbsolute(rel);
  });
}
