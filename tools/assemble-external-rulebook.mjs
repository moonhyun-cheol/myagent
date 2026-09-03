#!/usr/bin/env node
/**
 * Run RULEBOOK assemble-generated.js (authority output stays in RULEBOOK only — ADR-RE-008).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRulebookRoot } from './rulebook-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulebookRoot = resolveRulebookRoot(root);
if (!rulebookRoot) {
  console.error('assemble-external-rulebook: .rulebook-link.yml → RULEBOOK checkout missing');
  process.exit(1);
}
const script = path.join(rulebookRoot, 'checks', 'assemble-generated.js');
if (!existsSync(script)) {
  console.error(`assemble-external-rulebook: missing ${script}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [script], {
  cwd: rulebookRoot,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
