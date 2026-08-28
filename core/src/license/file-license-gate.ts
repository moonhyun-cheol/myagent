import type { ILicenseGate, LicenseFeature, LicenseStatus } from './types.js';

const ALL_FEATURES: LicenseFeature[] = [
  'chat',
  'manager',
  'local_models',
  'image_generation',
  'deep_research',
  'local_image',
  'web_dev',
  'browser_automation',
];

const FULL_STATUS: LicenseStatus = {
  mode: 'full',
  valid: true,
  features: ALL_FEATURES,
  org_id: 'dev',
};

/** License files are retired — product access is always full. */
export class FileLicenseGate implements ILicenseGate {
  constructor(_vaultDir?: string, _cqrRoot?: string) {
    void _vaultDir;
    void _cqrRoot;
  }
  getStatus(): LicenseStatus {
    return FULL_STATUS;
  }

  reload(): LicenseStatus {
    return FULL_STATUS;
  }

  assertWritable(): void {
    /* no-op */
  }

  assertFeature(_feature: LicenseFeature): void {
    /* no-op */
  }

  hasFeature(_feature: LicenseFeature): boolean {
    return true;
  }
}
