#!/usr/bin/env node
/** Shared FPV path helpers. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FPV_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(FPV_ROOT, '../..');
export const OUT_DIR = path.join(REPO_ROOT, 'data', '_fpv');

export function absFromRepo(rel) {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return path.resolve(rel);
  return path.resolve(REPO_ROOT, rel.replace(/\\/g, '/'));
}

export function argFlag(name) {
  return process.argv.includes(name);
}

export function argValue(prefix, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  return hit.slice(prefix.length) || fallback;
}

export function apiBase() {
  return (
    process.env.MY_AGENT_API_BASE
    || process.env.CQR_E2E_BASE_URL
    || argValue('--base=', 'http://127.0.0.1:10200')
  ).replace(/\/$/, '');
}
