/**
 * Resolve canonical rulebook paths from .rulebook-link.yml (local only, not on GitHub).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** @returns {string | null} absolute rulebook project root (e.g. .../RULEBOOK/MY_CUSTOM_CODEX) */
export function resolveRulebookRoot(productRoot) {
  const linkPath = path.join(productRoot, '.rulebook-link.yml');
  if (!existsSync(linkPath)) return null;
  const raw = readFileSync(linkPath, 'utf8');
  const dirMatch = raw.match(/^rulebook_dir:\s*(.+)$/m);
  if (!dirMatch) return null;
  let dir = dirMatch[1].trim();
  if (!path.isAbsolute(dir)) dir = path.resolve(productRoot, dir);
  return existsSync(dir) ? dir : null;
}

/** @returns {string | null} absolute docs dir — canonical RULEBOOK first, else product stub */
export function resolveRulebookDocsDir(productRoot) {
  const canonical = resolveRulebookRoot(productRoot);
  if (canonical) {
    const docs = path.join(canonical, 'docs');
    if (existsSync(docs)) return docs;
  }
  const stub = path.join(productRoot, 'rulebook', 'docs');
  return existsSync(stub) ? stub : null;
}

/** Paths under product root for agent memory (relative strings). */
export function rulebookMemoryFileRels(productRoot) {
  const docs = resolveRulebookDocsDir(productRoot);
  const root = resolveRulebookRoot(productRoot);
  const prefix =
    root && docs?.startsWith(root)
      ? path.relative(productRoot, docs).replace(/\\/g, '/')
      : 'rulebook/docs';
  const candidates = [
    '00_PROJECT_BRIEF.md',
    '01_CURRENT_STATUS.md',
    '02_ALWAYS_ON_RULES.md',
    '03_RULE_INDEX.md',
    'specs/technical/01-architecture.md',
    'specs/technical/04-interface-api.md',
  ];
  return candidates
    .map((rel) => `${prefix}/${rel}`)
    .filter((rel) => existsSync(path.join(productRoot, rel)));
}
