import type { LicensePayload } from './types.js';

export interface SignedLicenseFile {
  payload: LicensePayload;
  sig: string;
}

/** Stable JSON string for Ed25519 signing (sorted feature list, fixed key order). */
export function canonicalizePayload(payload: LicensePayload): string {
  const body: Record<string, unknown> = {
    v: payload.v,
    org_id: payload.org_id,
    features: [...payload.features].sort(),
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    machine_hint: payload.machine_hint ?? null,
  };
  if (payload.user_hint != null && payload.user_hint !== '') {
    body.user_hint = payload.user_hint;
  }
  if (payload.nonce != null && payload.nonce !== '') {
    body.nonce = payload.nonce;
  }
  return JSON.stringify(body);
}

export function parseSignedLicense(raw: string): SignedLicenseFile | null {
  try {
    const doc = JSON.parse(raw.trim()) as SignedLicenseFile;
    if (!doc?.payload || typeof doc.sig !== 'string') {
      return null;
    }
    const p = doc.payload;
    if (p.v !== 1 || !p.org_id || !Array.isArray(p.features)) {
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}

export function buildSignedLicense(payload: LicensePayload, sigBase64: string): SignedLicenseFile {
  return { payload, sig: sigBase64 };
}

export function serializeLicense(doc: SignedLicenseFile): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
