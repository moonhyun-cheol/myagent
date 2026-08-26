import { createHash } from 'node:crypto';
import os from 'node:os';

/** Deterministic machine fingerprint (no NAS, local only). */
export function computeMachineId(cqrRoot: string): string {
  return createHash('sha256')
    .update(os.hostname(), 'utf8')
    .update('\0')
    .update(os.userInfo().username, 'utf8')
    .update('\0')
    .update(cqrRoot, 'utf8')
    .digest('hex');
}
