#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildGitHubReleasePlan } from './update/github-release-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const args = new Set(process.argv.slice(2));
const confirmed = args.has('--confirm');
const skipBuild = args.has('--skip-build');
const resume = args.has('--resume');

function fail(message) {
  console.error(`publish-github-update: ${message}`);
  process.exit(1);
}

function run(commandArgs, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync('gh', commandArgs, {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
    shell: false,
  });
  if (result.error) fail(`gh could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : '';
    fail(`gh ${commandArgs.slice(0, 2).join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

if (!skipBuild) {
  const build = spawnSync(process.execPath, [path.join(root, 'tools', 'publish-secure-update.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
} else {
  const preflightArgs = [path.join(root, 'tools', 'release-preflight.mjs'), '--check-only'];
  if (process.env.MY_AGENT_RELEASE_ALLOW_DIRTY === '1') preflightArgs.push('--allow-dirty');
  const preflight = spawnSync(process.execPath, preflightArgs, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (preflight.status !== 0) process.exit(preflight.status ?? 1);
}

const latestPath = path.join(outDir, 'LATEST_SECURE_UPDATE.json');
if (!existsSync(latestPath)) fail('LATEST_SECURE_UPDATE.json missing; run npm run publish:update');
const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (
  latest.version !== manifest.version
  || latest.channel !== manifest.update_channel
  || Number(latest.update_sequence) !== Number(manifest.update_sequence)
) {
  fail('existing secure update artifacts do not match manifest.json');
}
const zipPath = path.resolve(latest.zip_path);
const feedPath = path.resolve(latest.feed_path);
if (!existsSync(zipPath) || !existsSync(feedPath)) {
  fail('secure update payload/feed files are missing');
}

const repository = String(
  process.env.MY_AGENT_UPDATE_GITHUB_REPO
  ?? latest.github_repository
  ?? 'moonhyun-cheol/MY_CUSTOM_CODEX',
).trim();
const repoView = run(
  ['repo', 'view', repository, '--json', 'nameWithOwner,visibility,defaultBranchRef,url'],
  { capture: true },
);
const repo = JSON.parse(repoView.stdout);
if (repo.visibility !== 'PUBLIC') {
  fail(`${repository} must be PUBLIC for login-free client updates`);
}
const defaultBranch = repo.defaultBranchRef?.name;
if (!defaultBranch) fail(`${repository} has no default branch; initialize it with a README`);

const plan = buildGitHubReleasePlan({
  repository,
  defaultBranch,
  channel: latest.channel,
  updateSequence: Number(latest.update_sequence),
  version: latest.version,
  zipPath,
  feedPath,
  releaseNotes: process.env.MY_AGENT_UPDATE_RELEASE_NOTES ?? '',
});

const existingRelease = run(
  ['release', 'view', plan.tag, '--repo', plan.repository, '--json', 'tagName,assets'],
  { capture: true, allowFailure: true },
);
let releaseAlreadyExists = false;
if (existingRelease.status === 0) {
  releaseAlreadyExists = true;
  if (!resume) {
    fail(`release ${plan.tag} already exists; use --resume only after checking the prior partial publish`);
  }
  const release = JSON.parse(existingRelease.stdout);
  const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset.size]));
  for (const localPath of [zipPath, feedPath]) {
    const name = path.basename(localPath);
    if (assets.get(name) !== statSync(localPath).size) {
      fail(`existing ${plan.tag} asset does not match local file size: ${name}`);
    }
  }
} else {
  const detail = String(existingRelease.stderr || existingRelease.stdout || '');
  if (!/release not found|not found|\b404\b/i.test(detail)) {
    fail(`could not inspect release ${plan.tag}: ${detail.trim()}`);
  }
}

console.log(JSON.stringify({
  mode: confirmed ? 'publish' : 'dry-run',
  repository: plan.repository,
  release_tag: plan.tag,
  raw_feed_url: plan.raw_feed_url,
  payload: zipPath,
  feed: feedPath,
}, null, 2));

if (!confirmed) {
  console.log('Dry run only. Re-run with --confirm to create the release and update the channel feed.');
  process.exit(0);
}

if (!releaseAlreadyExists) run(plan.release_args);

const feedBytes = readFileSync(feedPath);
const contentBase64 = feedBytes.toString('base64');
const existingFeed = run(
  ['api', plan.feed_api_path, '--method', 'GET', '-f', `ref=${plan.feed_branch}`],
  { capture: true, allowFailure: true },
);
let existingSha = null;
if (existingFeed.status === 0) {
  existingSha = JSON.parse(existingFeed.stdout).sha ?? null;
} else {
  const detail = String(existingFeed.stderr || existingFeed.stdout || '');
  if (!/\b404\b|Not Found/i.test(detail)) {
    fail(`could not inspect existing channel feed: ${detail.trim()}`);
  }
}

const updateFeedArgs = [
  'api',
  plan.feed_api_path,
  '--method',
  'PUT',
  '-f',
  `message=publish ${plan.channel} update ${plan.update_sequence}`,
  '-f',
  `content=${contentBase64}`,
  '-f',
  `branch=${plan.feed_branch}`,
];
if (existingSha) updateFeedArgs.push('-f', `sha=${existingSha}`);
run(updateFeedArgs);

console.log(`GitHub update published: ${repo.url}/releases/tag/${plan.tag}`);
console.log(`Channel feed: ${plan.raw_feed_url}`);
