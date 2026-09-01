import path from 'node:path';

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
  if (!safeVersion) throw new Error('version is required');
  const tag = `update-${updateSequence}`;
  const zipName = path.basename(zipPath);
  const feedName = path.basename(feedPath);
  if (!zipName.toLowerCase().endsWith('.zip')) throw new Error('release payload must be a zip');
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
