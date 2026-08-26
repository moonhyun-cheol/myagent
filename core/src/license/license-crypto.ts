import { sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicensePayload } from './types.js';
import { canonicalizePayload } from './license-format.js';

function resolvePublicKeyPem(explicitPath?: string): string {
  if (explicitPath) {
    return readFileSync(explicitPath, 'utf8');
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'config', 'defaults', 'license-public.pem'),
    path.join(here, 'config', 'defaults', 'license-public.pem'),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error('license-public.pem not found');
}

export function verifyLicenseSignature(
  payload: LicensePayload,
  sigBase64: string,
  publicKeyPem?: string,
): boolean {
  const pem = publicKeyPem ?? resolvePublicKeyPem();
  const data = Buffer.from(canonicalizePayload(payload));
  const sig = Buffer.from(sigBase64, 'base64');
  return verify(null, data, pem, sig);
}

export function signLicensePayload(payload: LicensePayload, privateKeyPem: string): string {
  const data = Buffer.from(canonicalizePayload(payload));
  const sig = sign(null, data, privateKeyPem);
  return sig.toString('base64');
}
