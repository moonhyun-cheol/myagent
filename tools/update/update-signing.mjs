import {
  constants as cryptoConstants,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

export const UPDATE_SIGNATURE_ALGORITHM = 'RSA-PSS-SHA256';
export const UPDATE_PAYLOAD_SCHEMA = 'cqr-pa-update-payload/v1';
export const UPDATE_FEED_SCHEMA = 'cqr-pa-update-feed/v1';

const PROTECTED_ROOTS = new Set(['.git', 'data', 'logs', 'runtime']);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          const child = value[key];
          if (child === undefined) throw new Error(`undefined is not canonical JSON: ${key}`);
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
  throw new Error(`unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function normalizeUpdatePath(input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw new Error('update path must be a non-empty string');
  }
  const normalized = input.replaceAll('\\', '/');
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe update path: ${input}`);
  }
  const root = normalized.split('/')[0].toLowerCase();
  if (PROTECTED_ROOTS.has(root)) {
    throw new Error(`protected update path: ${input}`);
  }
  return normalized;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function walkManagedFiles(rootDir, relativeDir = '') {
  const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  const result = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const nativeRelative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const absolute = path.join(rootDir, nativeRelative);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`update payload cannot contain symlink/reparse entry: ${nativeRelative}`);
    }
    if (entry.isDirectory()) {
      result.push(...walkManagedFiles(rootDir, nativeRelative));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`update payload contains unsupported entry: ${nativeRelative}`);
    }
    result.push({
      path: normalizeUpdatePath(nativeRelative),
      size: info.size,
      sha256: sha256File(absolute),
    });
  }
  return result;
}

function assertHexSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
}

export function assertPayloadManifest(document) {
  if (!document || document.schema !== UPDATE_PAYLOAD_SCHEMA) {
    throw new Error('unsupported update payload schema');
  }
  if (!Number.isSafeInteger(document.update_sequence) || document.update_sequence < 1) {
    throw new Error('update_sequence must be a positive safe integer');
  }
  if (!Number.isSafeInteger(document.minimum_supported_sequence) || document.minimum_supported_sequence < 1) {
    throw new Error('minimum_supported_sequence must be a positive safe integer');
  }
  if (document.minimum_supported_sequence > document.update_sequence) {
    throw new Error('minimum_supported_sequence cannot exceed update_sequence');
  }
  if (typeof document.version !== 'string' || !document.version.trim()) {
    throw new Error('version is required');
  }
  if (typeof document.channel !== 'string' || !/^[a-z0-9-]+$/.test(document.channel)) {
    throw new Error('channel must use lowercase letters, numbers, and hyphens');
  }
  if (!Array.isArray(document.files) || document.files.length === 0) {
    throw new Error('payload files are required');
  }
  const seen = new Set();
  for (const file of document.files) {
    const safePath = normalizeUpdatePath(file?.path);
    if (seen.has(safePath)) throw new Error(`duplicate update path: ${safePath}`);
    seen.add(safePath);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`invalid file size: ${safePath}`);
    }
    assertHexSha256(file.sha256, `file sha256 (${safePath})`);
  }
  if (!Array.isArray(document.deleted)) throw new Error('deleted must be an array');
  for (const deletedPath of document.deleted) normalizeUpdatePath(deletedPath);
  return document;
}

export function buildPayloadManifest(
  stageDir,
  {
    updateSequence,
    minimumSupportedSequence = 1,
    version,
    channel = 'beta',
    createdAt = new Date().toISOString(),
    deleted = [],
    excludedPaths = ['update-payload.json'],
  },
) {
  const excluded = new Set(excludedPaths.map((item) => normalizeUpdatePath(item)));
  const files = walkManagedFiles(stageDir)
    .filter((file) => !excluded.has(file.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return assertPayloadManifest({
    schema: UPDATE_PAYLOAD_SCHEMA,
    update_sequence: updateSequence,
    minimum_supported_sequence: minimumSupportedSequence,
    version,
    channel,
    created_at: createdAt,
    files,
    deleted: [...deleted].map(normalizeUpdatePath).sort((a, b) => a.localeCompare(b, 'en')),
  });
}

export function createSignedEnvelope(document, privateKeyPem) {
  const canonical = Buffer.from(canonicalJson(document), 'utf8');
  return {
    algorithm: UPDATE_SIGNATURE_ALGORITHM,
    document,
    signature: cryptoSign('sha256', canonical, {
      key: privateKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString('base64'),
  };
}

export function verifySignedEnvelope(envelope, publicKeyPem) {
  if (
    !envelope
    || envelope.algorithm !== UPDATE_SIGNATURE_ALGORITHM
    || !envelope.document
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

export function buildReleaseFeed({
  updateSequence,
  minimumSupportedSequence = 1,
  version,
  channel = 'beta',
  publishedAt,
  repository,
  releaseTag,
  assetName,
  assetSize,
  assetSha256,
  payloadManifestSha256,
  releaseNotes = '',
}) {
  if (
    typeof repository !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error('repository must use owner/name format');
  }
  if (releaseTag !== `update-${updateSequence}`) {
    throw new Error(`release tag must be update-${updateSequence}`);
  }
  if (
    typeof assetName !== 'string'
    || !assetName
    || assetName !== path.basename(assetName)
    || assetName.includes('\\')
  ) {
    throw new Error('asset name must be a file name');
  }
  if (!Number.isSafeInteger(assetSize) || assetSize < 1) throw new Error('asset size is required');
  assertHexSha256(assetSha256, 'asset sha256');
  assertHexSha256(payloadManifestSha256, 'payload manifest sha256');
  const document = {
    schema: UPDATE_FEED_SCHEMA,
    update_sequence: updateSequence,
    minimum_supported_sequence: minimumSupportedSequence,
    version,
    channel,
    published_at: publishedAt,
    asset: {
      repository,
      release_tag: releaseTag,
      name: assetName,
      size: assetSize,
      sha256: assetSha256,
    },
    payload_manifest_sha256: payloadManifestSha256,
    release_notes: String(releaseNotes),
  };
  if (!Number.isSafeInteger(updateSequence) || updateSequence < 1) {
    throw new Error('feed update_sequence must be a positive safe integer');
  }
  if (!Number.isSafeInteger(minimumSupportedSequence) || minimumSupportedSequence < 1) {
    throw new Error('feed minimum_supported_sequence must be a positive safe integer');
  }
  if (minimumSupportedSequence > updateSequence) {
    throw new Error('feed minimum_supported_sequence cannot exceed update_sequence');
  }
  return document;
}
