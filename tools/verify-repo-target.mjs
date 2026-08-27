#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const target = JSON.parse(readFileSync(path.join(root, 'repo-target.json'), 'utf8'));
const mismatches = [];
if (target.version !== manifest.version) mismatches.push(`version ${target.version} != ${manifest.version}`);
if (Number(target.update_sequence) !== Number(manifest.update_sequence)) {
  mismatches.push(`update_sequence ${target.update_sequence} != ${manifest.update_sequence}`);
}
if (target.channel && target.channel !== manifest.update_channel) {
  mismatches.push(`channel ${target.channel} != ${manifest.update_channel}`);
}
if (target.github !== manifest.update_repository) {
  mismatches.push(`github ${target.github} != ${manifest.update_repository}`);
}
if (mismatches.length) {
  console.error('verify-repo-target FAILED:', mismatches.join('; '));
  process.exit(1);
}
console.log(`verify-repo-target: ok ${target.role} ${target.version} seq ${target.update_sequence} (${target.github})`);
