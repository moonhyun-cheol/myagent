import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  GROUP_ID_RE,
  lockerProfilesRoot,
  resolveLockerRootForCqr,
  SHELF_ID_RE,
  type ShelfGroupMeta,
  type ShelfInstallStatus,
  type WorkKitCatalogFeedDoc,
  type WorkKitFeedShelf,
  catalogFeedCachePath,
  readCatalogFeedCache,
  writeCatalogFeedCache,
  writeInstallMeta,
  readInstallMeta,
} from '../config/profile-locker.js';
import { assertHexSha256, sha256File } from './organization-module-crypto.js';
import {
  buildWorkKitAssetUrl,
  hasUpdateAssetUrlTemplate,
  isTrustedUpdateAssetHost,
  isTrustedUpdateFeedHost,
  resolveWorkKitAssetUrlMode,
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
import { resolveWorkKitCatalogFeedUrl } from './work-kit-catalog-feed-resolve.js';

export { resolveWorkKitCatalogFeedUrl } from './work-kit-catalog-feed-resolve.js';

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const FEED_ATTEMPT_TIMEOUT_MS = 8_000;
const ASSET_ATTEMPT_TIMEOUT_MS = 20_000;
const CATALOG_HEADERS = { 'User-Agent': 'MYAgent-WorkKitCatalog/1' };

export class WorkKitCatalogError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WorkKitCatalogCheckResult {
  feed_url: string | null;
  feed_sequence: number | null;
  cached_sequence: number | null;
  update_available: boolean;
  feed_host?: string | null;
  asset_url_mode?: ReturnType<typeof resolveWorkKitAssetUrlMode>;
}

export interface WorkKitCatalogConfig {
  feed_url: string | null;
  feed_configured: boolean;
  feed_host: string | null;
  asset_url_mode: ReturnType<typeof resolveWorkKitAssetUrlMode>;
  migration_hint: string;
}

export function describeWorkKitCatalogConfig(cqrRoot: string): WorkKitCatalogConfig {
  const mirrors = loadReleaseMirrors(cqrRoot);
  const rawFeedUrl = resolveWorkKitCatalogFeedUrl(cqrRoot);
  const feedUrl = rawFeedUrl ? (feedUrlCandidates(rawFeedUrl, mirrors)[0] ?? rawFeedUrl) : null;
  let feedHost: string | null = null;
  if (feedUrl) {
    try {
      feedHost = new URL(feedUrl).hostname;
    } catch {
      feedHost = null;
    }
  }
  const assetMode = resolveWorkKitAssetUrlMode(mirrors.length > 0);
  const hints: Record<typeof assetMode, string> = {
    mirrors: `미러 순서: ${mirrors.map((m) => m.id).join(' → ')}. 전송 실패(네트워크·404·5xx)만 다음 미러로 넘깁니다.`,
    github_default: 'GitHub 기본 URL. 자사 서버 사용 시 deploy-defaults.organization_release_mirrors 또는 MY_AGENT_WORK_KIT_ASSET_URL_TEMPLATE + MY_AGENT_UPDATE_TRUSTED_HOSTS 설정.',
    kit_template: 'Custom asset template active. Feed URL만 교체하면 호스트 이전 가능.',
    update_template: 'Custom asset template active. Feed URL만 교체하면 호스트 이전 가능.',
  };
  return {
    feed_url: feedUrl,
    feed_configured: Boolean(feedUrl),
    feed_host: feedHost,
    asset_url_mode: assetMode,
    migration_hint: hints[assetMode],
  };
}

function ensureTrustedFeedUrl(url: URL, trust: TrustedHostOptions): void {
  if (url.protocol !== 'https:' && url.protocol !== 'file:') {
    throw new WorkKitCatalogError('KIT_FEED_URL', '작업 키트 카탈로그 피드는 HTTPS여야 합니다.');
  }
  if (url.protocol === 'file:') return;
  if (!isTrustedUpdateFeedHost(url.hostname, trust)) {
    throw new WorkKitCatalogError(
      'KIT_FEED_HOST',
      '작업 키트 피드 호스트가 허용 목록 밖입니다. MY_AGENT_UPDATE_TRUSTED_HOSTS 또는 feed URL 호스트를 확인하세요.',
    );
  }
}

function ensureTrustedAssetUrl(url: URL, trust: TrustedHostOptions): void {
  if (url.protocol === 'file:') return;
  if (url.protocol !== 'https:') {
    throw new WorkKitCatalogError('KIT_ASSET_URL', '작업 키트 다운로드는 HTTPS여야 합니다.');
  }
  if (!isTrustedUpdateAssetHost(url.hostname, trust)) {
    throw new WorkKitCatalogError(
      'KIT_ASSET_HOST',
      '작업 키트 다운로드 호스트가 허용 목록 밖입니다.',
    );
  }
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > limit) {
    throw new WorkKitCatalogError('KIT_FEED_TOO_LARGE', '카탈로그 피드가 너무 큽니다.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) {
    throw new WorkKitCatalogError('KIT_FEED_TOO_LARGE', '카탈로그 피드 크기 제한을 초과했습니다.');
  }
  return bytes;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function parseFeedDoc(raw: unknown): WorkKitCatalogFeedDoc {
  if (!raw || typeof raw !== 'object') {
    throw new WorkKitCatalogError('KIT_FEED_INVALID', '카탈로그 피드 JSON이 올바르지 않습니다.');
  }
  const doc = raw as WorkKitCatalogFeedDoc;
  const sequence = Number(doc.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new WorkKitCatalogError('KIT_FEED_INVALID', '카탈로그 sequence가 올바르지 않습니다.');
  }
  if (!Array.isArray(doc.groups)) {
    throw new WorkKitCatalogError('KIT_FEED_INVALID', '카탈로그 groups 배열이 필요합니다.');
  }
  return {
    channel: String(doc.channel ?? 'stable').trim() || 'stable',
    sequence,
    groups: doc.groups,
  };
}

function resolveFeedSource(
  cqrRoot: string,
  opts?: { feedUrl?: string; feedPath?: string },
): {
  url: string | null;
  filePath: string | null;
  configuredHost?: string;
  mirrors: ReleaseMirror[];
  trust: TrustedHostOptions;
} {
  const mirrors = loadReleaseMirrors(cqrRoot);
  const extraHosts = mirrorHosts(mirrors);
  if (opts?.feedPath?.trim()) {
    return { url: null, filePath: path.resolve(opts.feedPath), mirrors, trust: { extraHosts } };
  }
  const url = opts?.feedUrl?.trim() || resolveWorkKitCatalogFeedUrl(cqrRoot);
  if (!url) return { url: null, filePath: null, mirrors, trust: { extraHosts } };
  if (/^file:\/\//i.test(url) || (!/^https?:\/\//i.test(url) && existsSync(url))) {
    const filePath = url.startsWith('file:')
      ? fileURLToPathSafe(url)
      : path.resolve(url);
    return { url: null, filePath, mirrors, trust: { extraHosts } };
  }
  const parsed = new URL(url);
  return {
    url,
    filePath: null,
    configuredHost: parsed.hostname,
    mirrors,
    trust: { configuredFeedHost: parsed.hostname, extraHosts },
  };
}

function fileURLToPathSafe(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'file:') throw new WorkKitCatalogError('KIT_FEED_URL', 'file URL이 아닙니다.');
  return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

async function loadFeedBytes(
  cqrRoot: string,
  opts?: { feedUrl?: string; feedPath?: string; signal?: AbortSignal },
): Promise<{ bytes: Buffer; feedUrl: string | null; configuredHost?: string }> {
  const source = resolveFeedSource(cqrRoot, opts);
  if (source.filePath) {
    if (!existsSync(source.filePath)) {
      throw new WorkKitCatalogError('KIT_FEED_NOT_FOUND', `카탈로그 파일을 찾을 수 없습니다: ${source.filePath}`);
    }
    return {
      bytes: readFileSync(source.filePath),
      feedUrl: `file://${source.filePath}`,
      configuredHost: undefined,
    };
  }
  if (!source.url) {
    throw new WorkKitCatalogError(
      'KIT_FEED_URL',
      '작업 키트 카탈로그 피드 URL이 없습니다. MY_AGENT_WORK_KIT_CATALOG_FEED_URL 또는 deploy-defaults.work_kit_catalog_feed_url 을 설정하세요.',
    );
  }
  const candidates = feedUrlCandidates(source.url, source.mirrors).map((u) => new URL(u));
  for (const url of candidates) ensureTrustedFeedUrl(url, source.trust);
  const { response, url: usedUrl } = await fetchFromMirrors(candidates, {
    headers: CATALOG_HEADERS,
    signal: opts?.signal,
    attemptTimeoutMs: FEED_ATTEMPT_TIMEOUT_MS,
    validate: (url) => ensureTrustedFeedUrl(url, source.trust),
  });
  if (!response.ok) {
    throw new WorkKitCatalogError('KIT_FEED_HTTP', `카탈로그 피드를 읽지 못했습니다 (${response.status}).`);
  }
  if (response.url) ensureTrustedFeedUrl(new URL(response.url), source.trust);
  const bytes = await readLimited(response, MAX_FEED_BYTES);
  return { bytes, feedUrl: usedUrl.href, configuredHost: source.configuredHost };
}

export function findFeedShelf(
  feed: WorkKitCatalogFeedDoc,
  group: string,
  id: string,
): { group: ShelfGroupMeta; shelf: WorkKitFeedShelf } | null {
  const g = feed.groups.find((x) => x.id === group);
  if (!g) return null;
  const shelf = (g.shelves ?? []).find((s) => s.id === id);
  if (!shelf) return null;
  return {
    group: {
      id: g.id,
      label: String(g.label ?? g.id).trim() || g.id,
      order: typeof g.order === 'number' ? g.order : 100,
    },
    shelf,
  };
}

export function checkWorkKitCatalogUpdate(
  cqrRoot: string,
  opts?: { lockerRoot?: string },
): WorkKitCatalogCheckResult {
  const lockerRoot = opts?.lockerRoot?.trim()
    ? path.resolve(opts.lockerRoot)
    : resolveLockerRootForCqr(cqrRoot);
  const feedUrl = resolveWorkKitCatalogFeedUrl(cqrRoot);
  const cached = readCatalogFeedCache(lockerRoot);
  return {
    feed_url: feedUrl,
    feed_sequence: null,
    cached_sequence: cached?.sequence ?? null,
    update_available: false,
  };
}

export async function checkWorkKitCatalogUpdateRemote(
  cqrRoot: string,
  opts?: { lockerRoot?: string; signal?: AbortSignal },
): Promise<WorkKitCatalogCheckResult> {
  const lockerRoot = opts?.lockerRoot?.trim()
    ? path.resolve(opts.lockerRoot)
    : resolveLockerRootForCqr(cqrRoot);
  const rawFeedUrl = resolveWorkKitCatalogFeedUrl(cqrRoot);
  const mirrors = loadReleaseMirrors(cqrRoot);
  const feedUrl = rawFeedUrl ? (feedUrlCandidates(rawFeedUrl, mirrors)[0] ?? rawFeedUrl) : null;
  const cached = readCatalogFeedCache(lockerRoot);
  if (!feedUrl) {
    return {
      feed_url: null,
      feed_sequence: null,
      cached_sequence: cached?.sequence ?? null,
      update_available: false,
    };
  }
  try {
    const { bytes } = await loadFeedBytes(cqrRoot, { signal: opts?.signal });
    const feed = parseFeedDoc(JSON.parse(bytes.toString('utf8')));
    return {
      feed_url: feedUrl,
      feed_sequence: feed.sequence,
      cached_sequence: cached?.sequence ?? null,
      update_available: !cached || feed.sequence > cached.sequence,
      feed_host: (() => {
        try { return new URL(feedUrl).hostname; } catch { return null; }
      })(),
      asset_url_mode: resolveWorkKitAssetUrlMode(mirrors.length > 0),
    };
  } catch {
    return {
      feed_url: feedUrl,
      feed_sequence: null,
      cached_sequence: cached?.sequence ?? null,
      update_available: false,
    };
  }
}

export async function refreshWorkKitCatalog(
  cqrRoot: string,
  opts?: { lockerRoot?: string; feedUrl?: string; feedPath?: string; signal?: AbortSignal },
): Promise<WorkKitCatalogFeedDoc> {
  const lockerRoot = opts?.lockerRoot?.trim()
    ? path.resolve(opts.lockerRoot)
    : resolveLockerRootForCqr(cqrRoot);
  const { bytes, feedUrl } = await loadFeedBytes(cqrRoot, {
    feedUrl: opts?.feedUrl,
    feedPath: opts?.feedPath,
    signal: opts?.signal,
  });
  const feed = parseFeedDoc(JSON.parse(bytes.toString('utf8')));
  writeCatalogFeedCache(lockerRoot, {
    ...feed,
    feed_url: feedUrl,
    cached_at: new Date().toISOString(),
  });
  return feed;
}

/** Ordered shelf asset URLs: direct url > env template > mirrors > GitHub default. */
export function resolveShelfAssetUrls(
  asset: WorkKitFeedShelf['asset'],
  trust: TrustedHostOptions,
  mirrors: readonly ReleaseMirror[] = [],
): URL[] {
  if (!asset) {
    throw new WorkKitCatalogError('KIT_ASSET_MISSING', '이 키트에는 설치용 asset이 없습니다.');
  }
  const direct = asset.url?.trim();
  if (direct) {
    const url = direct.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(direct) || direct.startsWith('/')
      ? new URL(direct.startsWith('file:') ? direct : `file://${direct}`)
      : new URL(direct);
    ensureTrustedAssetUrl(url, trust);
    return [url];
  }
  const repo = asset.repository?.trim();
  const tag = asset.release_tag?.trim();
  const name = asset.name?.trim();
  if (repo && tag && name) {
    const input = { repository: repo, releaseTag: tag, name };
    const mirrored = hasUpdateAssetUrlTemplate('work_kit') ? [] : mirrorAssetUrls(input, mirrors);
    const urls = mirrored.length ? mirrored : [buildWorkKitAssetUrl(input)];
    for (const url of urls) ensureTrustedAssetUrl(url, trust);
    return urls;
  }
  throw new WorkKitCatalogError('KIT_ASSET_MISSING', 'asset.url 또는 repository/release_tag/name 이 필요합니다.');
}

function extractTarGz(archivePath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'pipe' });
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function downloadAssetToFile(
  assetUrls: URL[],
  destPath: string,
  opts: { expectedSize?: number; expectedSha256?: string; trust: TrustedHostOptions; signal?: AbortSignal },
): Promise<void> {
  const assetUrl = assetUrls[0];
  if (!assetUrl) {
    throw new WorkKitCatalogError('KIT_ASSET_MISSING', '설치용 asset URL이 없습니다.');
  }
  if (assetUrl.protocol === 'file:') {
    const src = fileURLToPathSafe(assetUrl.href);
    if (!existsSync(src)) {
      throw new WorkKitCatalogError('KIT_ASSET_NOT_FOUND', `에셋 파일을 찾을 수 없습니다: ${src}`);
    }
    const bytes = readFileSync(src);
    if (opts.expectedSize && bytes.length !== opts.expectedSize) {
      throw new WorkKitCatalogError('KIT_ASSET_SIZE', '에셋 크기가 피드와 일치하지 않습니다.');
    }
    if (opts.expectedSha256 && sha256Buffer(bytes) !== assertHexSha256(opts.expectedSha256, 'sha256')) {
      throw new WorkKitCatalogError('KIT_ASSET_HASH', '에셋 해시가 피드와 일치하지 않습니다.');
    }
    writeFileSync(destPath, bytes);
    return;
  }
  // Mirror fallback covers transport failures only; size/hash mismatch below stops here.
  const { response } = await fetchFromMirrors(assetUrls, {
    headers: CATALOG_HEADERS,
    signal: opts.signal,
    attemptTimeoutMs: ASSET_ATTEMPT_TIMEOUT_MS,
    validate: (url) => ensureTrustedAssetUrl(url, opts.trust),
  });
  if (!response.ok || !response.body) {
    throw new WorkKitCatalogError('KIT_ASSET_HTTP', `키트 에셋을 받지 못했습니다 (${response.status}).`);
  }
  if (response.url) ensureTrustedAssetUrl(new URL(response.url), opts.trust);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (opts.expectedSize && length && length !== opts.expectedSize) {
    throw new WorkKitCatalogError('KIT_ASSET_SIZE', '에셋 크기가 피드와 일치하지 않습니다.');
  }
  await pipeline(response.body, createWriteStream(destPath));
  const size = readFileSync(destPath).length;
  if (size > MAX_ASSET_BYTES) {
    rmSync(destPath, { force: true });
    throw new WorkKitCatalogError('KIT_ASSET_TOO_LARGE', '키트 에셋이 너무 큽니다.');
  }
  if (opts.expectedSize && size !== opts.expectedSize) {
    throw new WorkKitCatalogError('KIT_ASSET_SIZE', '다운로드한 에셋 크기가 피드와 일치하지 않습니다.');
  }
  if (opts.expectedSha256 && sha256File(destPath) !== assertHexSha256(opts.expectedSha256, 'sha256')) {
    rmSync(destPath, { force: true });
    throw new WorkKitCatalogError('KIT_ASSET_HASH', '다운로드한 에셋 해시가 피드와 일치하지 않습니다.');
  }
}

function normalizeExtractedShelf(
  extractRoot: string,
  group: string,
  id: string,
): string {
  const direct = path.join(extractRoot, 'shelf.json');
  if (existsSync(direct)) return extractRoot;
  const nested = path.join(extractRoot, 'profiles', group, id, 'shelf.json');
  if (existsSync(nested)) return path.join(extractRoot, 'profiles', group, id);
  const nested2 = path.join(extractRoot, group, id, 'shelf.json');
  if (existsSync(nested2)) return path.join(extractRoot, group, id);
  throw new WorkKitCatalogError('KIT_ASSET_LAYOUT', '에셋에 shelf.json이 없습니다.');
}

function writeShelfFromFeedMeta(
  destDir: string,
  group: string,
  shelf: WorkKitFeedShelf,
): void {
  mkdirSync(destDir, { recursive: true });
  const doc = {
    schema_version: 1,
    id: shelf.id,
    group,
    label: shelf.label,
    description: shelf.description,
    pull: shelf.pull ?? [],
    plugins: shelf.plugins ?? { enable: {} },
    features: shelf.features,
    hints: shelf.hints,
    min_core_sequence: shelf.min_core_sequence,
  };
  writeFileSync(path.join(destDir, 'shelf.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export async function installWorkKitShelf(
  cqrRoot: string,
  group: string,
  id: string,
  opts?: {
    lockerRoot?: string;
    feedPath?: string;
    signal?: AbortSignal;
    forceMetaOnly?: boolean;
  },
): Promise<{ group: string; id: string; shelf_dir: string; asset_sequence: number }> {
  if (!GROUP_ID_RE.test(group) || !SHELF_ID_RE.test(id)) {
    throw new WorkKitCatalogError('KIT_INVALID_ID', 'group/id 형식이 올바르지 않습니다.');
  }
  const lockerRoot = opts?.lockerRoot?.trim()
    ? path.resolve(opts.lockerRoot)
    : resolveLockerRootForCqr(cqrRoot);
  let feed = readCatalogFeedCache(lockerRoot);
  if (!feed) {
    feed = await refreshWorkKitCatalog(cqrRoot, {
      lockerRoot,
      feedPath: opts?.feedPath,
      signal: opts?.signal,
    });
  }
  const found = findFeedShelf(feed, group, id);
  if (!found) {
    throw new WorkKitCatalogError('KIT_NOT_IN_CATALOG', `카탈로그에 키트가 없습니다: ${group}/${id}`);
  }
  const { shelf } = found;
  const assetSeq = shelf.asset?.sequence ?? 1;
  const groupDir = path.join(lockerProfilesRoot(lockerRoot), group);
  const destDir = path.join(groupDir, id);
  mkdirSync(groupDir, { recursive: true });
  if (!existsSync(path.join(groupDir, 'group.json'))) {
    writeFileSync(
      path.join(groupDir, 'group.json'),
      `${JSON.stringify(found.group, null, 2)}\n`,
      'utf8',
    );
  }

  if (!shelf.asset || opts?.forceMetaOnly) {
    writeShelfFromFeedMeta(destDir, group, shelf);
    writeInstallMeta(destDir, { asset_sequence: assetSeq, installed_at: new Date().toISOString() });
    return { group, id, shelf_dir: destDir, asset_sequence: assetSeq };
  }

  const source = resolveFeedSource(cqrRoot, { feedPath: opts?.feedPath });
  const assetUrls = resolveShelfAssetUrls(shelf.asset, source.trust, source.mirrors);
  const tempDir = path.join(tmpdir(), 'MYAgent', 'work-kit-install', `${group}-${id}-${randomUUID().replaceAll('-', '')}`);
  mkdirSync(tempDir, { recursive: true });
  const archivePath = path.join(tempDir, shelf.asset.name || `${group}-${id}.tar.gz`);
  const extractRoot = path.join(tempDir, 'extract');
  try {
    await downloadAssetToFile(assetUrls, archivePath, {
      expectedSize: shelf.asset.size,
      expectedSha256: shelf.asset.sha256,
      trust: source.trust,
      signal: opts?.signal,
    });
    extractTarGz(archivePath, extractRoot);
    const srcShelfDir = normalizeExtractedShelf(extractRoot, group, id);
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(path.dirname(destDir), { recursive: true });
    cpSync(srcShelfDir, destDir, { recursive: true });
    writeInstallMeta(destDir, { asset_sequence: assetSeq, installed_at: new Date().toISOString() });
    return { group, id, shelf_dir: destDir, asset_sequence: assetSeq };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function uninstallWorkKitShelf(
  cqrRoot: string,
  group: string,
  id: string,
  opts?: { lockerRoot?: string },
): boolean {
  if (!GROUP_ID_RE.test(group) || !SHELF_ID_RE.test(id)) return false;
  const lockerRoot = opts?.lockerRoot?.trim()
    ? path.resolve(opts.lockerRoot)
    : resolveLockerRootForCqr(cqrRoot);
  const destDir = path.join(lockerProfilesRoot(lockerRoot), group, id);
  if (!existsSync(destDir)) return false;
  rmSync(destDir, { recursive: true, force: true });
  return true;
}

export function shelfInstallStatus(
  feedShelf: WorkKitFeedShelf | undefined,
  lockerShelfDir: string | null,
): ShelfInstallStatus {
  if (!feedShelf?.asset && !lockerShelfDir) return 'missing_asset';
  if (!lockerShelfDir || !existsSync(path.join(lockerShelfDir, 'shelf.json'))) {
    return feedShelf?.asset ? 'available' : 'missing_asset';
  }
  const meta = readInstallMeta(lockerShelfDir);
  const feedSeq = feedShelf?.asset?.sequence ?? 0;
  const installedSeq = meta?.asset_sequence ?? 0;
  if (feedSeq > installedSeq) return 'update_available';
  return 'installed';
}
