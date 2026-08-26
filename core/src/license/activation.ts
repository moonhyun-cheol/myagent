import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import path from 'node:path';

import { assertWritablePath } from '../security/path-guard.js';



export interface ActivationRecord {

  user_id?: string;

  machine_id?: string;

  activated_at: string;

  org_id: string;

}



export function readActivation(vaultDir: string): ActivationRecord | null {

  const p = path.join(vaultDir, 'activation.json');

  if (!existsSync(p)) return null;

  try {

    return JSON.parse(readFileSync(p, 'utf8')) as ActivationRecord;

  } catch {

    return null;

  }

}



export function writeActivation(

  vaultDir: string,

  record: ActivationRecord,

  cqrRoot: string,

): void {

  const p = path.join(vaultDir, 'activation.json');

  assertWritablePath(p, cqrRoot);

  writeFileSync(p, JSON.stringify(record, null, 2) + '\n', 'utf8');

}



export function checkLicenseBinding(

  vaultDir: string,

  cqrRoot: string,

  orgId: string,

  hints: { user_hint?: string | null; machine_hint?: string | null },

  current: { userId: string; machineId: string },

): { ok: true } | { ok: false; reason: string } {

  const hasUser = Boolean(hints.user_hint);

  const hasMachine = Boolean(hints.machine_hint);



  if (hasUser && hints.user_hint !== current.userId) {

    return { ok: false, reason: 'LICENSE_USER_MISMATCH' };

  }

  if (hasMachine && hints.machine_hint !== current.machineId) {

    return { ok: false, reason: 'LICENSE_MACHINE_MISMATCH' };

  }



  if (!hasUser && !hasMachine) {

    return { ok: true };

  }



  const activation = readActivation(vaultDir);

  if (!activation) {

    writeActivation(

      vaultDir,

      {

        user_id: hasUser ? current.userId : undefined,

        machine_id: hasMachine ? current.machineId : undefined,

        activated_at: new Date().toISOString(),

        org_id: orgId,

      },

      cqrRoot,

    );

    return { ok: true };

  }



  if (hasUser && activation.user_id && activation.user_id !== current.userId) {

    return { ok: false, reason: 'LICENSE_USER_MISMATCH' };

  }

  if (hasMachine && activation.machine_id && activation.machine_id !== current.machineId) {

    return { ok: false, reason: 'LICENSE_MACHINE_MISMATCH' };

  }



  return { ok: true };

}



/** @deprecated use checkLicenseBinding */

export function checkMachineBinding(

  vaultDir: string,

  cqrRoot: string,

  orgId: string,

  machineHint: string | null | undefined,

  currentMachineId: string,

): { ok: true } | { ok: false; reason: string } {

  return checkLicenseBinding(

    vaultDir,

    cqrRoot,

    orgId,

    { machine_hint: machineHint },

    { userId: '', machineId: currentMachineId },

  );

}


