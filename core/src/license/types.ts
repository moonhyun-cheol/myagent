export type LicenseFeature =
  | 'manager'
  | 'local_models'
  | 'local_image'
  | 'image_generation'
  | 'deep_research'
  | 'web_dev'
  | 'browser_automation'
  | 'chat';

export const ALL_LICENSE_FEATURES: LicenseFeature[] = [
  'chat',
  'manager',
  'local_models',
  'local_image',
  'image_generation',
  'deep_research',
  'web_dev',
  'browser_automation',
];

export type LicenseMode = 'full' | 'read_only';

export interface LicensePayload {
  v: number;
  org_id: string;
  features: LicenseFeature[];
  issued_at: string;
  expires_at: string;
  machine_hint?: string | null;
  /** AD account binding: DOMAIN\\user */
  user_hint?: string | null;
  nonce?: string;
}

export interface LicenseStatus {
  mode: LicenseMode;
  valid: boolean;
  reason?: string;
  features: LicenseFeature[];
  org_id?: string;
  expires_at?: string;
  /** False when file-license checks are disabled (default). */
  enforced?: boolean;
}

export class LicenseGateError extends Error {
  readonly httpStatus = 403;
  readonly code: string;

  constructor(message = 'License required — read-only mode', code = 'LICENSE_READ_ONLY') {
    super(message);
    this.name = 'LicenseGateError';
    this.code = code;
  }
}

export interface ILicenseGate {
  getStatus(): LicenseStatus;
  assertWritable(): void;
  assertFeature(feature: LicenseFeature): void;
  hasFeature(feature: LicenseFeature): boolean;
}
