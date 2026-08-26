#!/usr/bin/env node
/**
 * FPV full orchestrator — L0 → L1 → L2 → L3 → L4 → oracle + report.
 *
 *   npm run fpv:full -- --base=http://127.0.0.1:10200
 *   npm run fpv:full -- --offline
 *   npm run fpv:nightly
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, argFlag, apiBase } from './lib/paths.mjs';
import { runL0 } from './runners/l0.mjs';
import { runL1 } from './runners/l1-http.mjs';
import { runL2 } from './runners/l2-planes.mjs';
import { runL3 } from './runners/l3-shell-ui.mjs';
import { runJourneys } from './runners/journeys.mjs';
import { aggregateOracle } from './oracle/aggregate.mjs';
import { writeFpvReport } from './report/write-report.mjs';
import { healthOk } from './lib/http-chat.mjs';

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const offline =
    argFlag('--offline')
    || argFlag('--offline-only')
    || process.env.MY_AGENT_FPV_OFFLINE === '1';
  const nightly = argFlag('--nightly') || process.env.MY_AGENT_FPV_NIGHTLY === '1';
  const base = apiBase();
  const started = new Date().toISOString();

  console.log(`\n======== FPV FULL base=${base} offline=${offline} nightly=${nightly} ========`);

  const l0 = await runL0({ quick: nightly && argFlag('--quick-l0') });
  if (!l0.ok) {
    console.error('L0 failed — L2+ blocked per FPV contract');
    const oracle = aggregateOracle({ runHonest: true });
    const dir = writeFpvReport(oracle);
    writeFileSync(
      path.join(OUT_DIR, 'full-summary.json'),
      `${JSON.stringify({ started, ok: false, blockedAt: 'L0', reportDir: dir }, null, 2)}\n`,
    );
    process.exit(1);
  }

  let l1 = { ok: true, tag: 'explicit_skip', rows: [], note: 'offline' };
  let l2 = { ok: true, rows: [] };
  let l3 = { ok: true, rows: [] };
  let l4 = { ok: true, rows: [] };

  if (offline) {
    l2 = await runL2({ live: false });
    l3 = await runL3({ browser: false });
    l4 = await runJourneys({ offlineOnly: true, base });
  } else {
    const up = await healthOk(base);
    if (!up) {
      console.warn('API down — L1 live skipped (env-red); continuing offline-capable layers');
      l1 = {
        layer: 'L1',
        ok: false,
        tag: 'env-red',
        note: 'api_down',
        rows: [],
        started: new Date().toISOString(),
        finished: new Date().toISOString(),
        base,
      };
      writeFileSync(path.join(OUT_DIR, 'l1-http.json'), `${JSON.stringify(l1, null, 2)}\n`);
      l2 = await runL2({ live: false });
      l3 = await runL3({ browser: argFlag('--browser') });
      l4 = await runJourneys({ offlineOnly: true, base });
    } else {
      l1 = await runL1({ base });
      // L2 live is opt-in (--l2-live / soak); default full proves planes offline + L4 journeys live.
      l2 = await runL2({ live: argFlag('--l2-live') || process.env.MY_AGENT_FPV_L2_LIVE === '1' });
      l3 = await runL3({ browser: argFlag('--browser') });
      // nightly: market + deploy; full: all journeys when API up
      l4 = await runJourneys({
        offlineOnly: false,
        base,
        only: nightly && !argFlag('--all-journeys')
          ? 'J_market_process,J_deploy'
          : null,
      });
    }
  }

  const oracle = aggregateOracle({ runHonest: true });
  const dir = writeFpvReport(oracle);
  const summary = {
    started,
    finished: new Date().toISOString(),
    base,
    offline,
    nightly,
    ok: Boolean(oracle.ok && l0.ok),
    layers: {
      L0: { ok: l0.ok },
      L1: { ok: l1.ok, tag: l1.tag },
      L2: { ok: l2.ok },
      L3: { ok: l3.ok },
      L4: { ok: l4.ok },
    },
    counts: oracle.counts,
    gaps: oracle.gaps,
    reportDir: dir,
    headline: 'honest-v1',
    scoreHonestMean: oracle.scoreHonest?.productMean
      ?? oracle.scoreHonest?.mean
      ?? oracle.scoreHonest?.summary?.mean
      ?? null,
  };
  writeFileSync(path.join(OUT_DIR, 'full-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\n======== FPV FULL ok=${summary.ok} report=${dir} ========`);
  console.log(
    `nodes green=${oracle.counts.green} red=${oracle.counts.red} env=${oracle.counts.envRed} dark=${oracle.counts.dark}`,
  );
  if (oracle.gaps?.length) {
    console.log('\nGap tickets:');
    for (const g of oracle.gaps.slice(0, 20)) console.log(`  - ${g.ticket}`);
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
