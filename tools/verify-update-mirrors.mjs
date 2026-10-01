#!/usr/bin/env node
/**
 * Organization release mirrors (Gitea primary + GitHub same-version mirror).
 * Offline: local HTTP server only; no real Gitea/GitHub calls.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distHref = (rel) => pathToFileURL(path.join(root, 'core', 'dist', rel)).href;

const mirrorsMod = await import(distHref('updates/update-mirrors.js'));
const policyMod = await import(distHref('updates/update-host-policy.js'));
const orgFeedMod = await import(distHref('updates/organization-module-feed.js'));
const kitFeedMod = await import(distHref('updates/work-kit-catalog-feed.js'));
const {
  loadReleaseMirrors,
  feedUrlCandidates,
  mirrorAssetUrls,
  mirrorHosts,
  fetchFromMirrors,
  isMirrorFallbackStatus,
} = mirrorsMod;

const GITEA_RAW = 'https://git.minyoungcorp.com/ins78516/myagent-org/raw/branch/main/';
const GITHUB_RAW = 'https://raw.githubusercontent.com/moonhyun-cheol/myagent-org/main/';
const GITEA_DL = 'https://git.minyoungcorp.com/ins78516/myagent-org/releases/download/';
const GITHUB_DL = 'https://github.com/moonhyun-cheol/myagent-org/releases/download/';

// 1. deploy-defaults: Gitea first, GitHub second; feed URLs point at Gitea.
delete process.env.MY_AGENT_UPDATE_MIRRORS;
delete process.env.MY_AGENT_UPDATE_ASSET_URL_TEMPLATE;
delete process.env.MY_AGENT_WORK_KIT_ASSET_URL_TEMPLATE;
const mirrors = loadReleaseMirrors(root);
assert.deepEqual(mirrors.map((m) => m.id), ['gitea', 'github']);
assert.equal(mirrors[0].repository, 'ins78516/myagent-org');
assert.equal(mirrors[1].repository, 'moonhyun-cheol/myagent-org');
const defaults = JSON.parse(readFileSync(path.join(root, 'core', 'config', 'defaults', 'deploy-defaults.json'), 'utf8'));
assert.equal(defaults.organization_module_feed_url, `${GITEA_RAW}channels/beta.json`);
assert.equal(defaults.work_kit_catalog_feed_url, `${GITEA_RAW}channels/work-kits.json`);

// 2. Feed candidates: legacy GitHub feed (old module.json) is read from Gitea first.
assert.deepEqual(feedUrlCandidates(`${GITHUB_RAW}channels/beta.json`, mirrors), [
  `${GITEA_RAW}channels/beta.json`,
  `${GITHUB_RAW}channels/beta.json`,
]);
assert.deepEqual(feedUrlCandidates(`${GITEA_RAW}channels/work-kits.json`, mirrors), [
  `${GITEA_RAW}channels/work-kits.json`,
  `${GITHUB_RAW}channels/work-kits.json`,
]);
assert.deepEqual(feedUrlCandidates('https://updates.corp.example/feed.json', mirrors), [
  'https://updates.corp.example/feed.json',
]);

// 3. Asset candidates: seq 20 (signed as Gitea repo) and seq 19 / work-kits-5 (signed as GitHub repo).
const seq20 = orgFeedMod.organizationModuleAssetCandidates(mirrors, {
  repository: 'ins78516/myagent-org',
  release_tag: 'update-20',
  name: 'org-20.zip',
}).map((u) => u.href);
assert.deepEqual(seq20, [`${GITEA_DL}update-20/org-20.zip`, `${GITHUB_DL}update-20/org-20.zip`]);
const seq19 = orgFeedMod.organizationModuleAssetCandidates(mirrors, {
  repository: 'moonhyun-cheol/myagent-org',
  release_tag: 'update-19',
  name: 'org-19.zip',
}).map((u) => u.href);
assert.deepEqual(seq19, [`${GITEA_DL}update-19/org-19.zip`, `${GITHUB_DL}update-19/org-19.zip`]);
const trust = { extraHosts: mirrorHosts(mirrors) };
const kit5 = kitFeedMod.resolveShelfAssetUrls(
  { repository: 'moonhyun-cheol/myagent-org', release_tag: 'work-kits-5', name: 'cqr-ops.tar.gz', size: 1, sha256: 'a'.repeat(64) },
  trust,
  mirrors,
).map((u) => u.href);
assert.deepEqual(kit5, [`${GITEA_DL}work-kits-5/cqr-ops.tar.gz`, `${GITHUB_DL}work-kits-5/cqr-ops.tar.gz`]);
// Unmirrored repository keeps the old GitHub default.
assert.deepEqual(
  orgFeedMod.organizationModuleAssetCandidates(mirrors, {
    repository: 'other/repo',
    release_tag: 'update-1',
    name: 'x.zip',
  }).map((u) => u.href),
  ['https://github.com/other/repo/releases/download/update-1/x.zip'],
);
assert.deepEqual(mirrorAssetUrls({ repository: 'other/repo', releaseTag: 't', name: 'n' }, mirrors), []);

// 4. Env template (operator override) bypasses mirrors.
process.env.MY_AGENT_UPDATE_ASSET_URL_TEMPLATE = 'https://updates.corp.example/{repository}/{tag}/{name}';
assert.deepEqual(
  orgFeedMod.organizationModuleAssetCandidates(mirrors, {
    repository: 'ins78516/myagent-org',
    release_tag: 'update-20',
    name: 'org-20.zip',
  }).map((u) => u.href),
  ['https://updates.corp.example/ins78516/myagent-org/update-20/org-20.zip'],
);
delete process.env.MY_AGENT_UPDATE_ASSET_URL_TEMPLATE;
process.env.MY_AGENT_UPDATE_MIRRORS = '0';
assert.deepEqual(loadReleaseMirrors(root), []);
delete process.env.MY_AGENT_UPDATE_MIRRORS;

// 5. Host trust: Gitea host only via configured mirrors.
assert.equal(policyMod.isTrustedUpdateAssetHost('git.minyoungcorp.com'), false);
assert.equal(policyMod.isTrustedUpdateAssetHost('git.minyoungcorp.com', trust), true);
assert.equal(policyMod.isTrustedUpdateFeedHost('git.minyoungcorp.com', trust), true);
assert.equal(policyMod.isTrustedUpdateAssetHost('evil.example', trust), false);
assert.equal(policyMod.resolveWorkKitAssetUrlMode(true), 'mirrors');

// 6. fetchFromMirrors fallback rules against a local server.
assert.equal(isMirrorFallbackStatus(404), true);
assert.equal(isMirrorFallbackStatus(503), true);
assert.equal(isMirrorFallbackStatus(403), false);
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/hang') return; // never answers
  if (req.url === '/404') { res.writeHead(404); res.end('nf'); return; }
  if (req.url === '/503') { res.writeHead(503); res.end('down'); return; }
  if (req.url === '/403') { res.writeHead(403); res.end('forbidden'); return; }
  if (req.url === '/bad') { res.writeHead(200); res.end('WRONG-BYTES'); return; }
  res.writeHead(200); res.end('OK');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const deadPort = `http://127.0.0.1:1`;
const opts = { headers: {}, attemptTimeoutMs: 400, validate: () => {} };
try {
  let r = await fetchFromMirrors([new URL(`${base}/404`), new URL(`${base}/ok`)], opts);
  assert.equal(await r.response.text(), 'OK');
  r = await fetchFromMirrors([new URL(`${base}/503`), new URL(`${base}/ok`)], opts);
  assert.equal(await r.response.text(), 'OK');
  r = await fetchFromMirrors([new URL(`${deadPort}/x`), new URL(`${base}/ok`)], opts);
  assert.equal(await r.response.text(), 'OK');
  r = await fetchFromMirrors([new URL(`${base}/hang`), new URL(`${base}/ok`)], opts);
  assert.equal(await r.response.text(), 'OK');
  // 403 is not a transport failure: no fallback.
  r = await fetchFromMirrors([new URL(`${base}/403`), new URL(`${base}/ok`)], opts);
  assert.equal(r.response.status, 403);
  // All mirrors 404: last response returned (callers keep their 404 handling).
  r = await fetchFromMirrors([new URL(`${base}/404`), new URL(`${base}/404`)], opts);
  assert.equal(r.response.status, 404);
  // A 200 with wrong bytes is returned as-is; second mirror is NOT contacted.
  hits.length = 0;
  r = await fetchFromMirrors([new URL(`${base}/bad`), new URL(`${base}/ok`)], opts);
  assert.equal(await r.response.text(), 'WRONG-BYTES');
  assert.deepEqual(hits, ['/bad']);
  // Every mirror unreachable: throws.
  await assert.rejects(fetchFromMirrors([new URL(`${deadPort}/a`), new URL(`${deadPort}/b`)], opts));
  // Outer abort is never retried on the next mirror.
  hits.length = 0;
  const outer = new AbortController();
  setTimeout(() => outer.abort(), 100);
  await assert.rejects(
    fetchFromMirrors([new URL(`${base}/hang`), new URL(`${base}/ok`)], { ...opts, attemptTimeoutMs: 5_000, signal: outer.signal }),
  );
  assert.deepEqual(hits, ['/hang']);
  // validate() rejection (host policy) stops immediately.
  await assert.rejects(
    fetchFromMirrors([new URL(`${base}/ok`)], { ...opts, validate: () => { throw new Error('HOST'); } }),
    /HOST/,
  );
} finally {
  server.closeAllConnections?.();
  server.close();
}

// 7. Hash/size checks stay after the mirror fetch (no retry loop around them).
const orgSrc = readFileSync(path.join(root, 'core', 'src', 'updates', 'organization-module-feed.ts'), 'utf8');
assert.ok(orgSrc.indexOf('fetchFromMirrors(assetUrls') < orgSrc.indexOf("'MODULE_ZIP_HASH'"));
const kitSrc = readFileSync(path.join(root, 'core', 'src', 'updates', 'work-kit-catalog-feed.ts'), 'utf8');
assert.ok(kitSrc.indexOf('fetchFromMirrors(assetUrls') < kitSrc.lastIndexOf("'KIT_ASSET_HASH'"));

console.log('verify-update-mirrors: ok');
