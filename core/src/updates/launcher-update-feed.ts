import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertHexSha256,
  parseSignedEnvelope,
  verifySignedEnvelope,
  type SignedEnvelope,
} from './organization-module-crypto.js';
import {
  buildUpdateAssetUrl,
  isTrustedUpdateFeedHost,
} from './update-host-policy.js';

export const LAUNCHER_FEED_SCHEMA = 'my-agent-launcher-feed/v1';
export const LAUNCHER_KIND = 'work-kit-launcher';
const MAX_FEED_BYTES = 1024 * 1024;

export class LauncherUpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LauncherUpdateError';
  }
}

export interface LauncherManifest {
  kind: string;
  version: string;
  update_channel: string;
  update_sequence: number;
  minimum_supported_sequence: number;
  update_repository: string;
  update_feed_url: string;
}

export interface LauncherUpdateCheckResult {
  feed_url: string | null;
  feed_sequence: number | null;
  installed_sequence: number | null;
  update_available: boolean;
  version?: string | null;
  release_notes?: string | null;
}

interface LauncherFeedDocument {
  schema: string;
  kind: string;
  update_sequence: number;
  minimum_supported_sequence: number;
  version: string;
  channel: string;
  release_notes?: string;
  asset: {
    repository: string;
    release_tag: string;
    name: string;
    size: number;
    sha256: string;
  };
}

function readLauncherManifest(cqrRoot: string): LauncherManifest | null {
  const manifestPath = path.join(cqrRoot, 'launcher-manifest.json');
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as LauncherManifest;
    if (raw.kind !== LAUNCHER_KIND) return null;
    if (!raw.update_feed_url?.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

function resolveLauncherPublicKey(cqrRoot: string): string {
  const keyPath = path.join(cqrRoot, 'core', 'config', 'defaults', 'update-public.pem');
  try {
    return readFileSync(keyPath, 'utf8');
  } catch {
    throw new LauncherUpdateError('LAUNCHER_PUBLIC_KEY', 'update-public.pem is missing.');
  }
}

function ensureTrustedFeedUrl(url: URL, configuredFeedHost: string): void {
  if (url.protocol !== 'https:') {
    throw new LauncherUpdateError('LAUNCHER_FEED_URL', 'Launcher feed must use HTTPS.');
  }
  if (!isTrustedUpdateFeedHost(url.hostname, { configuredFeedHost })) {
    throw new LauncherUpdateError(
      'LAUNCHER_FEED_HOST',
      'Launcher feed host is not trusted. Set MY_AGENT_UPDATE_TRUSTED_HOSTS if needed.',
    );
  }
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > limit) {
    throw new LauncherUpdateError('LAUNCHER_FEED_TOO_LARGE', 'Launcher update feed is too large.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) {
    throw new LauncherUpdateError('LAUNCHER_FEED_TOO_LARGE', 'Launcher update feed exceeded its size limit.');
  }
  return bytes;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LauncherUpdateError('LAUNCHER_FEED_INVALID', `${name} is required.`);
  }
  return value.trim();
}

function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new LauncherUpdateError('LAUNCHER_FEED_INVALID', `${name} must be a positive integer.`);
  }
  return value;
}

export function verifyLauncherFeedEnvelope(
  envelope: SignedEnvelope,
  publicKeyPem: string,
  expectedRepository: string,
  expectedChannel: string,
): LauncherFeedDocument {
  if (!verifySignedEnvelope(envelope, publicKeyPem)) {
    throw new LauncherUpdateError('LAUNCHER_FEED_SIGNATURE', 'Launcher update feed signature verification failed.');
  }
  const document = envelope.document as LauncherFeedDocument;
  if (document.schema !== LAUNCHER_FEED_SCHEMA) {
    throw new LauncherUpdateError('LAUNCHER_FEED_SCHEMA', 'Unsupported launcher update feed schema.');
  }
  if (document.kind !== LAUNCHER_KIND) {
    throw new LauncherUpdateError('LAUNCHER_FEED_KIND', 'Launcher update feed kind mismatch.');
  }
  const sequence = requirePositiveInt(document.update_sequence, 'update_sequence');
  const minimumSequence = requirePositiveInt(document.minimum_supported_sequence, 'minimum_supported_sequence');
  if (minimumSequence > sequence) {
    throw new LauncherUpdateError('LAUNCHER_FEED_SEQUENCE', 'Launcher minimum sequence exceeds update sequence.');
  }
  const channel = requireString(document.channel, 'channel');
  if (channel !== expectedChannel) {
    throw new LauncherUpdateError('LAUNCHER_FEED_CHANNEL', 'Launcher update feed channel mismatch.');
  }
  const asset = document.asset;
  const repository = requireString(asset?.repository, 'asset.repository');
  if (repository.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new LauncherUpdateError('LAUNCHER_FEED_REPOSITORY', 'Launcher update feed repository mismatch.');
  }
  const releaseTag = requireString(asset?.release_tag, 'asset.release_tag');
  if (releaseTag !== `launcher-update-${sequence}`) {
    throw new LauncherUpdateError('LAUNCHER_FEED_TAG', 'Launcher release tag does not match its sequence.');
  }
  const name = requireString(asset?.name, 'asset.name');
  if (path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new LauncherUpdateError('LAUNCHER_FEED_ASSET', 'Launcher asset name is unsafe.');
  }
  if (!/^WorkKitLauncher-v.+-update-\d+\.zip$/i.test(name)) {
    throw new LauncherUpdateError('LAUNCHER_FEED_ASSET', 'Launcher asset name is invalid.');
  }
  if (!Number.isInteger(asset.size) || asset.size < 1) {
    throw new LauncherUpdateError('LAUNCHER_FEED_ASSET', 'Launcher asset size is invalid.');
  }
  assertHexSha256(asset.sha256, 'asset.sha256');
  try {
    buildUpdateAssetUrl({ repository, releaseTag, name });
  } catch {
    throw new LauncherUpdateError('LAUNCHER_FEED_ASSET', 'Launcher asset URL is invalid.');
  }
  return document;
}

export async function checkLauncherUpdateRemote(
  cqrRoot: string,
  opts?: { signal?: AbortSignal },
): Promise<LauncherUpdateCheckResult> {
  const manifest = readLauncherManifest(cqrRoot);
  if (!manifest) {
    return {
      feed_url: null,
      feed_sequence: null,
      installed_sequence: null,
      update_available: false,
    };
  }
  const installedSequence = manifest.update_sequence;
  const feedUrlText = manifest.update_feed_url.trim();
  let feedUrl: URL;
  try {
    feedUrl = new URL(feedUrlText);
  } catch {
    return {
      feed_url: feedUrlText,
      feed_sequence: null,
      installed_sequence: installedSequence,
      update_available: false,
    };
  }
  const configuredFeedHost = feedUrl.hostname;
  try {
    ensureTrustedFeedUrl(feedUrl, configuredFeedHost);
    const publicKeyPem = resolveLauncherPublicKey(cqrRoot);
    const response = await fetch(feedUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'MYAgent-LauncherUpdater/1' },
      signal: opts?.signal,
    });
    if (response.status === 404) {
      return {
        feed_url: feedUrlText,
        feed_sequence: null,
        installed_sequence: installedSequence,
        update_available: false,
      };
    }
    if (!response.ok) {
      throw new LauncherUpdateError('LAUNCHER_FEED_HTTP', `Launcher feed HTTP ${response.status}.`);
    }
    if (response.url) ensureTrustedFeedUrl(new URL(response.url), configuredFeedHost);
    const feedBytes = await readLimited(response, MAX_FEED_BYTES);
    const envelope = parseSignedEnvelope(feedBytes);
    const feed = verifyLauncherFeedEnvelope(
      envelope,
      publicKeyPem,
      manifest.update_repository,
      manifest.update_channel,
    );
    if (feed.asset.size < 1 || /^0+$/.test(feed.asset.sha256)) {
      return {
        feed_url: feedUrlText,
        feed_sequence: feed.update_sequence,
        installed_sequence: installedSequence,
        update_available: false,
        version: feed.version,
        release_notes: feed.release_notes ?? null,
      };
    }
    if (installedSequence < feed.minimum_supported_sequence) {
      throw new LauncherUpdateError(
        'LAUNCHER_TOO_OLD',
        'Installed WorkKitLauncher is too old for this direct update.',
      );
    }
    return {
      feed_url: feedUrlText,
      feed_sequence: feed.update_sequence,
      installed_sequence: installedSequence,
      update_available: feed.update_sequence > installedSequence,
      version: feed.version,
      release_notes: feed.release_notes ?? null,
    };
  } catch (error) {
    if (error instanceof LauncherUpdateError) throw error;
    return {
      feed_url: feedUrlText,
      feed_sequence: null,
      installed_sequence: installedSequence,
      update_available: false,
    };
  }
}
