#!/usr/bin/env node
/** L4 journeys orchestrator — manifest-driven + --only merge. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, REPO_ROOT, argFlag, argValue, apiBase } from '../lib/paths.mjs';
import { runNode } from '../lib/spawn.mjs';
import { runJourneyFile } from './journey-generic.mjs';
import { healthOk, waitForApi } from '../lib/http-chat.mjs';
import { isMainModule } from '../lib/is-main.mjs';

const SPECIAL = {
  J_market_process: {
    node: 'tools/fpv/run-journey-market.mjs',
  },
};

function loadManifestJourneys() {
  const m = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools/fpv/manifest.json'), 'utf8'));
  return m.journeys || [];
}

function readPriorL4() {
  const p = path.join(OUT_DIR, 'l4-journeys.json');
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(j.rows) ? j.rows : [];
  } catch {
    return [];
  }
}

function mergeRows(prior, next, onlyIds) {
  if (!onlyIds?.length) return next;
  const map = new Map();
  for (const r of prior) map.set(r.id, r);
  for (const r of next) map.set(r.id, r);
  // keep stable order from manifest + any extras
  const order = loadManifestJourneys().map((j) => j.id);
  const out = [];
  for (const id of order) {
    if (map.has(id)) out.push(map.get(id));
  }
  for (const [id, r] of map) {
    if (!out.find((x) => x.id === id)) out.push(r);
  }
  return out;
}

export async function runJourneys(opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const offlineOnly =
    opts.offlineOnly || argFlag('--offline-only') || process.env.MY_AGENT_FPV_OFFLINE === '1';
  const onlyRaw = argValue('--only=', opts.only || null);
  const only = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const base = opts.base || apiBase();
  const apiUp = offlineOnly ? false : await healthOk(base);
  const prior = only ? readPriorL4() : [];

  const want = (id) => !only || only.includes(id);
  const rows = [];
  const catalog = loadManifestJourneys();

  async function ensureApi() {
    if (offlineOnly) return false;
    await waitForApi(base, 20_000);
    return healthOk(base);
  }

  for (const j of catalog) {
    if (!want(j.id)) continue;
    console.log(`\n######## ${j.id} ########`);

    if (SPECIAL[j.id]) {
      const up = await ensureApi();
      const args = offlineOnly || !up ? ['--offline-only'] : [];
      const r = runNode(SPECIAL[j.id].node, args, { MY_AGENT_API_BASE: base });
      rows.push({
        id: j.id,
        ok: r.ok,
        tag: r.ok ? (args.length ? 'explicit_skip' : 'green') : !up && !offlineOnly ? 'env-red' : 'red',
        status: r.status,
        layer: 'L4',
        note: args.length ? 'offline-only' : undefined,
      });
      continue;
    }

    const up = await ensureApi();
    // deploy is offline-gates by design; others go offline when API down
    const forceOffline = offlineOnly || !up || j.id === 'J_deploy';
    const r = await runJourneyFile(j.file, {
      offlineOnly: forceOffline,
      base,
    });
    rows.push({
      id: j.id,
      ok: r.ok,
      tag: r.tag || (r.ok ? 'green' : 'red'),
      layer: 'L4',
      note: r.note || (!up && !offlineOnly ? 'api_down_fallback_offline' : undefined),
    });
  }

  const merged = mergeRows(prior, rows, only);
  const productRows = merged.filter((r) => r.tag !== 'env-red' && r.tag !== 'explicit_skip');
  const ok = productRows.length === 0 ? rows.every((r) => r.ok || r.tag === 'explicit_skip') : productRows.every((r) => r.ok);
  const report = {
    layer: 'L4',
    started,
    finished: new Date().toISOString(),
    offlineOnly,
    apiUp,
    only: only || null,
    ok,
    rows: merged,
  };
  writeFileSync(path.join(OUT_DIR, 'l4-journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMainModule(import.meta.url)) {
  runJourneys()
    .then((r) => {
      console.log(`\n=== FPV L4 ok=${r.ok} ===`);
      for (const row of r.rows) console.log(`  ${row.tag} ${row.id}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
