#!/usr/bin/env node
/**
 * Personal pack export/import — data/ slots that survive product delta/git.
 *
 *   node tools/personal-pack-export.mjs --export
 *   node tools/personal-pack-export.mjs --import
 *   node tools/personal-pack-export.mjs --export --dry-run
 *   node tools/personal-pack-export.mjs --export --with-vault
 *
 * Default pack root: %USERPROFILE%/Documents/MY_AGENT_personal_pack
 * Override: CQR_PERSONAL_PACK
 *
 * Vault is OFF by default (secrets stay off-site unless --with-vault).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const withVault = argv.includes('--with-vault');
const mode = argv.includes('--import') ? 'import' : 'export';

const packRoot = path.resolve(
  process.env.CQR_PERSONAL_PACK?.trim()
    || path.join(os.homedir(), 'Documents', 'MY_AGENT_personal_pack'),
);

const TREE_DIRS = ['data/agent-plugins', 'data/skills'];
const TREE_FILES = ['data/config/user-mcp-servers.json'];
const OVERRIDES_REL = 'data/config/user-overrides.json';
const VAULT_DIR = 'data/vault';

/** Keys safe to round-trip (no API tokens / license blobs). */
const SAFE_OVERRIDE_KEYS = new Set([
  'dev_workspace_root',
  'agent_autopilot',
  'playwright_headless',
  'playwright_allow_localhost',
  'nas_write_consent',
  'default_provider_id',
  'default_model_id',
  'ui_locale',
  'theme',
]);

const auditFindings = [];

function log(msg) {
  console.log(msg);
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function packPath(rel) {
  return path.join(packRoot, ...rel.split('/'));
}

function cqrPath(rel) {
  return path.join(root, ...rel.split('/'));
}

function copyTree(src, dest, { dry = false } = {}) {
  if (!existsSync(src)) {
    return { copied: 0, skipped: true };
  }
  const st = statSync(src);
  if (st.isFile()) {
    if (dry) {
      log(`  file  ${src} → ${dest}`);
      return { copied: 1, skipped: false };
    }
    ensureParent(dest);
    copyFileSync(src, dest);
    return { copied: 1, skipped: false };
  }
  let n = 0;
  if (!dry) mkdirSync(dest, { recursive: true });
  else mkdirSync(path.dirname(dest), { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === '.' || name === '..') continue;
    const child = copyTree(path.join(src, name), path.join(dest, name), { dry });
    n += child.copied;
  }
  return { copied: n, skipped: false };
}

function listPackManifest() {
  return [
    ...TREE_DIRS.map((rel) => ({ rel, kind: 'dir', exists: existsSync(cqrPath(rel)) })),
    ...TREE_FILES.map((rel) => ({ rel, kind: 'file', exists: existsSync(cqrPath(rel)) })),
    {
      rel: OVERRIDES_REL,
      kind: 'overrides-safe',
      exists: existsSync(cqrPath(OVERRIDES_REL)),
    },
    {
      rel: VAULT_DIR,
      kind: 'vault',
      exists: existsSync(cqrPath(VAULT_DIR)),
      included: withVault,
    },
  ];
}

function runAuditHints() {
  const toolsDir = path.join(root, 'tools');
  try {
    for (const ent of readdirSync(toolsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (/^(lab|e2e|plugin-templates|update)$/i.test(ent.name)) continue;
      if (/^(my_|user_|private_|scratch_|local_)/i.test(ent.name)) {
        auditFindings.push(
          `tools/${ent.name}/ looks personal — consider external pack, not product git`,
        );
      }
    }
  } catch {
    /* ignore */
  }

  const skillsDefaults = path.join(root, 'core', 'config', 'defaults', 'skills');
  try {
    const man = JSON.parse(readFileSync(path.join(skillsDefaults, 'manifest.json'), 'utf8'));
    const files = new Set([
      'manifest.json',
      'prompt-master-templates.md',
      'prompt-master-patterns.md',
      'web-design-first-ui.md',
    ]);
    for (const def of Object.values(man.skills || {})) {
      for (const f of [...(def.bundle_files || []), ...(def.brand_files || [])]) {
        files.add(path.basename(f));
      }
    }
    const blob = JSON.stringify(man);
    for (const ent of readdirSync(skillsDefaults)) {
      if (!ent.endsWith('.md')) continue;
      if (files.has(ent)) continue;
      if (!blob.includes(ent.replace(/\.md$/, '')) && !blob.includes(ent)) {
        auditFindings.push(
          `core/config/defaults/skills/${ent} not referenced in manifest — confirm product vs personal`,
        );
      }
    }
  } catch (e) {
    auditFindings.push(`audit skills defaults: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function exportOverridesSafe({ dry = false } = {}) {
  const src = cqrPath(OVERRIDES_REL);
  if (!existsSync(src)) {
    log(`  (skip overrides — missing ${OVERRIDES_REL})`);
    return 0;
  }
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(src, 'utf8'));
  } catch (e) {
    log(`  WARN overrides parse: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  const safe = {};
  for (const k of SAFE_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined) {
      safe[k] = raw[k];
    }
  }
  const out = {
    version: 1,
    exported_at: new Date().toISOString(),
    note: 'safe keys only — re-merge into data/config/user-overrides.json on import',
    overrides: safe,
  };
  const dest = path.join(packRoot, 'user-overrides.safe.json');
  if (dry) {
    log(`  overrides-safe keys=${Object.keys(safe).join(',') || '(none)'} → ${dest}`);
    return 1;
  }
  ensureParent(dest);
  writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return 1;
}

function importOverridesSafe({ dry = false } = {}) {
  const src = path.join(packRoot, 'user-overrides.safe.json');
  if (!existsSync(src)) {
    log('  (no user-overrides.safe.json in pack)');
    return 0;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(src, 'utf8'));
  } catch (e) {
    log(`  WARN ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  const incoming = doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {};
  const dest = cqrPath(OVERRIDES_REL);
  let current = {};
  if (existsSync(dest)) {
    try {
      current = JSON.parse(readFileSync(dest, 'utf8'));
    } catch {
      current = {};
    }
  }
  const next = { ...current };
  for (const k of SAFE_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, k)) next[k] = incoming[k];
  }
  if (dry) {
    log(`  merge overrides-safe → ${OVERRIDES_REL} keys=${Object.keys(incoming).join(',')}`);
    return 1;
  }
  ensureParent(dest);
  writeFileSync(dest, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return 1;
}

function writeMeta(action) {
  const meta = {
    action,
    cqr_root: root,
    pack_root: packRoot,
    generated_at: new Date().toISOString(),
    with_vault: withVault,
    dry_run: dryRun,
    slots: listPackManifest(),
    audit: auditFindings,
  };
  if (!dryRun) {
    writeFileSync(path.join(packRoot, 'pack-meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  return meta;
}

function doExport() {
  log(`=== personal pack EXPORT (${dryRun ? 'dry-run' : 'write'}) ===`);
  log(`CQR root: ${root}`);
  log(`pack:     ${packRoot}`);
  if (!dryRun) mkdirSync(packRoot, { recursive: true });

  runAuditHints();
  let total = 0;
  for (const rel of TREE_DIRS) {
    log(`[dir] ${rel}`);
    const r = copyTree(cqrPath(rel), packPath(rel), { dry: dryRun });
    total += r.copied;
    if (r.skipped) log('  (missing — skip)');
  }
  for (const rel of TREE_FILES) {
    log(`[file] ${rel}`);
    if (!existsSync(cqrPath(rel))) {
      log('  (missing — skip)');
      continue;
    }
    total += copyTree(cqrPath(rel), packPath(rel), { dry: dryRun }).copied;
  }
  log('[overrides-safe]');
  total += exportOverridesSafe({ dry: dryRun });

  if (withVault) {
    log(`[vault] ${VAULT_DIR}`);
    const r = copyTree(cqrPath(VAULT_DIR), packPath(VAULT_DIR), { dry: dryRun });
    total += r.copied;
    if (r.skipped) log('  (missing — skip)');
  } else {
    log('[vault] skipped (default). Pass --with-vault to include secrets.');
  }

  writeMeta('export');
  if (auditFindings.length) {
    log('\n## audit warnings (no auto-delete)');
    for (const a of auditFindings) log(`  - ${a}`);
  }
  log(`\ndone export ~${total} file ops → ${packRoot}`);
  if (!dryRun) log(`meta: ${path.join(packRoot, 'pack-meta.json')}`);
  return 0;
}

function doImport() {
  log(`=== personal pack IMPORT (${dryRun ? 'dry-run' : 'write'}) ===`);
  log(`pack:     ${packRoot}`);
  log(`CQR root: ${root}`);
  if (!existsSync(packRoot)) {
    console.error(`ERROR: pack not found: ${packRoot}`);
    return 1;
  }

  let total = 0;
  for (const rel of TREE_DIRS) {
    log(`[dir] ${rel}`);
    const r = copyTree(packPath(rel), cqrPath(rel), { dry: dryRun });
    total += r.copied;
    if (r.skipped) log('  (missing in pack — skip)');
  }
  for (const rel of TREE_FILES) {
    log(`[file] ${rel}`);
    if (!existsSync(packPath(rel))) {
      log('  (missing in pack — skip)');
      continue;
    }
    total += copyTree(packPath(rel), cqrPath(rel), { dry: dryRun }).copied;
  }
  log('[overrides-safe]');
  total += importOverridesSafe({ dry: dryRun });

  if (withVault) {
    log(`[vault] ${VAULT_DIR}`);
    const r = copyTree(packPath(VAULT_DIR), cqrPath(VAULT_DIR), { dry: dryRun });
    total += r.copied;
    if (r.skipped) log('  (missing in pack — skip)');
  } else {
    log('[vault] not imported (default). Pass --with-vault to restore secrets.');
  }

  log(`\ndone import ~${total} file ops ← ${packRoot}`);
  return 0;
}

process.exit(mode === 'import' ? doImport() : doExport());
