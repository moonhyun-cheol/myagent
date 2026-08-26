import { createHash } from 'node:crypto';
import os from 'node:os';
import { computeMachineId } from '../license/machine-id.js';

/** Legacy portable machine id. Read-only migration input; never used for new encrypts. */
export function computePortableVaultMachineId(): string {
  return createHash('sha256')
    .update(os.hostname(), 'utf8')
    .update('\0')
    .update(os.userInfo().username, 'utf8')
    .update('\0cqr-pa-provider-v2')
    .digest('hex');
}

/** Legacy ids to try only when decrypting pre-envelope vault files. */
export function vaultMachineIds(cqrRoot: string): string[] {
  const portable = computePortableVaultMachineId();
  const legacy = computeMachineId(cqrRoot);
  return portable === legacy ? [portable] : [portable, legacy];
}
