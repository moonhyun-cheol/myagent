/**
 * Bind the agent cwd to the session's work folder.
 * The runtime never narrows the root from message wording or folder-name scoring;
 * the model works inside the bound folder and chooses paths itself.
 */
import path from 'node:path';

export type WorkspaceLockStatus = 'session';

export type WorkspaceLock = {
  sessionRoot: string;
  targetRoot: string;
  status: WorkspaceLockStatus;
};

export function formatWorkspaceLockNote(lock: WorkspaceLock): string {
  return [
    '[WORKSPACE_LOCK]',
    `target=${path.resolve(lock.targetRoot)}`,
    `session_root=${path.resolve(lock.sessionRoot)}`,
    `status=${lock.status}`,
  ].join('\n');
}

export function resolveTurnWorkspaceLock(opts: { sessionRoot: string }): WorkspaceLock {
  const sessionRoot = path.resolve(opts.sessionRoot);
  return { sessionRoot, targetRoot: sessionRoot, status: 'session' };
}
