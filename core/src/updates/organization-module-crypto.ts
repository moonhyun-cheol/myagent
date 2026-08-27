import { constants as cryptoConstants, createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MODULE_SIGNATURE_ALGORITHM = 'RSA-PSS-SHA256';
export const MODULE_PAYLOAD_SCHEMA = 'my-agent-module-payload/v1';
export const MODULE_FEED_SCHEMA = 'my-agent-module-feed/v1';
export const MODULE_INSTALL_ROOT = 'modules/organization';

export class OrganizationModuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationModuleError';
  }
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalValue(value: unknown): CanonicalJson {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => {
          const child = record[key];
          if (child === undefined) {
            throw new OrganizationModuleError('MODULE_JSON', `undefined is not canonical JSON: ${key}`);
          }
          return [key, canonicalValue(child)];
        }),
    );
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new OrganizationModuleError('MODULE_JSON', `unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Bytes(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(filePath: string): string {
  return sha256Bytes(readFileSync(filePath));
}

export function assertHexSha256(value: string, label: string): string {
  const hex = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new OrganizationModuleError('MODULE_HASH', `${label} must be SHA-256 hex.`);
  }
  return hex;
}

export interface SignedEnvelope {
  algorithm: string;
  document: unknown;
  signature: string;
}

export function createSignedEnvelope(document: unknown, privateKeyPem: string): SignedEnvelope {
  const canonical = Buffer.from(canonicalJson(document), 'utf8');
  return {
    algorithm: MODULE_SIGNATURE_ALGORITHM,
    document,
    signature: cryptoSign('sha256', canonical, {
      key: privateKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString('base64'),
  };
}

export function verifySignedEnvelope(envelope: SignedEnvelope, publicKeyPem: string): boolean {
  if (
    !envelope
    || envelope.algorithm !== MODULE_SIGNATURE_ALGORITHM
    || envelope.document == null
    || typeof envelope.signature !== 'string'
  ) {
    return false;
  }
  try {
    return cryptoVerify(
      'sha256',
      Buffer.from(canonicalJson(envelope.document), 'utf8'),
      {
        key: publicKeyPem,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(envelope.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function parseSignedEnvelope(raw: Buffer | string): SignedEnvelope {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrganizationModuleError('MODULE_ENVELOPE', 'Signed envelope is not JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new OrganizationModuleError('MODULE_ENVELOPE', 'Signed envelope is invalid.');
  }
  const envelope = parsed as SignedEnvelope;
  if (typeof envelope.algorithm !== 'string' || typeof envelope.signature !== 'string') {
    throw new OrganizationModuleError('MODULE_ENVELOPE', 'Signed envelope fields are missing.');
  }
  return envelope;
}

const PROTECTED_ROOTS = new Set(['.git', 'data', 'logs', 'runtime']);

export function normalizeModulePath(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw new OrganizationModuleError('MODULE_PATH', 'Managed path must be non-empty.');
  }
  const normalized = input.replaceAll('\\', '/');
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new OrganizationModuleError('MODULE_PATH', `Unsafe update path: ${input}`);
  }
  const root = normalized.split('/')[0].toLowerCase();
  if (PROTECTED_ROOTS.has(root)) {
    throw new OrganizationModuleError('MODULE_PATH', `Protected update path: ${input}`);
  }
  return normalized;
}

export function assertPayloadPathAllowed(relative: string): string {
  const safe = normalizeModulePath(relative);
  if (safe === 'update-payload.json') return safe;
  if (!safe.startsWith(`${MODULE_INSTALL_ROOT}/`)) {
    throw new OrganizationModuleError(
      'MODULE_PATH_SCOPE',
      `Payload path must be under ${MODULE_INSTALL_ROOT}: ${safe}`,
    );
  }
  return safe;
}

export function parseVersionTuple(version: string): [number, number, number] {
  const match = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function productVersionMeets(installed: string, required: string): boolean {
  const a = parseVersionTuple(installed);
  const b = parseVersionTuple(required);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}
