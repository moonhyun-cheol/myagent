/**
 * R-003 / R-005 guard.
 *
 * R-005 allows absolute + UNC (\\nas\...) reads and writes, so the literal must stay
 * legal in prompt text, rulebook docs and verify fixtures. What must never ship is a
 * site-specific NAS path baked into configuration or launcher surfaces, because deploy
 * PCs do not have that share. Runtime write blocking stays with path-guard /
 * nas-write-consent (R-003), not with this scan.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Never scanned: build output, dependencies, user data, publish staging. */
const SKIP_RELS = new Set([
  '.git',
  '.cursor',
  'node_modules',
  'core/dist',
  'runtime',
  'data',
  'deploy',
  'bin',
  'logs',
]);

/**
 * Config / launcher surfaces that ship to deploy PCs. A NAS UNC literal here is a
 * hardcoded dependency on this office's share and fails the build.
 */
const CONFIG_SURFACE_PREFIXES = [
  'core/config/',
  'manifest.json',
  'activation-server/',
  'shell/',
  'tools/install/',
  'tools/update/',
  'tools/launch-',
  'tools/embed-',
  'tools/publish',
];

const NAS_PATTERN = /\\\\nas[\\/]|\\\\nas3[\\/]/i;
const SCANNABLE_RE = /\.(ts|js|mjs|json|cs|csproj|ps1|bat|md|toml)$/i;

const violations = [];
const documented = [];

function toRel(full) {
  return path.relative(root, full).replace(/\\/g, '/');
}

function isConfigSurface(rel) {
  return CONFIG_SURFACE_PREFIXES.some((p) => rel === p || rel.startsWith(p));
}

function scanFile(full) {
  const rel = toRel(full);
  if (!NAS_PATTERN.test(readFileSync(full, 'utf8'))) return;
  if (isConfigSurface(rel)) {
    violations.push(`${rel}: hardcoded NAS UNC in shipped config/launcher surface`);
  } else {
    documented.push(rel);
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = toRel(full);
    if (SKIP_RELS.has(name) || SKIP_RELS.has(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (SCANNABLE_RE.test(name)) scanFile(full);
  }
}

walk(root);

if (violations.length) {
  console.error('verify-no-nas-paths FAILED:');
  violations.forEach((v) => console.error('  -', v));
  console.error('  Move the path to user config (dev_workspace_root) instead of hardcoding it.');
  process.exit(1);
}
console.log(
  `verify-no-nas-paths OK — config/launcher surfaces clean (${documented.length} documented mentions in prompts/docs/tests, allowed by R-005)`,
);
