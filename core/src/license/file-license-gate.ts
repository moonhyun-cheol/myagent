import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type {
  ILicenseGate,
  LicenseFeature,
  LicenseStatus,
} from './types.js';
import { ALL_LICENSE_FEATURES, LicenseGateError } from './types.js';
import { parseSignedLicense } from './license-format.js';
import { verifyLicenseSignature } from './license-crypto.js';
import { computeMachineId } from './machine-id.js';
import { computeWindowsUserId } from './windows-user-id.js';
import { checkLicenseBinding } from './activation.js';
import { isLicenseEnforcementEnabled } from './license-enforcement.js';
import { resolveCqrRoot } from '../bootstrap.js';

function readOnly(reason: string, partial?: Partial<LicenseStatus>): LicenseStatus {
  return {
    mode: 'read_only',
    valid: false,
    reason,
    features: [],
    enforced: true,
    ...partial,
  };
}

function openAccess(): LicenseStatus {
  return {
    mode: 'full',
    valid: true,
    features: [...ALL_LICENSE_FEATURES],
    org_id: 'open',
    enforced: false,
  };
}

export class FileLicenseGate implements ILicenseGate {
  private status: LicenseStatus;

  constructor(
    private readonly vaultDir: string,
    private readonly cqrRoot: string = resolveCqrRoot(),
  ) {
    this.status = this.load();
  }

  reload(): LicenseStatus {
    this.status = this.load();
    return this.status;
  }

  private load(): LicenseStatus {
    if (!isLicenseEnforcementEnabled(this.cqrRoot)) {
      return openAccess();
    }

    const licensePath = path.join(this.vaultDir, 'license.ocx');
    if (!existsSync(licensePath)) {
      return readOnly('LICENSE_MISSING');
    }

    const raw = readFileSync(licensePath, 'utf8');
    const doc = parseSignedLicense(raw);
    if (!doc) {
      return readOnly('LICENSE_INVALID');
    }

    if (!verifyLicenseSignature(doc.payload, doc.sig)) {
      return readOnly('LICENSE_SIGNATURE_INVALID', { org_id: doc.payload.org_id });
    }

    const expires = new Date(doc.payload.expires_at);
    if (Number.isNaN(expires.getTime()) || expires < new Date()) {
      return readOnly('LICENSE_EXPIRED', {
        org_id: doc.payload.org_id,
        expires_at: doc.payload.expires_at,
      });
    }

    const machineId = computeMachineId(this.cqrRoot);
    const userId = computeWindowsUserId();
    const binding = checkLicenseBinding(
      this.vaultDir,
      this.cqrRoot,
      doc.payload.org_id,
      {
        user_hint: doc.payload.user_hint,
        machine_hint: doc.payload.machine_hint,
      },
      { userId, machineId },
    );
    if (!binding.ok) {
      return readOnly(binding.reason, {
        org_id: doc.payload.org_id,
        expires_at: doc.payload.expires_at,
      });
    }

    return {
      mode: 'full',
      valid: true,
      features: doc.payload.features,
      org_id: doc.payload.org_id,
      expires_at: doc.payload.expires_at,
      enforced: true,
    };
  }

  getStatus(): LicenseStatus {
    return this.status;
  }

  assertWritable(): void {
    if (this.status.mode !== 'full') {
      throw new LicenseGateError(
        this.status.reason ?? 'License required — read-only mode',
        this.status.reason ?? 'LICENSE_READ_ONLY',
      );
    }
  }

  assertFeature(feature: LicenseFeature): void {
    this.assertWritable();
    if (!this.status.features.includes(feature)) {
      throw new LicenseGateError(`Feature not licensed: ${feature}`);
    }
  }

  hasFeature(feature: LicenseFeature): boolean {
    return this.status.mode === 'full' && this.status.features.includes(feature);
  }
}
