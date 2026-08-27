import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  OrganizationModuleError,
  assertHexSha256,
  parseSignedEnvelope,
  sha256File,
} from './organization-module-crypto.js';
import {
  installOrganizationModule,
  readInstalledOrganizationModule,
  resolveOrganizationModulePublicKey,
  verifyFeedEnvelope,
  type InstalledOrganizationModule,
} from './organization-module-installer.js';

const MAX_FEED_BYTES = 1024 * 1024;

export interface AvailableModuleUpdate {
  sequence: number;
  version: string;
  channel: string;
  assetName: string;
  assetSize: number;
  releaseTag: string;
  repository: string;
  feedUrl: string;
}

function ensureTrustedFeedUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new OrganizationModuleError('MODULE_FEED_URL', '모듈 피드는 HTTPS여야 합니다.');
  }
  if (url.hostname.toLowerCase() !== 'raw.githubusercontent.com') {
    throw new OrganizationModuleError('MODULE_FEED_HOST', '모듈 피드는 raw.githubusercontent.com 만 허용합니다.');
  }
}

function ensureTrustedAssetUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new OrganizationModuleError('MODULE_ASSET_URL', '모듈 다운로드는 HTTPS여야 합니다.');
  }
  const host = url.hostname.toLowerCase();
  const trusted = host === 'github.com'
    || host === 'objects.githubusercontent.com'
    || host === 'release-assets.githubusercontent.com'
    || host.endsWith('.githubusercontent.com');
  if (!trusted) {
    throw new OrganizationModuleError('MODULE_ASSET_HOST', '모듈 다운로드 호스트가 허용 목록 밖입니다.');
  }
}

function buildReleaseAssetUri(repository: string, releaseTag: string, name: string): URL {
  const parts = repository.split('/');
  if (parts.length !== 2) {
    throw new OrganizationModuleError('MODULE_REPO', 'Signed update repository is invalid.');
  }
  return new URL(
    `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(name)}`,
  );
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > limit) {
    throw new OrganizationModuleError('MODULE_FEED_TOO_LARGE', 'Update feed is too large.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) {
    throw new OrganizationModuleError('MODULE_FEED_TOO_LARGE', 'Update feed exceeded its size limit.');
  }
  return bytes;
}

export async function checkOrganizationModuleUpdate(cqrRoot: string): Promise<AvailableModuleUpdate | null> {
  const installed = readInstalledOrganizationModule(cqrRoot);
  const feedUrlText = installed?.update_feed_url?.trim();
  if (!feedUrlText) return null;
  const feedUrl = new URL(feedUrlText);
  ensureTrustedFeedUrl(feedUrl);
  const publicKeyPem = resolveOrganizationModulePublicKey(cqrRoot);
  const response = await fetch(feedUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'MYAgent-ModuleUpdater/1' },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new OrganizationModuleError('MODULE_FEED_HTTP', `모듈 피드를 읽지 못했습니다 (${response.status}).`);
  }
  if (response.url) ensureTrustedFeedUrl(new URL(response.url));
  const feedBytes = await readLimited(response, MAX_FEED_BYTES);
  const envelope = parseSignedEnvelope(feedBytes);
  const feed = verifyFeedEnvelope(envelope, publicKeyPem);
  if (installed && feed.update_sequence <= installed.update_sequence) return null;
  return {
    sequence: feed.update_sequence,
    version: feed.version,
    channel: feed.channel,
    assetName: feed.asset.name,
    assetSize: feed.asset.size,
    releaseTag: feed.asset.release_tag,
    repository: feed.asset.repository,
    feedUrl: feedUrlText,
  };
}

export async function applyOrganizationModuleUpdate(cqrRoot: string): Promise<InstalledOrganizationModule> {
  const installed = readInstalledOrganizationModule(cqrRoot);
  const feedUrlText = installed?.update_feed_url?.trim();
  if (!feedUrlText) {
    throw new OrganizationModuleError('MODULE_FEED_URL', '설치된 모듈에 update_feed_url 이 없습니다.');
  }
  const feedUrl = new URL(feedUrlText);
  ensureTrustedFeedUrl(feedUrl);
  const publicKeyPem = resolveOrganizationModulePublicKey(cqrRoot);
  const feedResponse = await fetch(feedUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'MYAgent-ModuleUpdater/1' },
  });
  if (!feedResponse.ok) {
    throw new OrganizationModuleError('MODULE_FEED_HTTP', `모듈 피드를 읽지 못했습니다 (${feedResponse.status}).`);
  }
  const feedBytes = await readLimited(feedResponse, MAX_FEED_BYTES);
  const envelope = parseSignedEnvelope(feedBytes);
  const feed = verifyFeedEnvelope(envelope, publicKeyPem);
  if (installed && feed.update_sequence <= installed.update_sequence) {
    throw new OrganizationModuleError('MODULE_NOT_NEWER', '받을 모듈 업데이트가 없습니다.');
  }
  const assetUrl = buildReleaseAssetUri(feed.asset.repository, feed.asset.release_tag, feed.asset.name);
  ensureTrustedAssetUrl(assetUrl);
  const tempDir = path.join(tmpdir(), 'MYAgent', 'module-updates', `${feed.update_sequence}-${randomUUID().replaceAll('-', '')}`);
  mkdirSync(tempDir, { recursive: true });
  const localFeed = path.join(tempDir, `update-feed-${feed.channel}.json`);
  const localZip = path.join(tempDir, feed.asset.name);
  try {
    writeFileSync(localFeed, feedBytes);
    const assetResponse = await fetch(assetUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'MYAgent-ModuleUpdater/1' },
    });
    if (!assetResponse.ok || !assetResponse.body) {
      throw new OrganizationModuleError('MODULE_ASSET_HTTP', `모듈 ZIP을 받지 못했습니다 (${assetResponse.status}).`);
    }
    if (assetResponse.url) ensureTrustedAssetUrl(new URL(assetResponse.url));
    const length = Number(assetResponse.headers.get('content-length') ?? '0');
    if (length && length !== feed.asset.size) {
      throw new OrganizationModuleError('MODULE_ZIP_SIZE', 'Downloaded update size does not match signed feed.');
    }
    await pipeline(assetResponse.body, createWriteStream(localZip));
    if (sha256File(localZip) !== assertHexSha256(feed.asset.sha256, 'asset sha256')) {
      throw new OrganizationModuleError('MODULE_ZIP_HASH', 'Downloaded update hash does not match signed feed.');
    }
    const result = installOrganizationModule({
      cqrRoot,
      zipPath: localZip,
      feedPath: localFeed,
      publicKeyPem,
    });
    return result.installed;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
