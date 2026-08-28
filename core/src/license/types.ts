export type LicenseFeature =
  | 'manager'
  | 'local_models'
  | 'local_image'
  | 'image_generation'
  | 'deep_research'
  | 'web_dev'
  | 'browser_automation'
  | 'chat';

export type LicenseMode = 'full';

export interface LicenseStatus {
  mode: LicenseMode;
  valid: boolean;
  features: LicenseFeature[];
  org_id?: string;
}

export interface ILicenseGate {
  getStatus(): LicenseStatus;
  reload(): LicenseStatus;
  assertWritable(): void;
  assertFeature(feature: LicenseFeature): void;
  hasFeature(feature: LicenseFeature): boolean;
}
