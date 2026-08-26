import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundleEntry {
  api_key: string;
  base_url?: string;
  model_id?: string;
}

export interface BundlePayload {
  v: 1;
  org_id: string;
  default_provider_id: string | null;
  entries: Record<string, BundleEntry>;
}

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function publicKeyFingerprint(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pemPath = path.join(here, '..', 'config', 'defaults', 'license-public.pem');
  const pem = readFileSync(pemPath, 'utf8');
  return createHash('sha256').update(pem).digest('hex');
}

export function deriveBundleKey(orgId: string): Buffer {
  return createHash('sha256')
    .update(orgId, 'utf8')
    .update('\0')
    .update(publicKeyFingerprint(), 'utf8')
    .update('\0cqr-pa-bundle-v1')
    .digest();
}

export function encryptBundle(payload: BundlePayload): string {
  const plain = JSON.stringify(payload);
  const iv = randomBytes(IV_LEN);
  const key = deriveBundleKey(payload.org_id);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptBundle(blob: string, orgId: string): BundlePayload {
  const buf = Buffer.from(blob.trim(), 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const data = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, deriveBundleKey(orgId), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const doc = JSON.parse(plain) as BundlePayload;
  if (doc.v !== 1 || doc.org_id !== orgId) {
    throw new Error('BUNDLE_ORG_MISMATCH');
  }
  return doc;
}

export function parseBundleFile(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const doc = JSON.parse(trimmed) as { enc?: string; data?: string };
    if (doc.enc) return doc.enc;
    if (doc.data) return doc.data;
  }
  return trimmed;
}
