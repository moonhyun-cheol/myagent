import os from 'node:os';
import type { NasWriteConsent, UserOverrides } from '../config/user-overrides.js';
import { isNasPath } from './path-guard.js';
import { SecurityError } from './errors.js';

export function hasNasWriteConsent(overrides: UserOverrides): boolean {
  return overrides.nas_write_consent?.enabled === true;
}

export function buildNasWriteConsent(enabled: boolean): NasWriteConsent | undefined {
  if (!enabled) return undefined;
  return {
    enabled: true,
    approved_at: new Date().toISOString(),
    approved_by: os.userInfo().username,
  };
}

export function assertNasWriteAllowed(target: string, allowNas: boolean): void {
  if (!isNasPath(target)) return;
  if (!allowNas) {
    throw new SecurityError(
      'NAS_CONSENT_REQUIRED',
      'NAS 경로(\\\\nas, \\\\nas3)에 쓰려면 먼저 사용 허가가 필요합니다.',
    );
  }
}
