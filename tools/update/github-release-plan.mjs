import path from 'node:path';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemVer(version) {
  const value = String(version ?? '').trim();
  const match = SEMVER_RE.exec(value);
  if (!match) throw new Error(`invalid SemVer: ${value || '(empty)'}`);
  const prerelease = match[4]
    ? match[4].split('.').map((part) => {
        if (/^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part)) {
          throw new Error(`invalid SemVer numeric prerelease: ${value}`);
        }
        return /^\d+$/.test(part) ? Number(part) : part;
      })
    : [];
  return { value, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : (a.prerelease.length === 0 ? 1 : -1);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : (av === undefined ? -1 : 1);
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1;
    if (typeof av === 'number') return -1;
    if (typeof bv === 'number') return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function validateUpdateProgression({
  currentFeed,
  nextSequence,
  nextVersion,
  expectedChannel,
  expectedRepository,
  resume = false,
}) {
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    throw new Error('next update sequence must be a positive safe integer');
  }
  parseSemVer(nextVersion);
  if (!currentFeed) {
    if (nextSequence !== 1) throw new Error(`first published update sequence must be 1 (got ${nextSequence})`);
    return 'first-publish';
  }
  const current = currentFeed.document ?? currentFeed;
  const currentSequence = Number(current.update_sequence);
  if (!Number.isSafeInteger(currentSequence) || currentSequence < 1) {
    throw new Error('current channel feed has an invalid update_sequence');
  }
  const currentVersion = String(current.version ?? '').trim();
  parseSemVer(currentVersion);
  if (expectedChannel && current.channel !== expectedChannel) {
    throw new Error(`current channel feed channel mismatch: ${current.channel}`);
  }
  if (expectedRepository && current.asset?.repository !== expectedRepository) {
    throw new Error(`current channel feed repository mismatch: ${current.asset?.repository}`);
  }
  if (resume && nextSequence === currentSequence) {
    if (String(nextVersion) !== currentVersion) {
      throw new Error(`resume must use the already-published version ${currentVersion}`);
    }
    return 'resume-current';
  }
  if (nextSequence !== currentSequence + 1) {
    throw new Error(`update sequence must be exactly ${currentSequence + 1} after published ${currentSequence} (got ${nextSequence})`);
  }
  if (compareSemVer(nextVersion, currentVersion) < 0) {
    throw new Error(`version rollback is forbidden (${nextVersion} < ${currentVersion})`);
  }
  return 'next-update';
}

export function validateGitHubRepository(repository) {
  const value = String(repository ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GitHub repository must use owner/name format');
  }
  return value;
}

export function formatGitHubReleaseTitle(version, updateSequence) {
  return `MY Agent ${String(version ?? '').trim()} (update ${updateSequence})`;
}


export function coreUpdateTag(updateSequence) {
  if (!Number.isSafeInteger(updateSequence) || updateSequence < 1) {
    throw new Error('update sequence must be a positive safe integer');
  }
  return `update-${updateSequence}`;
}


export function isCoreUpdateAssetName(name) {
  const file = path.basename(String(name ?? ''));
  return /^MYAgent-v.+-delta\.zip$/i.test(file) || /^MYAgent-v.+-install.*\.zip$/i.test(file);
}


export function validateGitHubBranch(branch) {
  const value = String(branch ?? '').trim();
  if (!value || value.startsWith('-') || value.includes('..') || /[\s~^:?*\[\]\\]/.test(value)) {
    throw new Error('unsafe GitHub default branch');
  }
  return value;
}

export function buildGitHubReleasePlan({
  repository,
  defaultBranch,
  channel,
  updateSequence,
  version,
  zipPath,
  feedPath,
  releaseNotes = '',
}) {
  const repo = validateGitHubRepository(repository);
  const branch = validateGitHubBranch(defaultBranch);
  const safeChannel = String(channel ?? '').trim();
  if (!/^[a-z0-9-]+$/.test(safeChannel)) throw new Error('invalid update channel');
  if (!Number.isSafeInteger(updateSequence) || updateSequence < 1) {
    throw new Error('update sequence must be a positive safe integer');
  }
  const safeVersion = String(version ?? '').trim();
  const parsedVersion = parseSemVer(safeVersion);
  if (safeChannel === 'stable' && parsedVersion.prerelease.length > 0) {
    throw new Error('stable channel requires a release SemVer without prerelease identifiers');
  }
  const tag = coreUpdateTag(updateSequence);
  const zipName = path.basename(zipPath);
  const feedName = path.basename(feedPath);
  if (zipName !== `MYAgent-v${safeVersion}-delta.zip`) {
    throw new Error(`release payload must be MYAgent-v${safeVersion}-delta.zip`);
  }
  if (feedName !== `update-feed-${safeChannel}.json`) {
    throw new Error(`feed file must be update-feed-${safeChannel}.json`);
  }

  const releaseArgs = [
    'release',
    'create',
    tag,
    zipPath,
    feedPath,
    '--repo',
    repo,
    '--title',
    formatGitHubReleaseTitle(safeVersion, updateSequence),
    '--notes',
    releaseNotes || formatGitHubReleaseTitle(safeVersion, updateSequence),
  ];
  if (safeChannel !== 'stable') releaseArgs.push('--prerelease');

  // Publish tooling default is GitHub raw; private hosts set MY_AGENT_UPDATE_FEED_URL_BASE
  // e.g. https://updates.example.com/feeds/{repository}/{branch} → .../channels/{channel}.json
  const feedUrlBase = String(process.env.MY_AGENT_UPDATE_FEED_URL_BASE ?? '').trim();
  const rawFeedUrl = feedUrlBase
    ? `${feedUrlBase
        .replaceAll('{owner}', encodeURIComponent(repo.split('/')[0]))
        .replaceAll('{repo}', encodeURIComponent(repo.split('/')[1]))
        .replaceAll('{repository}', repo)
        .replaceAll('{branch}', encodeURIComponent(branch))
        .replace(/\/$/, '')}/channels/${safeChannel}.json`
    : `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}`
      + `/channels/${safeChannel}.json`;

  return {
    repository: repo,
    default_branch: branch,
    channel: safeChannel,
    update_sequence: updateSequence,
    version: safeVersion,
    tag,
    release_args: releaseArgs,
    feed_api_path: `repos/${repo}/contents/channels/${safeChannel}.json`,
    feed_branch: branch,
    raw_feed_url: rawFeedUrl,
  };
}


