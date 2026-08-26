import path from 'node:path';
import { SecurityError } from './errors.js';

export { SecurityError } from './errors.js';

function normalize(target: string): string {
  return target.replace(/\//g, '\\').toLowerCase();
}

export function isNasPath(target: string): boolean {
  const n = normalize(target);
  return n.startsWith('\\\\nas') || n.startsWith('\\\\nas3');
}

export function getCqrRoot(): string {
  const root = process.env.MY_AGENT_ROOT;
  if (!root?.trim()) {
    throw new Error('MY_AGENT_ROOT is not set');
  }
  return root;
}

export function assertWritablePath(target: string, cqrRoot?: string): void {
  const root = cqrRoot ?? getCqrRoot();
  const resolved = path.resolve(target);
  const rootResolved = path.resolve(root);

  if (isNasPath(resolved)) {
    throw new SecurityError('NAS_WRITE_FORBIDDEN', `NAS paths are forbidden: ${target}`);
  }

  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Path outside MY_AGENT_ROOT: ${target}`);
  }
}

export function assertPathUnder(baseDir: string, target: string): void {
  const resolved = path.resolve(target);
  const base = path.resolve(baseDir);

  if (isNasPath(resolved)) {
    throw new SecurityError('NAS_WRITE_FORBIDDEN', `NAS paths are forbidden: ${target}`);
  }

  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SecurityError('OUTSIDE_MY_AGENT_ROOT', `Path outside allowed base: ${target}`);
  }
}
