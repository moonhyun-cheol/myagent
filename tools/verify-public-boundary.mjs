#!/usr/bin/env node
/**
 * Classify the tracked tree before creating a history-free public export.
 *
 * Baseline mode records path-only evidence without claiming publication readiness:
 *   node tools/verify-public-boundary.mjs --write-report
 *
 * Strict mode is the release gate:
 *   node tools/verify-public-boundary.mjs --strict
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const writeReport = process.argv.includes('--write-report');
const selfPath = 'tools/verify-public-boundary.mjs';
const SECRET_FIXTURE_PATHS = new Set([
  'tools/verify-agent-context-upgrades.mjs',
  'tools/verify-agent-eval.mjs',
]);
const COMPANY_MARKER_ALLOWLIST = new Set([
  'PORT.md',
  'repo-target.json',
  'tools/port-status.mjs',
]);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const TEXT_EXT = /\.(?:bat|cjs|cs|csproj|css|html|js|json|jsx|md|mjs|ps1|ts|tsx|txt|xaml|xml|ya?ml)$/i;

const LOCAL_ONLY_PATHS = [
  /^\.update-staging(?:\/|$)/i,
  /^rulebook\/reports(?:\/|$)/i,
  /^rulebook\/docs\/plans\/.*\.zip$/i,
  /^rulebook\/docs\/plans\/.*\/agent-checkpoints(?:\/|$)/i,
  /^rulebook\/docs\/plans\/.*\/(?:agent-ledger|agent-perf).*\.jsonl$/i,
  /^rulebook\/docs\/plans\/.*\/agent-run-meta.*\.json$/i,
  /^rulebook\/docs\/plans\/.*\/session-.*\.json$/i,
  /^rulebook\/docs\/plans\/.*\/git-app-root\.txt$/i,
  /^rulebook\/docs\/plans\/_pack-.*\.mjs$/i,
];
const UNTRACKED_SOURCE_CANDIDATES = [
  /^rulebook\/checks\/.*\.(?:mjs|js|json)$/i,
  /^rulebook\/docs\/generated\/.*\.md$/i,
  /^rulebook\/implementation(?:\/|$)/i,
  /^rulebook\/docs\/REFERENCED_PROJECTS\.md$/i,
  /^tools\/(?:build-lanes|build-smart|release-preflight|version-policy)\.mjs$/i,
  /^tools\/fixtures\/task-ledger\/.*\.json$/i,
  /^tools\/verify-[^/]+\.mjs$/i,
  /^tools\/fpv\/fixtures\/docs\/strategy\.(?:docx|txt)$/i,
  /^ui\/assets\/my-agent-(?:app\.ico|icon\.png)$/i,
];

const COMPANY_MARKERS = [
  ['legacy_product_id', /\bCQR_PA\b/i],
  ['legacy_product_label', /\bCQR Agent\b/i],
  ['brand_manager', /\bcqr_brand_manager\b/i],
  ['company_domain', /\bminyoungcorp\.com\b/i],
  ['company_name', /\bMinyoung\b/i],
  ['internal_ipv4', /\b192\.168\.\d{1,3}\.\d{1,3}\b/],
  ['legacy_github', /\bmoonhyun-cheol\/CQR_PA(?:-Updates)?\b/i],
  ['brand_hashtag', /#PurposeAboveAll\b/i],
  ['company_connector', /\b(?:NOPSPro|LOOKA|BMS)\b/],
];

const SECRET_MARKERS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'literal_token',
    /\b(?:admin|activation|api|access|refresh)[_-]?token\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/i,
  ],
];

function gitList(args) {
  const result = spawnSync('git', args, { cwd: root });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString('utf8').trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .map((item) => item.replace(/\\/g, '/'))
    .filter(Boolean);
}

function readText(relative) {
  if (!TEXT_EXT.test(relative)) return null;
  const absolute = path.join(root, relative);
  const info = statSync(absolute);
  if (!info.isFile() || info.size > MAX_TEXT_BYTES) return null;
  return readFileSync(absolute, 'utf8');
}

function markerIds(text, markers) {
  return markers.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

const tracked = gitList(['ls-files', '-z']);
const untracked = gitList(['ls-files', '--others', '--exclude-standard', '-z']);
const untrackedSourceCandidates = untracked.filter((relative) =>
  UNTRACKED_SOURCE_CANDIDATES.some((pattern) => pattern.test(relative)));
const untrackedUnclassified = untracked.filter(
  (relative) => !untrackedSourceCandidates.includes(relative));
const localOnlyEvidence = [];
const companyOrBrandCandidates = [];
const secretCandidates = [];
const publicCoreCandidates = [];

for (const relative of tracked) {
  if (!existsSync(path.join(root, relative))) continue;
  if (LOCAL_ONLY_PATHS.some((pattern) => pattern.test(relative))) {
    localOnlyEvidence.push(relative);
    continue;
  }

  const text = relative === selfPath ? null : readText(relative);
  const companyMarkers = (
    text == null || COMPANY_MARKER_ALLOWLIST.has(relative)
      ? []
      : markerIds(text, COMPANY_MARKERS)
  );
  const secretMarkers = (
    text == null || SECRET_FIXTURE_PATHS.has(relative)
      ? []
      : markerIds(text, SECRET_MARKERS)
  );

  if (companyMarkers.length) {
    companyOrBrandCandidates.push({ path: relative, markers: companyMarkers });
  }
  if (secretMarkers.length) {
    secretCandidates.push({ path: relative, markers: secretMarkers });
  }
  if (!companyMarkers.length && !secretMarkers.length) {
    publicCoreCandidates.push(relative);
  }
}

const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
});
const revision = revisionResult.status === 0 ? revisionResult.stdout.trim() : null;
const report = {
  schema: 'my-agent-public-boundary/v1',
  generated_at: new Date().toISOString(),
  revision,
  classified: untrackedUnclassified.length === 0,
  ready: (
    localOnlyEvidence.length === 0
    && companyOrBrandCandidates.length === 0
    && secretCandidates.length === 0
    && untrackedSourceCandidates.length === 0
    && untrackedUnclassified.length === 0
  ),
  counts: {
    tracked: tracked.length,
    public_core_candidates: publicCoreCandidates.length,
    company_or_brand_candidates: companyOrBrandCandidates.length,
    local_only_evidence_tracked: localOnlyEvidence.length,
    secret_candidates: secretCandidates.length,
    untracked_source_candidates: untrackedSourceCandidates.length,
    untracked_unclassified: untrackedUnclassified.length,
  },
  public_core_candidates: publicCoreCandidates.sort(),
  company_or_brand_candidates: companyOrBrandCandidates.sort((a, b) => a.path.localeCompare(b.path)),
  local_only_evidence_tracked: localOnlyEvidence.sort(),
  secret_candidates: secretCandidates.sort((a, b) => a.path.localeCompare(b.path)),
  untracked_source_candidates: untrackedSourceCandidates.sort(),
  untracked_unclassified: untrackedUnclassified.sort(),
};

if (writeReport) {
  const output = path.join(root, 'data', 'audit', 'public-boundary-baseline.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`public-boundary: wrote ${path.relative(root, output).replace(/\\/g, '/')}`);
}

console.log(JSON.stringify({ ready: report.ready, ...report.counts }, null, 2));

if (strict && !report.ready) {
  console.error('verify-public-boundary FAILED: public export still has classified blockers.');
  process.exit(1);
}

if (!report.ready) {
  console.log('public-boundary baseline complete — NOT READY for public export.');
} else {
  console.log('verify-public-boundary OK — tracked public boundary is clean.');
}
