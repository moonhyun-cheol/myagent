/**
 * User-scoped Organization Feature install/enable under data/organization-features/.
 * Reuses organization-module RSA-PSS-SHA256 verification; install root is user data only.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPathUnder, assertWritablePath } from '../security/path-guard.js';
import {
  assertHexSha256,
  createSignedEnvelope,
  parseSignedEnvelope,
  sha256Bytes,
  sha256File,
  verifySignedEnvelope,
} from '../updates/organization-module-crypto.js';
import { resolveOrganizationModulePublicKey } from '../updates/organization-module-installer.js';
import { readZipEntries } from '../updates/organization-module-zip.js';
import { resolveOrganizationModuleRoot } from '../skills/organization-module-root.js';
import { invalidateOrganizationFeatureCaches } from './organization-feature-cache.js';
import {
  FEATURE_ID_RE,
  FEATURE_INDEX_SCHEMA_VERSION,
  FEATURE_JSON_SCHEMA,
  FEATURE_PAYLOAD_SCHEMA,
  FEATURES_DATA_ROOT,
  OrganizationFeatureError,
  type OrganizationFeatureIndex,
  type OrganizationFeatureIndexEntry,
  type OrganizationFeatureJson,
  type OrganizationFeatureMigrationDeclaration,
  type OrganizationFeaturePayloadDocument,
  type OrganizationFeatureStatus,
  type WorkKitFeaturesBlock,
} from './organization-feature-types.js';

export {
  FEATURE_ID_RE,
  FEATURE_JSON_SCHEMA,
  FEATURE_PAYLOAD_SCHEMA,
  FEATURES_DATA_ROOT,
  OrganizationFeatureError,
} from './organization-feature-types.js';
export { createSignedEnvelope } from '../updates/organization-module-crypto.js';
export { invalidateOrganizationFeatureCaches } from './organization-feature-cache.js';

export function sanitizeFeatureId(raw: string): string | null {
  const id = String(raw ?? '').trim().toLowerCase();
  if (!FEATURE_ID_RE.test(id)) return null;
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) return null;
  return id;
}

export function assertFeatureId(raw: string): string {
  const id = sanitizeFeatureId(raw);
  if (!id) {
    throw new OrganizationFeatureError('FEATURE_INVALID_ID', `Invalid feature id: ${raw}`);
  }
  return id;
}

export function organizationFeaturesRoot(cqrRoot: string): string {
  return path.join(path.resolve(cqrRoot), ...FEATURES_DATA_ROOT.split('/'));
}

export function featureInstallRoot(cqrRoot: string, featureId: string): string {
  const id = assertFeatureId(featureId);
  return path.join(organizationFeaturesRoot(cqrRoot), id);
}

function indexPath(cqrRoot: string): string {
  return path.join(organizationFeaturesRoot(cqrRoot), 'index.json');
}

function emptyIndex(): OrganizationFeatureIndex {
  return { schema_version: FEATURE_INDEX_SCHEMA_VERSION, features: {} };
}

function loadIndex(cqrRoot: string): OrganizationFeatureIndex {
  const file = indexPath(cqrRoot);
  if (!existsSync(file)) return emptyIndex();
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as OrganizationFeatureIndex;
    if (!doc || typeof doc !== 'object') return emptyIndex();
    const features: Record<string, OrganizationFeatureIndexEntry> = {};
    for (const [rawId, raw] of Object.entries(doc.features ?? {})) {
      const id = sanitizeFeatureId(rawId);
      if (!id || !raw || typeof raw !== 'object') continue;
      features[id] = {
        enabled: raw.enabled === true,
        installed_at: typeof raw.installed_at === 'string' ? raw.installed_at : new Date().toISOString(),
        updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
        version: typeof raw.version === 'string' ? raw.version : '0.0.0',
        update_sequence: Number.isSafeInteger(raw.update_sequence) && raw.update_sequence >= 1
          ? raw.update_sequence
          : 1,
        label: typeof raw.label === 'string' ? raw.label : undefined,
        capabilities: Array.isArray(raw.capabilities)
          ? raw.capabilities.filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
          : [],
        refs: Array.isArray(raw.refs)
          ? [...new Set(raw.refs.filter((r): r is string => typeof r === 'string' && Boolean(r.trim())))]
          : [],
      };
    }
    return { schema_version: FEATURE_INDEX_SCHEMA_VERSION, features };
  } catch {
    return emptyIndex();
  }
}

function saveIndex(cqrRoot: string, index: OrganizationFeatureIndex): void {
  const root = organizationFeaturesRoot(cqrRoot);
  mkdirSync(root, { recursive: true });
  const file = indexPath(cqrRoot);
  assertWritablePath(file, cqrRoot);
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** Relative path inside a feature pack (no absolute / traversal / protected roots). */
export function assertFeaturePayloadPath(relative: string): string {
  if (typeof relative !== 'string' || !relative.trim() || relative.includes('\0')) {
    throw new OrganizationFeatureError('FEATURE_PATH', 'Managed path must be non-empty.');
  }
  const normalized = relative.replaceAll('\\', '/');
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new OrganizationFeatureError('FEATURE_PATH', `Unsafe feature path: ${relative}`);
  }
  if (normalized === 'update-payload.json') return normalized;
  const root = normalized.split('/')[0].toLowerCase();
  if (root === 'data' || root === 'logs' || root === 'runtime' || root === '.git') {
    throw new OrganizationFeatureError('FEATURE_PATH', `Protected feature path: ${relative}`);
  }
  return normalized;
}

function asPayloadDocument(document: unknown): OrganizationFeaturePayloadDocument {
  if (!document || typeof document !== 'object') {
    throw new OrganizationFeatureError('FEATURE_PAYLOAD', 'Payload document is missing.');
  }
  const doc = document as OrganizationFeaturePayloadDocument;
  if (doc.schema !== FEATURE_PAYLOAD_SCHEMA) {
    throw new OrganizationFeatureError('FEATURE_PAYLOAD', `Unsupported payload schema: ${String(doc.schema)}`);
  }
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    throw new OrganizationFeatureError('FEATURE_PAYLOAD', 'Payload files are required.');
  }
  assertFeatureId(doc.feature_id);
  if (!Number.isSafeInteger(doc.update_sequence) || doc.update_sequence < 1) {
    throw new OrganizationFeatureError('FEATURE_SEQUENCE', 'update_sequence must be a positive integer.');
  }
  return doc;
}

function readFeatureJson(featureRoot: string): OrganizationFeatureJson {
  const p = path.join(featureRoot, 'feature.json');
  if (!existsSync(p)) {
    throw new OrganizationFeatureError('FEATURE_JSON_MISSING', 'feature.json is required.');
  }
  let doc: OrganizationFeatureJson;
  try {
    doc = JSON.parse(readFileSync(p, 'utf8')) as OrganizationFeatureJson;
  } catch {
    throw new OrganizationFeatureError('FEATURE_JSON', 'feature.json is not valid JSON.');
  }
  if (doc.schema !== FEATURE_JSON_SCHEMA) {
    throw new OrganizationFeatureError('FEATURE_JSON', `Unsupported feature.json schema: ${String(doc.schema)}`);
  }
  assertFeatureId(doc.id);
  if (!doc.version?.trim()) {
    throw new OrganizationFeatureError('FEATURE_JSON', 'feature.json version is required.');
  }
  if (!Number.isSafeInteger(doc.update_sequence) || doc.update_sequence < 1) {
    throw new OrganizationFeatureError('FEATURE_JSON', 'feature.json update_sequence is required.');
  }
  return doc;
}

const STATIC_TOKEN_RE = /(bearer\s+[a-z0-9._-]{20,}|api[_-]?key\s*[:=]\s*['"][^'"]{16,}|authorization['"]?\s*:\s*['"]bearer\s+)/i;

function assertNoStaticLongLivedTokens(featureRoot: string): void {
  const stack = [featureRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.')) stack.push(abs);
        continue;
      }
      if (!/\.(json|md|txt|env|ya?ml)$/i.test(ent.name)) continue;
      const text = readFileSync(abs, 'utf8');
      if (STATIC_TOKEN_RE.test(text)) {
        throw new OrganizationFeatureError(
          'FEATURE_STATIC_TOKEN',
          `정적 장기 토큰이 Feature Pack에 포함되어 있습니다: ${path.relative(featureRoot, abs)}`,
        );
      }
      if (/\.json$/i.test(ent.name)) {
        try {
          const doc = JSON.parse(text) as { authentication?: { mode?: string; token?: string; bearer_token?: string } };
          const mode = doc.authentication?.mode?.trim().toLowerCase();
          if (mode === 'static_bearer' || mode === 'static_token' || mode === 'bearer_token') {
            throw new OrganizationFeatureError(
              'FEATURE_STATIC_TOKEN',
              `정적 bearer 인증 모드는 허용되지 않습니다: ${path.relative(featureRoot, abs)}`,
            );
          }
          if (doc.authentication?.token || doc.authentication?.bearer_token) {
            throw new OrganizationFeatureError(
              'FEATURE_STATIC_TOKEN',
              `정적 토큰 필드가 있습니다: ${path.relative(featureRoot, abs)}`,
            );
          }
        } catch (error) {
          if (error instanceof OrganizationFeatureError) throw error;
        }
      }
    }
  }
}

function verifyPayloadFiles(stageRoot: string, payload: OrganizationFeaturePayloadDocument): void {
  for (const file of payload.files) {
    const relative = assertFeaturePayloadPath(file.path);
    if (relative === 'update-payload.json') continue;
    const abs = path.join(stageRoot, ...relative.split('/'));
    assertPathUnder(stageRoot, abs);
    if (!existsSync(abs)) {
      throw new OrganizationFeatureError('FEATURE_HASH', `Missing inventoried file: ${relative}`);
    }
    const expected = assertHexSha256(file.sha256, relative);
    const actual = sha256File(abs);
    if (actual !== expected) {
      throw new OrganizationFeatureError('FEATURE_HASH', `Hash mismatch: ${relative}`);
    }
  }
}

function writeExtractedFeatureFiles(
  stageRoot: string,
  entries: Array<{ path: string; content: Buffer }>,
): void {
  for (const entry of entries) {
    const normalized = entry.path.replaceAll('\\', '/');
    if (normalized === 'update-payload.json') continue;
    const relative = assertFeaturePayloadPath(normalized);
    const destination = path.join(stageRoot, ...relative.split('/'));
    assertPathUnder(stageRoot, destination);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, entry.content);
  }
}

export interface InstallOrganizationFeatureResult {
  feature: OrganizationFeatureJson;
  root: string;
  enabled: boolean;
}

/**
 * Verify + atomically install a signed Feature Pack ZIP into data/organization-features/{id}.
 * Does not enable unless enable=true. Failed verification leaves previous version intact.
 */
export function installOrganizationFeatureFromZip(
  cqrRoot: string,
  zipPath: string,
  opts?: { enable?: boolean; ref?: string; publicKeyPem?: string },
): InstallOrganizationFeatureResult {
  const publicKeyPem = opts?.publicKeyPem ?? resolveOrganizationModulePublicKey(cqrRoot);
  const entries = readZipEntries(zipPath);
  const payloadEntry = entries.find((e) => e.path.replaceAll('\\', '/') === 'update-payload.json');
  if (!payloadEntry) {
    throw new OrganizationFeatureError('FEATURE_PAYLOAD_MISSING', 'update-payload.json is required.');
  }
  const envelope = parseSignedEnvelope(payloadEntry.content);
  if (!verifySignedEnvelope(envelope, publicKeyPem)) {
    throw new OrganizationFeatureError('FEATURE_SIGNATURE', 'Feature Pack 서명이 올바르지 않습니다.');
  }
  const payload = asPayloadDocument(envelope.document);
  const featureId = assertFeatureId(payload.feature_id);

  const featuresRoot = organizationFeaturesRoot(cqrRoot);
  mkdirSync(featuresRoot, { recursive: true });
  const liveRoot = featureInstallRoot(cqrRoot, featureId);
  assertWritablePath(liveRoot, cqrRoot);
  const stageParent = path.join(featuresRoot, '.staging');
  const stageRoot = path.join(stageParent, `${featureId}-${randomUUID().replaceAll('-', '')}`);
  mkdirSync(stageRoot, { recursive: true });

  const backupRoot = existsSync(liveRoot)
    ? path.join(featuresRoot, `.backup-${featureId}-${randomUUID().replaceAll('-', '')}`)
    : null;

  try {
    writeExtractedFeatureFiles(stageRoot, entries);
    const extracted = entries
      .map((e) => e.path.replaceAll('\\', '/'))
      .filter((p) => p !== 'update-payload.json')
      .sort();
    const inventoried = payload.files
      .map((f) => assertFeaturePayloadPath(f.path))
      .filter((p) => p !== 'update-payload.json')
      .sort();
    if (extracted.join('\0') !== inventoried.join('\0')) {
      throw new OrganizationFeatureError(
        'FEATURE_ZIP_INVENTORY',
        'ZIP contains files outside the signed inventory.',
      );
    }
    verifyPayloadFiles(stageRoot, payload);
    const featureJson = readFeatureJson(stageRoot);
    if (featureJson.id !== featureId) {
      throw new OrganizationFeatureError('FEATURE_ID_MISMATCH', 'feature.json id does not match payload.');
    }
    if (featureJson.update_sequence !== payload.update_sequence) {
      throw new OrganizationFeatureError('FEATURE_SEQUENCE_MISMATCH', 'feature.json sequence does not match payload.');
    }
    assertNoStaticLongLivedTokens(stageRoot);

    // Keep update-payload.json for audit (already verified).
    writeFileSync(path.join(stageRoot, 'update-payload.json'), payloadEntry.content);

    if (backupRoot) {
      renameSync(liveRoot, backupRoot);
    }
    try {
      renameSync(stageRoot, liveRoot);
    } catch (error) {
      if (backupRoot && existsSync(backupRoot) && !existsSync(liveRoot)) {
        renameSync(backupRoot, liveRoot);
      }
      throw error;
    }
    if (backupRoot && existsSync(backupRoot)) {
      rmSync(backupRoot, { recursive: true, force: true });
    }

    const now = new Date().toISOString();
    const index = loadIndex(cqrRoot);
    const prev = index.features[featureId];
    const refs = new Set(prev?.refs ?? []);
    if (opts?.ref?.trim()) refs.add(opts.ref.trim());
    const enable = opts?.enable === true || prev?.enabled === true;
    index.features[featureId] = {
      enabled: enable,
      installed_at: prev?.installed_at ?? now,
      updated_at: now,
      version: featureJson.version,
      update_sequence: featureJson.update_sequence,
      label: featureJson.label,
      capabilities: Array.isArray(featureJson.capabilities) ? featureJson.capabilities : [],
      refs: [...refs],
    };
    saveIndex(cqrRoot, index);
    invalidateOrganizationFeatureCaches();
    return { feature: featureJson, root: liveRoot, enabled: enable };
  } catch (error) {
    if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (existsSync(stageParent)) {
      try {
        const left = readdirSync(stageParent);
        if (left.length === 0) rmSync(stageParent, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export function listOrganizationFeatures(cqrRoot: string): OrganizationFeatureStatus[] {
  const index = loadIndex(cqrRoot);
  const out: OrganizationFeatureStatus[] = [];
  for (const [id, entry] of Object.entries(index.features)) {
    const root = featureInstallRoot(cqrRoot, id);
    const installed = existsSync(path.join(root, 'feature.json'));
    out.push({
      id,
      installed,
      enabled: installed && entry.enabled,
      version: entry.version,
      update_sequence: entry.update_sequence,
      label: entry.label,
      capabilities: entry.capabilities,
      refs: entry.refs,
      root: installed ? root : undefined,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function getOrganizationFeatureStatus(cqrRoot: string, featureId: string): OrganizationFeatureStatus | null {
  const id = sanitizeFeatureId(featureId);
  if (!id) return null;
  return listOrganizationFeatures(cqrRoot).find((f) => f.id === id) ?? null;
}

export function isOrganizationFeatureEnabled(cqrRoot: string, featureId: string): boolean {
  const status = getOrganizationFeatureStatus(cqrRoot, featureId);
  return Boolean(status?.installed && status.enabled);
}

export function listEnabledOrganizationFeatureRoots(cqrRoot: string): string[] {
  return listOrganizationFeatures(cqrRoot)
    .filter((f) => f.enabled && f.root)
    .map((f) => f.root!);
}

export function readEnabledFeatureJson(cqrRoot: string, featureId: string): OrganizationFeatureJson | null {
  if (!isOrganizationFeatureEnabled(cqrRoot, featureId)) return null;
  try {
    return readFeatureJson(featureInstallRoot(cqrRoot, featureId));
  } catch {
    return null;
  }
}

export function enableOrganizationFeature(
  cqrRoot: string,
  featureId: string,
  opts?: { confirm?: boolean; ref?: string },
): OrganizationFeatureStatus {
  if (opts?.confirm !== true) {
    throw new OrganizationFeatureError('FEATURE_CONFIRM_REQUIRED', 'enable에는 confirm=true가 필요합니다.');
  }
  const id = assertFeatureId(featureId);
  const root = featureInstallRoot(cqrRoot, id);
  if (!existsSync(path.join(root, 'feature.json'))) {
    throw new OrganizationFeatureError('FEATURE_NOT_INSTALLED', `Feature가 설치되어 있지 않습니다: ${id}`);
  }
  const index = loadIndex(cqrRoot);
  const prev = index.features[id];
  const refs = new Set(prev?.refs ?? []);
  if (opts?.ref?.trim()) refs.add(opts.ref.trim());
  const featureJson = readFeatureJson(root);
  const now = new Date().toISOString();
  index.features[id] = {
    enabled: true,
    installed_at: prev?.installed_at ?? now,
    updated_at: now,
    version: featureJson.version,
    update_sequence: featureJson.update_sequence,
    label: featureJson.label,
    capabilities: Array.isArray(featureJson.capabilities) ? featureJson.capabilities : [],
    refs: [...refs],
  };
  saveIndex(cqrRoot, index);
  invalidateOrganizationFeatureCaches();
  return getOrganizationFeatureStatus(cqrRoot, id)!;
}

export function disableOrganizationFeature(
  cqrRoot: string,
  featureId: string,
  opts?: { confirm?: boolean; removeRef?: string },
): OrganizationFeatureStatus {
  if (opts?.confirm !== true) {
    throw new OrganizationFeatureError('FEATURE_CONFIRM_REQUIRED', 'disable에는 confirm=true가 필요합니다.');
  }
  const id = assertFeatureId(featureId);
  const index = loadIndex(cqrRoot);
  const prev = index.features[id];
  if (!prev) {
    throw new OrganizationFeatureError('FEATURE_NOT_INSTALLED', `Feature가 설치되어 있지 않습니다: ${id}`);
  }
  const refs = new Set(prev.refs);
  if (opts?.removeRef?.trim()) refs.delete(opts.removeRef.trim());
  // Keep enabled if other work kits still reference it.
  const stillRequired = refs.size > 0;
  index.features[id] = {
    ...prev,
    enabled: stillRequired ? true : false,
    refs: [...refs],
    updated_at: new Date().toISOString(),
  };
  saveIndex(cqrRoot, index);
  invalidateOrganizationFeatureCaches();
  return getOrganizationFeatureStatus(cqrRoot, id)!;
}

export function removeOrganizationFeature(
  cqrRoot: string,
  featureId: string,
  opts?: { confirm?: boolean; force?: boolean },
): { ok: boolean; id: string } {
  if (opts?.confirm !== true) {
    throw new OrganizationFeatureError('FEATURE_CONFIRM_REQUIRED', 'remove에는 confirm=true가 필요합니다.');
  }
  const id = assertFeatureId(featureId);
  const index = loadIndex(cqrRoot);
  const prev = index.features[id];
  if (prev && prev.refs.length > 0 && opts?.force !== true) {
    throw new OrganizationFeatureError(
      'FEATURE_IN_USE',
      `다른 Work Kit이 Feature를 사용 중입니다: ${prev.refs.join(', ')}`,
    );
  }
  const root = featureInstallRoot(cqrRoot, id);
  if (existsSync(root)) {
    assertWritablePath(root, cqrRoot);
    assertPathUnder(organizationFeaturesRoot(cqrRoot), root);
    rmSync(root, { recursive: true, force: true });
  }
  delete index.features[id];
  saveIndex(cqrRoot, index);
  invalidateOrganizationFeatureCaches();
  return { ok: true, id };
}

export function snapshotOrganizationFeatureState(cqrRoot: string): OrganizationFeatureIndex {
  return loadIndex(cqrRoot);
}

export function restoreOrganizationFeatureState(
  cqrRoot: string,
  snapshot: OrganizationFeatureIndex | null | undefined,
): void {
  if (!snapshot || typeof snapshot !== 'object') return;
  const next: OrganizationFeatureIndex = {
    schema_version: FEATURE_INDEX_SCHEMA_VERSION,
    features: {},
  };
  for (const [rawId, entry] of Object.entries(snapshot.features ?? {})) {
    const id = sanitizeFeatureId(rawId);
    if (!id || !entry) continue;
    const root = featureInstallRoot(cqrRoot, id);
    if (!existsSync(path.join(root, 'feature.json'))) continue;
    next.features[id] = {
      enabled: entry.enabled === true,
      installed_at: entry.installed_at,
      updated_at: new Date().toISOString(),
      version: entry.version,
      update_sequence: entry.update_sequence,
      label: entry.label,
      capabilities: entry.capabilities ?? [],
      refs: entry.refs ?? [],
    };
  }
  // Drop enable flags for features that existed only after snapshot.
  const current = loadIndex(cqrRoot);
  for (const id of Object.keys(current.features)) {
    if (!next.features[id] && current.features[id]) {
      next.features[id] = {
        ...current.features[id],
        enabled: false,
        refs: [],
        updated_at: new Date().toISOString(),
      };
    }
  }
  saveIndex(cqrRoot, next);
  invalidateOrganizationFeatureCaches();
}

export function normalizeWorkKitFeatures(raw: unknown): WorkKitFeaturesBlock | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const enableRaw = (raw as WorkKitFeaturesBlock).enable;
  if (!enableRaw || typeof enableRaw !== 'object') return undefined;
  const enable: Record<string, { required?: boolean }> = {};
  for (const [rawId, spec] of Object.entries(enableRaw)) {
    const id = sanitizeFeatureId(rawId);
    if (!id) continue;
    enable[id] = { required: (spec as { required?: boolean })?.required === true };
  }
  if (Object.keys(enable).length === 0) return undefined;
  return { enable };
}

export function findShelfFeaturePackZip(shelfDir: string, featureId: string): string | null {
  const id = assertFeatureId(featureId);
  const candidates = [
    path.join(shelfDir, 'features', `${id}.zip`),
    path.join(shelfDir, 'features', id, `${id}.zip`),
    path.join(shelfDir, 'organization-features', `${id}.zip`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ApplyWorkKitFeaturesResult {
  installed_features: string[];
  enabled_features: string[];
  warnings: string[];
}

/**
 * Install+enable features declared on a Work Kit shelf.
 * Required feature failure throws — caller must not mark apply as successful.
 */
export function applyWorkKitFeatures(
  cqrRoot: string,
  shelfDir: string,
  features: WorkKitFeaturesBlock | undefined,
  ref: string,
): ApplyWorkKitFeaturesResult {
  const installed_features: string[] = [];
  const enabled_features: string[] = [];
  const warnings: string[] = [];
  const enable = features?.enable ?? {};
  for (const [featureId, spec] of Object.entries(enable)) {
    const id = assertFeatureId(featureId);
    const required = spec?.required === true;
    try {
      const zip = findShelfFeaturePackZip(shelfDir, id);
      if (zip) {
        installOrganizationFeatureFromZip(cqrRoot, zip, { enable: true, ref });
        installed_features.push(id);
      } else if (!existsSync(path.join(featureInstallRoot(cqrRoot, id), 'feature.json'))) {
        throw new OrganizationFeatureError(
          'FEATURE_PACK_MISSING',
          `Work Kit에 Feature Pack이 없습니다: ${id}`,
        );
      }
      enableOrganizationFeature(cqrRoot, id, { confirm: true, ref });
      enabled_features.push(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (required) {
        throw new OrganizationFeatureError(
          error instanceof OrganizationFeatureError ? error.code : 'FEATURE_APPLY_FAILED',
          `필수 Feature 적용 실패 (${id}): ${message}`,
        );
      }
      warnings.push(`선택 Feature 적용 실패 (${id}): ${message}`);
    }
  }
  return { installed_features, enabled_features, warnings };
}

export function releaseWorkKitFeatureRefs(cqrRoot: string, ref: string): void {
  const index = loadIndex(cqrRoot);
  let changed = false;
  for (const [id, entry] of Object.entries(index.features)) {
    if (!entry.refs.includes(ref)) continue;
    const refs = entry.refs.filter((r) => r !== ref);
    index.features[id] = {
      ...entry,
      refs,
      enabled: refs.length > 0 ? entry.enabled : false,
      updated_at: new Date().toISOString(),
    };
    changed = true;
  }
  if (changed) {
    saveIndex(cqrRoot, index);
    invalidateOrganizationFeatureCaches();
  }
}

/**
 * Copy legacy org-module files into a feature root when external declaration + applied kit match.
 * Does not delete organization module files.
 */
export function migrateLegacyOrganizationFeature(
  cqrRoot: string,
  declaration: OrganizationFeatureMigrationDeclaration,
  opts?: { isWorkKitApplied?: (group: string, id: string) => boolean },
): InstallOrganizationFeatureResult | null {
  const featureId = assertFeatureId(declaration.feature_id);
  if (declaration.require_applied_work_kit) {
    const { group, id } = declaration.require_applied_work_kit;
    const applied = opts?.isWorkKitApplied?.(group, id) === true;
    if (!applied) return null;
  }
  if (existsSync(path.join(featureInstallRoot(cqrRoot, featureId), 'feature.json'))) {
    return null;
  }
  const orgRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!orgRoot) return null;

  const stage = path.join(organizationFeaturesRoot(cqrRoot), `.migrate-${featureId}-${randomUUID().replaceAll('-', '')}`);
  mkdirSync(stage, { recursive: true });
  try {
    const copies: Array<{ from: string; to: string }> = [];
    const map = declaration.source_paths;
    if (map.automaton_tools_manifest) {
      copies.push({ from: map.automaton_tools_manifest, to: map.automaton_tools_manifest });
    }
    if (map.openclaw_workflow_map) {
      copies.push({ from: map.openclaw_workflow_map, to: map.openclaw_workflow_map });
    }
    if (map.adapter_connection) {
      copies.push({ from: map.adapter_connection, to: map.adapter_connection });
    }
    for (const item of copies) {
      const src = path.join(orgRoot, ...assertFeaturePayloadPath(item.from).split('/'));
      if (!existsSync(src)) {
        throw new OrganizationFeatureError('FEATURE_MIGRATE_SOURCE', `마이그레이션 원본 없음: ${item.from}`);
      }
      const dest = path.join(stage, ...assertFeaturePayloadPath(item.to).split('/'));
      assertPathUnder(stage, dest);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src));
    }
    const featureJson: OrganizationFeatureJson = {
      schema: FEATURE_JSON_SCHEMA,
      id: featureId,
      version: declaration.version?.trim() || '0.0.0-migrated',
      update_sequence: 1,
      label: declaration.label,
      capabilities: declaration.capabilities ?? [],
      entrypoints: {
        automaton_tools_manifest: map.automaton_tools_manifest,
        openclaw_workflow_map: map.openclaw_workflow_map,
        adapter_connection: map.adapter_connection,
      },
    };
    writeFileSync(path.join(stage, 'feature.json'), `${JSON.stringify(featureJson, null, 2)}\n`);
    assertNoStaticLongLivedTokens(stage);

    // Unsigned local migration into user data — operator-driven; not a remote pack.
    const liveRoot = featureInstallRoot(cqrRoot, featureId);
    assertWritablePath(liveRoot, cqrRoot);
    mkdirSync(path.dirname(liveRoot), { recursive: true });
    renameSync(stage, liveRoot);
    const now = new Date().toISOString();
    const index = loadIndex(cqrRoot);
    const ref = declaration.require_applied_work_kit
      ? `${declaration.require_applied_work_kit.group}/${declaration.require_applied_work_kit.id}`
      : undefined;
    index.features[featureId] = {
      enabled: true,
      installed_at: now,
      updated_at: now,
      version: featureJson.version,
      update_sequence: 1,
      label: featureJson.label,
      capabilities: featureJson.capabilities ?? [],
      refs: ref ? [ref] : [],
    };
    saveIndex(cqrRoot, index);
    invalidateOrganizationFeatureCaches();
    return { feature: featureJson, root: liveRoot, enabled: true };
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Test/publisher helper: build a signed update-payload.json for a staged feature directory. */
export function buildSignedFeaturePayloadFromDir(
  featureDir: string,
  privateKeyPem: string,
): { payload: OrganizationFeaturePayloadDocument; envelopeJson: string } {
  const featureJson = readFeatureJson(featureDir);
  const files: OrganizationFeaturePayloadDocument['files'] = [];
  const walk = (dir: string, prefix = ''): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel.replaceAll('\\', '/'));
        continue;
      }
      if (ent.name === 'update-payload.json') continue;
      const relative = assertFeaturePayloadPath(rel.replaceAll('\\', '/'));
      const buf = readFileSync(abs);
      files.push({ path: relative, size: buf.length, sha256: sha256Bytes(buf) });
    }
  };
  walk(featureDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const payload: OrganizationFeaturePayloadDocument = {
    schema: FEATURE_PAYLOAD_SCHEMA,
    feature_id: featureJson.id,
    version: featureJson.version,
    update_sequence: featureJson.update_sequence,
    files,
  };
  const envelope = createSignedEnvelope(payload, privateKeyPem);
  return { payload, envelopeJson: `${JSON.stringify(envelope, null, 2)}\n` };
}
