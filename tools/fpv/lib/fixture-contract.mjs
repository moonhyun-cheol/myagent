#!/usr/bin/env node
/**
 * Fixture contract — resolve path-map aliases; missing required → env-red.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, absFromRepo } from './paths.mjs';

export function loadPathMap() {
  const p = path.join(REPO_ROOT, 'tools/fpv/fixtures/path-map.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

function resolveOrganizationRoot() {
  const env = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT?.trim();
  if (env && existsSync(env)) return path.resolve(env);
  for (const rel of ['modules/organization']) {
    const p = absFromRepo(rel);
    if (existsSync(p)) return p;
  }
  return null;
}

export function resolveAlias(key, map = loadPathMap()) {
  const entry = map.aliases?.[key];
  if (!entry) {
    return { key, ok: false, tag: 'env-red', reason: 'unknown_alias', path: null };
  }

  if (entry.env || entry.siblings) {
    const organization = resolveOrganizationRoot();
    if (!organization) {
      return {
        key,
        ok: entry.required === false,
        tag: entry.missingTag || 'env-red',
        reason: 'organization_module_missing',
        path: null,
        required: entry.required !== false,
      };
    }
    if (key === 'market.brand_root') {
      return { key, ok: true, tag: 'ok', path: organization, required: entry.required !== false };
    }
  }

  if (entry.relativeTo && entry.join) {
    const parent = resolveAlias(entry.relativeTo, map);
    if (!parent.path) {
      return {
        key,
        ok: entry.required === false,
        tag: entry.missingTag || 'env-red',
        reason: 'parent_missing',
        path: null,
        required: entry.required !== false,
      };
    }
    const joined = path.join(parent.path, entry.join);
    const ok = existsSync(joined);
    return {
      key,
      ok: ok || entry.required === false,
      tag: ok ? 'ok' : entry.missingTag || 'env-red',
      reason: ok ? null : 'missing',
      path: joined,
      required: entry.required !== false,
    };
  }

  if (entry.fixture) {
    const p = absFromRepo(entry.fixture);
    const ok = existsSync(p);
    return {
      key,
      ok: ok || entry.required === false,
      tag: ok ? 'ok' : entry.missingTag || 'env-red',
      reason: ok ? null : 'missing_fixture',
      path: p,
      required: entry.required !== false,
    };
  }

  return { key, ok: false, tag: 'env-red', reason: 'unresolvable', path: null };
}

export function checkFixtureContract(map = loadPathMap()) {
  const rows = [];
  for (const key of Object.keys(map.aliases || {})) {
    rows.push(resolveAlias(key, map));
  }
  const hardFail = rows.filter((r) => r.required && !r.ok && r.tag === 'env-red');
  return {
    ok: hardFail.length === 0,
    hardFail,
    rows,
  };
}

/** Rewrite lab prompts that embed host absolute paths → fixture abs paths. */
export function rewritePrompt(text, map = loadPathMap()) {
  let out = String(text || '');
  for (const rule of map.promptRewrites || []) {
    const target = resolveAlias(rule.replaceWithAlias, map);
    if (!target.path) continue;
    const find = rule.find.replace(/\\\\/g, '\\');
    out = out.split(find).join(target.path);
    // also try double-escaped form as written in JSON catalogs
    const findEsc = rule.find;
    out = out.split(findEsc).join(target.path);
  }
  return out;
}

export function absoluteFixtureOrEnvRed(aliasKey) {
  const r = resolveAlias(aliasKey);
  if (!r.ok || !r.path) {
    const err = new Error(`env-red: fixture alias ${aliasKey} missing (${r.reason || r.tag})`);
    err.tag = 'env-red';
    throw err;
  }
  return r.path;
}
