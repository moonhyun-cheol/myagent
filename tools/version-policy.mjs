#!/usr/bin/env node
/**
 * Version vs sequence (ADR-RE-003):
 * - update_sequence +1 on every signed client zip. Never reuse or roll back.
 * - SemVer patch/minor/major only when user-facing meaning changes.
 * - Public label is always `MY Agent {version} (update {N})`.
 * - Updater compares sequence only, never SemVer.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'status';
const args = process.argv.slice(3);
const manifestPath = path.join(root, 'manifest.json');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const versionTextPath = path.join(root, 'VERSION.txt');
const repoTargetPath = path.join(root, 'repo-target.json');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function option(name) {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function validateVersion(version, channel) {
  const stable = /^\d+\.\d+\.\d+$/;
  const beta = /^\d+\.\d+\.\d+-beta\.\d+$/;
  if (channel === 'beta' && !beta.test(version)) {
    throw new Error('beta channel requires version x.y.z-beta.N');
  }
  if (channel === 'stable' && !stable.test(version)) {
    throw new Error('stable channel requires version x.y.z');
  }
  if (channel !== 'beta' && channel !== 'stable') {
    throw new Error(`unsupported update channel: ${channel}`);
  }
}

function publicLabel(version, sequence) {
  return `MY Agent ${version} (update ${sequence})`;
}

function expectedVersionText(manifest) {
  const version = String(manifest.version ?? '').trim();
  const sequence = Number(manifest.update_sequence);
  return [
    publicLabel(version, sequence),
    `update_sequence: ${manifest.update_sequence}`,
    `channel: ${manifest.update_channel}`,
    '',
  ].join('\n');
}

function inspect() {
  const manifest = readJson(manifestPath);
  const pkg = readJson(packagePath);
  const lock = readJson(lockPath);
  const sequence = positiveInteger(manifest.update_sequence, 'manifest.update_sequence');
  const channel = String(manifest.update_channel ?? '').trim().toLowerCase();
  const version = String(manifest.version ?? '').trim();
  validateVersion(version, channel);
  const mismatches = [];
  if (pkg.version !== version) mismatches.push(`package.json=${pkg.version}`);
  if (lock.version !== version) mismatches.push(`package-lock.json=${lock.version}`);
  if (lock.packages?.['']?.version !== version) {
    mismatches.push(`package-lock.json#packages[""].version=${lock.packages?.['']?.version}`);
  }
  if (readFileSync(versionTextPath, 'utf8') !== expectedVersionText(manifest)) {
    mismatches.push('VERSION.txt');
  }
  if (existsSync(repoTargetPath)) {
    const target = readJson(repoTargetPath);
    if (target.version !== version) mismatches.push(`repo-target.json version=${target.version}`);
    if (Number(target.update_sequence) !== sequence) {
      mismatches.push(`repo-target.json update_sequence=${target.update_sequence}`);
    }
    if (target.channel && target.channel !== channel) {
      mismatches.push(`repo-target.json channel=${target.channel}`);
    }
    if (target.github && target.github !== manifest.update_repository) {
      mismatches.push(`repo-target.json github=${target.github}`);
    }
  }
  const expectedFeed =
    `https://raw.githubusercontent.com/${manifest.update_repository ?? 'moonhyun-cheol/myagent'}`
    + `/main/channels/${channel}.json`;
  if (String(manifest.update_feed_url ?? '') !== expectedFeed) {
    mismatches.push(`update_feed_url=${manifest.update_feed_url}`);
  }
  return {
    version,
    channel,
    update_sequence: sequence,
    public_label: publicLabel(version, sequence),
    consistent: mismatches.length === 0,
    mismatches,
  };
}

function writeAtomic(file, body) {
  const temp = `${file}.version-policy.tmp`;
  writeFileSync(temp, body, 'utf8');
  renameSync(temp, file);
}

function prepare() {
  const manifest = readJson(manifestPath);
  const currentSequence = positiveInteger(manifest.update_sequence, 'manifest.update_sequence');
  const version = String(option('version') ?? '').trim();
  const channel = String(option('channel') ?? manifest.update_channel ?? 'beta').trim().toLowerCase();
  const sequence = positiveInteger(option('sequence'), '--sequence');
  if (!version) throw new Error('--version is required');
  validateVersion(version, channel);
  if (sequence < currentSequence) {
    throw new Error(`sequence rollback is forbidden (${sequence} < ${currentSequence})`);
  }

  manifest.version = version;
  manifest.update_channel = channel;
  manifest.build = channel;
  manifest.update_sequence = sequence;
  const repository = String(manifest.update_repository ?? 'moonhyun-cheol/myagent').trim();
  manifest.update_feed_url =
    `https://raw.githubusercontent.com/${repository}/main/channels/${channel}.json`;

  const pkg = readJson(packagePath);
  pkg.version = version;
  const lock = readJson(lockPath);
  lock.version = version;
  lock.packages ??= {};
  lock.packages[''] ??= {};
  lock.packages[''].version = version;

  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeAtomic(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeAtomic(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  writeAtomic(versionTextPath, expectedVersionText(manifest));
  if (existsSync(repoTargetPath)) {
    const target = readJson(repoTargetPath);
    target.version = version;
    target.update_sequence = sequence;
    target.channel = channel;
    if (manifest.update_repository) target.github = manifest.update_repository;
    writeAtomic(repoTargetPath, `${JSON.stringify(target, null, 2)}\n`);
  }
  return inspect();
}

try {
  if (command === 'status') {
    const result = inspect();
    console.log(JSON.stringify(result, null, 2));
    if (!result.consistent) process.exitCode = 1;
  } else if (command === 'prepare') {
    console.log(JSON.stringify(prepare(), null, 2));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`version-policy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
