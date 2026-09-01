import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProductVersion } from '../config/product-version.js';
import {
  MODULE_FEED_SCHEMA,
  MODULE_INSTALL_ROOT,
  MODULE_PAYLOAD_SCHEMA,
  OrganizationModuleError,
  assertHexSha256,
  assertPayloadPathAllowed,
  parseSignedEnvelope,
  productVersionMeets,
  sha256Bytes,
  sha256File,
  verifySignedEnvelope,
  type SignedEnvelope,
} from './organization-module-crypto.js';
export { OrganizationModuleError } from './organization-module-crypto.js';
import { readZipEntries } from './organization-module-zip.js';

export interface OrganizationModuleInfo {
  id: string;
  kind: 'organization-module';
  version: string;
  update_sequence: number;
  install_root: string;
  required_core_api: string;
  update_feed_url?: string;
  update_channel?: string;
  brand_manual_url?: string;
  capabilities: string[];
  /** Optional per-capability versions. Missing ids inherit the pack version. */
  capability_versions?: Record<string, string>;
}

export interface OrganizationModuleComponent {
  id: string;
  version: string;
}

export interface InstalledOrganizationModule extends OrganizationModuleInfo {
  root: string;
  components: OrganizationModuleComponent[];
}

interface PayloadFile {
  path: string;
  size: number;
  sha256: string;
}

interface PayloadDocument {
  schema: string;
  update_sequence: number;
  minimum_supported_sequence: number;
  version: string;
  channel: string;
  files: PayloadFile[];
  deleted?: string[];
}

interface FeedDocument {
  schema: string;
  kind?: string;
  update_sequence: number;
  minimum_supported_sequence: number;
  version: string;
  channel: string;
  asset: {
    repository: string;
    release_tag: string;
    name: string;
    size: number;
    sha256: string;
  };
  payload_manifest_sha256: string;
}

function requirePositiveInt(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new OrganizationModuleError('MODULE_SEQUENCE', `${label} must be a positive integer.`);
  }
  return n;
}

export function resolveOrganizationModulePublicKey(cqrRoot: string): string {
  const env = process.env.MY_AGENT_ORGANIZATION_MODULE_PUBLIC_KEY?.trim();
  const candidates = [
    env,
    path.join(cqrRoot, 'data', 'vault', 'organization-module-public.pem'),
    path.join(cqrRoot, 'core', 'config', 'defaults', 'organization-module-public.pem'),
    path.join(cqrRoot, 'core', 'dist', 'config', 'defaults', 'organization-module-public.pem'),
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new OrganizationModuleError(
    'MODULE_PUBLIC_KEY',
    '조직 모듈 공개키가 없습니다. data/vault/organization-module-public.pem 을 넣으세요.',
  );
}

function parseCapabilityVersions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim() || typeof value !== 'string' || !value.trim()) continue;
    out[id.trim()] = value.trim();
  }
  return out;
}

export function listOrganizationModuleComponents(
  capabilities: string[],
  packVersion: string,
  capabilityVersions?: Record<string, string>,
): OrganizationModuleComponent[] {
  const versions = capabilityVersions ?? {};
  return capabilities.map((id) => ({
    id,
    version: versions[id]?.trim() || packVersion,
  }));
}

export function readInstalledOrganizationModule(cqrRoot: string): InstalledOrganizationModule | null {
  const root = path.join(cqrRoot, ...MODULE_INSTALL_ROOT.split('/'));
  const moduleJsonPath = path.join(root, 'module.json');
  if (!existsSync(moduleJsonPath)) return null;
  try {
    const doc = JSON.parse(readFileSync(moduleJsonPath, 'utf8')) as OrganizationModuleInfo;
    if (doc.kind !== 'organization-module') return null;
    const capabilities = Array.isArray(doc.capabilities) ? doc.capabilities : [];
    const capability_versions = parseCapabilityVersions(doc.capability_versions);
    return {
      ...doc,
      update_sequence: requirePositiveInt(doc.update_sequence, 'update_sequence'),
      capabilities,
      capability_versions,
      root,
      components: listOrganizationModuleComponents(capabilities, doc.version, capability_versions),
    };
  } catch {
    return null;
  }
}

function asPayloadDocument(document: unknown): PayloadDocument {
  if (!document || typeof document !== 'object') {
    throw new OrganizationModuleError('MODULE_PAYLOAD', 'Payload document is missing.');
  }
  const doc = document as PayloadDocument;
  if (doc.schema !== MODULE_PAYLOAD_SCHEMA) {
    throw new OrganizationModuleError('MODULE_PAYLOAD', `Unsupported payload schema: ${String(doc.schema)}`);
  }
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    throw new OrganizationModuleError('MODULE_PAYLOAD', 'Payload files are required.');
  }
  return doc;
}

function asFeedDocument(document: unknown): FeedDocument {
  if (!document || typeof document !== 'object') {
    throw new OrganizationModuleError('MODULE_FEED', 'Feed document is missing.');
  }
  const doc = document as FeedDocument;
  if (doc.schema !== MODULE_FEED_SCHEMA) {
    throw new OrganizationModuleError('MODULE_FEED', `Unsupported feed schema: ${String(doc.schema)}`);
  }
  if (doc.kind && doc.kind !== 'organization-module') {
    throw new OrganizationModuleError('MODULE_FEED', `Unexpected feed kind: ${doc.kind}`);
  }
  if (!doc.asset || typeof doc.asset !== 'object') {
    throw new OrganizationModuleError('MODULE_FEED', 'Feed asset is missing.');
  }
  return doc;
}

function writeExtractedFiles(stageRoot: string, entries: Array<{ path: string; content: Buffer }>): void {
  for (const entry of entries) {
    const normalized = entry.path.replaceAll('\\', '/');
    if (/^update-feed-[^/]+\.json$/i.test(normalized)) continue;
    const relative = assertPayloadPathAllowed(entry.path);
    const destination = path.join(stageRoot, ...relative.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, entry.content);
  }
}

function verifyFeedMatchesPayload(
  feed: FeedDocument,
  payload: PayloadDocument,
  payloadEnvelopeBytes: Buffer,
): void {
  if (payload.update_sequence !== feed.update_sequence) {
    throw new OrganizationModuleError('MODULE_SEQUENCE_MISMATCH', 'Feed and payload sequences differ.');
  }
  if (payload.minimum_supported_sequence !== feed.minimum_supported_sequence) {
    throw new OrganizationModuleError('MODULE_SEQUENCE_MISMATCH', 'Feed and payload minimum sequences differ.');
  }
  if (payload.version !== feed.version || payload.channel !== feed.channel) {
    throw new OrganizationModuleError('MODULE_META_MISMATCH', 'Feed and payload metadata differ.');
  }
  const expectedPayloadSha = assertHexSha256(feed.payload_manifest_sha256, 'payload_manifest_sha256');
  if (sha256Bytes(payloadEnvelopeBytes) !== expectedPayloadSha) {
    throw new OrganizationModuleError('MODULE_PAYLOAD_HASH', 'Payload manifest hash does not match signed feed.');
  }
}

function verifyPayloadFiles(stageRoot: string, payload: PayloadDocument): void {
  const seen = new Set<string>();
  for (const file of payload.files) {
    const relative = assertPayloadPathAllowed(file.path);
    if (seen.has(relative)) {
      throw new OrganizationModuleError('MODULE_DUPLICATE', `Duplicate payload path: ${relative}`);
    }
    seen.add(relative);
    const stagedPath = path.join(stageRoot, ...relative.split('/'));
    if (!existsSync(stagedPath)) {
      throw new OrganizationModuleError('MODULE_MISSING_FILE', `Payload file is missing: ${relative}`);
    }
    const info = statSync(stagedPath);
    if (info.size !== file.size || sha256File(stagedPath) !== assertHexSha256(file.sha256, relative)) {
      throw new OrganizationModuleError('MODULE_FILE_HASH', `Payload file verification failed: ${relative}`);
    }
  }
}

function readModuleJson(stageOrgRoot: string): OrganizationModuleInfo {
  const moduleJsonPath = path.join(stageOrgRoot, 'module.json');
  if (!existsSync(moduleJsonPath)) {
    throw new OrganizationModuleError('MODULE_JSON', 'module.json is missing from the pack.');
  }
  const doc = JSON.parse(readFileSync(moduleJsonPath, 'utf8')) as OrganizationModuleInfo;
  if (doc.kind !== 'organization-module' || doc.install_root !== MODULE_INSTALL_ROOT) {
    throw new OrganizationModuleError('MODULE_JSON', 'module.json is not a valid organization module.');
  }
  if (!existsSync(path.join(stageOrgRoot, 'skills', 'manifest.json'))) {
    throw new OrganizationModuleError('MODULE_SKILLS', 'Packed module must include skills/manifest.json.');
  }
  return doc;
}

export interface InstallOrganizationModuleInput {
  cqrRoot: string;
  zipPath: string;
  /** Optional signed feed. Local in-app install only needs the zip (payload is inside). */
  feedPath?: string;
  publicKeyPem?: string;
}

export interface InstallOrganizationModuleResult {
  installed: InstalledOrganizationModule;
  backupRoot: string | null;
}

export function installOrganizationModule(input: InstallOrganizationModuleInput): InstallOrganizationModuleResult {
  const cqrRoot = path.resolve(input.cqrRoot);
  const zipPath = path.resolve(input.zipPath);
  if (!zipPath.toLowerCase().endsWith('.zip')) {
    throw new OrganizationModuleError('MODULE_ZIP_REQUIRED', '회사 팩 ZIP 파일을 선택하세요.');
  }
  if (!existsSync(zipPath)) {
    throw new OrganizationModuleError('MODULE_ZIP_NOT_FOUND', `ZIP 파일을 찾을 수 없습니다: ${zipPath}`);
  }
  const publicKeyPem = input.publicKeyPem ?? resolveOrganizationModulePublicKey(cqrRoot);

  let feed: FeedDocument | null = null;
  if (input.feedPath?.trim()) {
    const feedPath = path.resolve(input.feedPath);
    const feedBytes = readFileSync(feedPath);
    const feedEnvelope = parseSignedEnvelope(feedBytes);
    if (!verifySignedEnvelope(feedEnvelope, publicKeyPem)) {
      throw new OrganizationModuleError('MODULE_FEED_SIGNATURE', '모듈 피드 서명이 올바르지 않습니다.');
    }
    feed = asFeedDocument(feedEnvelope.document);
    const zipStat = statSync(zipPath);
    if (zipStat.size !== feed.asset.size) {
      throw new OrganizationModuleError('MODULE_ZIP_SIZE', 'Downloaded update size does not match signed feed.');
    }
    if (sha256File(zipPath) !== assertHexSha256(feed.asset.sha256, 'asset sha256')) {
      throw new OrganizationModuleError('MODULE_ZIP_HASH', 'Downloaded update hash does not match signed feed.');
    }
  }

  const entries = readZipEntries(zipPath);
  const payloadEntry = entries.find((entry) => entry.path === 'update-payload.json');
  if (!payloadEntry) {
    throw new OrganizationModuleError('MODULE_PAYLOAD', 'Signed payload manifest is missing.');
  }
  const payloadEnvelope = parseSignedEnvelope(payloadEntry.content);
  if (!verifySignedEnvelope(payloadEnvelope, publicKeyPem)) {
    throw new OrganizationModuleError('MODULE_PAYLOAD_SIGNATURE', '모듈 페이로드 서명이 올바르지 않습니다.');
  }
  const payload = asPayloadDocument(payloadEnvelope.document);

  const stageParent = path.join(cqrRoot, '.module-staging');
  const stageRoot = path.join(stageParent, randomUUID().replaceAll('-', ''));
  mkdirSync(stageRoot, { recursive: true });
  try {
    writeExtractedFiles(stageRoot, entries);
    const extracted = entries
      .map((entry) => entry.path.replaceAll('\\', '/'))
      .filter((relative) => relative !== 'update-payload.json' && !/^update-feed-[^/]+\.json$/i.test(relative))
      .sort();
    const inventoried = payload.files.map((file) => assertPayloadPathAllowed(file.path)).sort();
    if (extracted.join('\0') !== inventoried.join('\0')) {
      throw new OrganizationModuleError('MODULE_ZIP_INVENTORY', 'ZIP contains files outside the signed inventory.');
    }
    if (feed) {
      verifyFeedMatchesPayload(feed, payload, payloadEntry.content);
    }
    verifyPayloadFiles(stageRoot, payload);

    const stageOrgRoot = path.join(stageRoot, ...MODULE_INSTALL_ROOT.split('/'));
    const moduleJson = readModuleJson(stageOrgRoot);
    if (moduleJson.update_sequence !== payload.update_sequence) {
      throw new OrganizationModuleError('MODULE_SEQUENCE_MISMATCH', 'module.json sequence does not match payload.');
    }
    const installedCore = readProductVersion(cqrRoot);
    if (!productVersionMeets(installedCore, moduleJson.required_core_api)) {
      throw new OrganizationModuleError(
        'MODULE_CORE_API',
        `이 모듈은 코어 ${moduleJson.required_core_api} 이상이 필요합니다. 현재 ${installedCore}.`,
      );
    }

    const current = readInstalledOrganizationModule(cqrRoot);
    if (current && current.update_sequence >= payload.update_sequence) {
      throw new OrganizationModuleError(
        'MODULE_NOT_NEWER',
        `설치된 모듈 시퀀스 ${current.update_sequence}가 이 팩(${payload.update_sequence})보다 같거나 더 새롭습니다.`,
      );
    }
    if (current && current.update_sequence < payload.minimum_supported_sequence) {
      throw new OrganizationModuleError(
        'MODULE_TOO_OLD',
        '설치된 조직 모듈이 너무 오래되어 이 팩으로 바로 올릴 수 없습니다.',
      );
    }

    const liveRoot = path.join(cqrRoot, ...MODULE_INSTALL_ROOT.split('/'));
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const backupRoot = current
      ? path.join(cqrRoot, 'data', 'backups', `organization-module-${current.update_sequence}-${stamp}`)
      : null;
    mkdirSync(path.join(cqrRoot, 'modules'), { recursive: true });
    if (current && backupRoot) {
      mkdirSync(path.dirname(backupRoot), { recursive: true });
      renameSync(liveRoot, backupRoot);
    } else if (existsSync(liveRoot)) {
      rmSync(liveRoot, { recursive: true, force: true });
    }
    try {
      renameSync(stageOrgRoot, liveRoot);
    } catch (error) {
      if (backupRoot && existsSync(backupRoot) && !existsSync(liveRoot)) {
        renameSync(backupRoot, liveRoot);
      }
      throw error;
    }

    const installed = readInstalledOrganizationModule(cqrRoot);
    if (!installed) {
      throw new OrganizationModuleError('MODULE_INSTALL', '설치 후 module.json을 읽지 못했습니다.');
    }
    return { installed, backupRoot };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

import { resolveOrganizationModuleFeedUrl } from './organization-module-feed-resolve.js';

export function describeOrganizationModuleStatus(cqrRoot: string): {
  installed: InstalledOrganizationModule | null;
  feed_url: string | null;
  can_check_remote: boolean;
} {
  const feedUrl = resolveOrganizationModuleFeedUrl(cqrRoot);
  return {
    installed: readInstalledOrganizationModule(cqrRoot),
    feed_url: feedUrl,
    can_check_remote: Boolean(feedUrl),
  };
}

export function verifyFeedEnvelope(feedEnvelope: SignedEnvelope, publicKeyPem: string): FeedDocument {
  if (!verifySignedEnvelope(feedEnvelope, publicKeyPem)) {
    throw new OrganizationModuleError('MODULE_FEED_SIGNATURE', '모듈 피드 서명이 올바르지 않습니다.');
  }
  return asFeedDocument(feedEnvelope.document);
}
