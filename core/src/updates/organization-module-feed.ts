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
import {
  buildUpdateAssetUrl,
  hasUpdateAssetUrlTemplate,
  isTrustedUpdateAssetHost,
  isTrustedUpdateFeedHost,
  type TrustedHostOptions,
} from './update-host-policy.js';
import {
  feedUrlCandidates,
  fetchFromMirrors,
  loadReleaseMirrors,
  mirrorAssetUrls,
  mirrorHosts,
  type ReleaseMirror,
} from './update-mirrors.js';
import { resolveOrganizationModuleFeedUrl } from './organization-module-feed-resolve.js';

export { resolveOrganizationModuleFeedUrl } from './organization-module-feed-resolve.js';

const MAX_FEED_BYTES = 1024 * 1024;
const FEED_ATTEMPT_TIMEOUT_MS = 8_000;
const ASSET_ATTEMPT_TIMEOUT_MS = 20_000;
const UPDATER_HEADERS = { 'User-Agent': 'MYAgent-ModuleUpdater/1' };

export interface AvailableModuleUpdate {
  sequence: number;
  version: string;
  channel: string;
  assetName: string;
  assetSize: number;
  releaseTag: string;
  repository: string;
  feedUrl: string;
  /** True when no module is installed yet (first remote install). */
  first_install: boolean;
}

function ensureTrustedFeedUrl(url: URL, trust: TrustedHostOptions): void {
  if (url.protocol !== 'https:') {
    throw new OrganizationModuleError('MODULE_FEED_URL', '모듈 피드는 HTTPS여야 합니다.');
  }
  if (!isTrustedUpdateFeedHost(url.hostname, trust)) {
    throw new OrganizationModuleError(
      'MODULE_FEED_HOST',
      '모듈 피드 호스트가 허용 목록 밖입니다. MY_AGENT_UPDATE_TRUSTED_HOSTS 또는 설치 feed URL 호스트를 확인하세요.',
    );
  }
}

function ensureTrustedAssetUrl(url: URL, trust: TrustedHostOptions): void {
  if (url.protocol !== 'https:') {
    throw new OrganizationModuleError('MODULE_ASSET_URL', '모듈 다운로드는 HTTPS여야 합니다.');
  }
  if (!isTrustedUpdateAssetHost(url.hostname, trust)) {
    throw new OrganizationModuleError(
      'MODULE_ASSET_HOST',
      '모듈 다운로드 호스트가 허용 목록 밖입니다. MY_AGENT_UPDATE_TRUSTED_HOSTS / MY_AGENT_UPDATE_ASSET_HOSTS 를 설정하세요.',
    );
  }
}

function buildReleaseAssetUri(repository: string, releaseTag: string, name: string): URL {
  try {
    return buildUpdateAssetUrl({ repository, releaseTag, name });
  } catch {
    throw new OrganizationModuleError('MODULE_REPO', 'Signed update repository is invalid.');
  }
}

interface FeedMirrorContext {
  mirrors: ReleaseMirror[];
  candidates: URL[];
  trust: TrustedHostOptions;
}

function feedMirrorContext(cqrRoot: string, feedUrlText: string): FeedMirrorContext {
  const mirrors = loadReleaseMirrors(cqrRoot);
  const candidates = feedUrlCandidates(feedUrlText, mirrors).map((u) => new URL(u));
  const trust: TrustedHostOptions = {
    configuredFeedHost: new URL(feedUrlText).hostname,
    extraHosts: mirrorHosts(mirrors),
  };
  for (const url of candidates) ensureTrustedFeedUrl(url, trust);
  return { mirrors, candidates, trust };
}

async function fetchModuleFeed(ctx: FeedMirrorContext, signal?: AbortSignal): Promise<Response> {
  const { response } = await fetchFromMirrors(ctx.candidates, {
    headers: UPDATER_HEADERS,
    signal,
    attemptTimeoutMs: FEED_ATTEMPT_TIMEOUT_MS,
    validate: (url) => ensureTrustedFeedUrl(url, ctx.trust),
  });
  if (response.url) ensureTrustedFeedUrl(new URL(response.url), ctx.trust);
  return response;
}

/** Ordered asset URLs: env template > mirrors (signed repository mirrored) > GitHub default. */
export function organizationModuleAssetCandidates(
  mirrors: readonly ReleaseMirror[],
  asset: { repository: string; release_tag: string; name: string },
): URL[] {
  const input = { repository: asset.repository, releaseTag: asset.release_tag, name: asset.name };
  if (!hasUpdateAssetUrlTemplate('module')) {
    const urls = mirrorAssetUrls(input, mirrors);
    if (urls.length) return urls;
  }
  return [buildReleaseAssetUri(input.repository, input.releaseTag, input.name)];
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

export async function checkOrganizationModuleUpdate(
  cqrRoot: string,
  opts?: { signal?: AbortSignal },
): Promise<AvailableModuleUpdate | null> {
  const installed = readInstalledOrganizationModule(cqrRoot);
  const feedUrlText = resolveOrganizationModuleFeedUrl(cqrRoot);
  if (!feedUrlText) return null;
  const ctx = feedMirrorContext(cqrRoot, feedUrlText);
  const publicKeyPem = resolveOrganizationModulePublicKey(cqrRoot);
  const response = await fetchModuleFeed(ctx, opts?.signal);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new OrganizationModuleError('MODULE_FEED_HTTP', `모듈 피드를 읽지 못했습니다 (${response.status}).`);
  }
  const feedBytes = await readLimited(response, MAX_FEED_BYTES);
  const envelope = parseSignedEnvelope(feedBytes);
  const feed = verifyFeedEnvelope(envelope, publicKeyPem);
  const firstInstall = !installed;
  if (!firstInstall && feed.update_sequence <= installed.update_sequence) return null;
  return {
    sequence: feed.update_sequence,
    version: feed.version,
    channel: feed.channel,
    assetName: feed.asset.name,
    assetSize: feed.asset.size,
    releaseTag: feed.asset.release_tag,
    repository: feed.asset.repository,
    feedUrl: feedUrlText,
    first_install: firstInstall,
  };
}

export async function applyOrganizationModuleUpdate(
  cqrRoot: string,
  opts?: { signal?: AbortSignal },
): Promise<InstalledOrganizationModule> {
  const installed = readInstalledOrganizationModule(cqrRoot);
  const feedUrlText = resolveOrganizationModuleFeedUrl(cqrRoot);
  if (!feedUrlText) {
    throw new OrganizationModuleError(
      'MODULE_FEED_URL',
      '조직 모듈 피드 URL이 없습니다. ZIP으로 추가하거나 MY_AGENT_ORGANIZATION_MODULE_FEED_URL / deploy-defaults.organization_module_feed_url 을 설정하세요.',
    );
  }
  const ctx = feedMirrorContext(cqrRoot, feedUrlText);
  const publicKeyPem = resolveOrganizationModulePublicKey(cqrRoot);
  const feedResponse = await fetchModuleFeed(ctx, opts?.signal);
  if (!feedResponse.ok) {
    throw new OrganizationModuleError('MODULE_FEED_HTTP', `모듈 피드를 읽지 못했습니다 (${feedResponse.status}).`);
  }
  const feedBytes = await readLimited(feedResponse, MAX_FEED_BYTES);
  const envelope = parseSignedEnvelope(feedBytes);
  const feed = verifyFeedEnvelope(envelope, publicKeyPem);
  if (installed && feed.update_sequence <= installed.update_sequence) {
    throw new OrganizationModuleError('MODULE_NOT_NEWER', '받을 모듈 업데이트가 없습니다.');
  }
  const assetUrls = organizationModuleAssetCandidates(ctx.mirrors, feed.asset);
  for (const url of assetUrls) ensureTrustedAssetUrl(url, ctx.trust);
  const tempDir = path.join(tmpdir(), 'MYAgent', 'module-updates', `${feed.update_sequence}-${randomUUID().replaceAll('-', '')}`);
  mkdirSync(tempDir, { recursive: true });
  const localFeed = path.join(tempDir, `update-feed-${feed.channel}.json`);
  const localZip = path.join(tempDir, feed.asset.name);
  try {
    writeFileSync(localFeed, feedBytes);
    // Mirror fallback covers transport failures only; size/hash mismatch below stops here.
    const { response: assetResponse } = await fetchFromMirrors(assetUrls, {
      headers: UPDATER_HEADERS,
      signal: opts?.signal,
      attemptTimeoutMs: ASSET_ATTEMPT_TIMEOUT_MS,
      validate: (url) => ensureTrustedAssetUrl(url, ctx.trust),
    });
    if (!assetResponse.ok || !assetResponse.body) {
      throw new OrganizationModuleError('MODULE_ASSET_HTTP', `모듈 ZIP을 받지 못했습니다 (${assetResponse.status}).`);
    }
    if (assetResponse.url) ensureTrustedAssetUrl(new URL(assetResponse.url), ctx.trust);
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


const LAUNCH_UPDATE_TIMEOUT_MS = 15_000;

export async function maybeApplyOrganizationModuleOnLaunch(
  cqrRoot: string,
): Promise<{ applied: boolean; version?: string; error?: string }> {
  const check = String(process.env.MY_AGENT_UPDATE_CHECK ?? '').trim();
  if (check === '0') return { applied: false };
  try {
    // Launch only auto-updates an already-installed module (never silent first install).
    const installed = readInstalledOrganizationModule(cqrRoot);
    if (!installed?.update_feed_url?.trim()) return { applied: false };
    const signal = AbortSignal.timeout(LAUNCH_UPDATE_TIMEOUT_MS);
    const update = await checkOrganizationModuleUpdate(cqrRoot, { signal });
    if (!update || update.first_install) return { applied: false };
    const next = await applyOrganizationModuleUpdate(cqrRoot, { signal });
    return { applied: true, version: next.version };
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    const message = aborted
      ? 'MODULE_UPDATE_TIMEOUT'
      : error instanceof OrganizationModuleError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { applied: false, error: message };
  }
}
