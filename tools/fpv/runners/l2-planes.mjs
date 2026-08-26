#!/usr/bin/env node
/** L2 agent planes — offline pattern-chain (+ optional live adapter). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, argFlag } from '../lib/paths.mjs';
import { runNode } from '../lib/spawn.mjs';
import { healthOk } from '../lib/http-chat.mjs';
import { apiBase } from '../lib/paths.mjs';

export async function runL2(opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const rows = [];

  console.log('\n### L2 pattern-chain offline');
  const offline = runNode('tools/lab/pattern-chain-backtest.mjs');
  rows.push({
    id: 'pattern-chain:offline',
    ok: offline.ok,
    tag: offline.ok ? 'green' : 'red',
    layer: 'L2',
  });

  console.log('\n### L2 cursor-backtest offline');
  const cursor = runNode('tools/lab/cursor-query-backtest.mjs');
  rows.push({
    id: 'cursor-backtest:offline',
    ok: cursor.ok,
    tag: cursor.ok ? 'green' : 'red',
    layer: 'L2',
  });

  const wantLive = opts.live || argFlag('--live') || process.env.MY_AGENT_FPV_L2_LIVE === '1';
  const base = apiBase();
  if (wantLive && (await healthOk(base))) {
    console.log('\n### L2 pattern-chain live (subset)');
    const live = runNode('tools/lab/pattern-chain-backtest.mjs', ['--live'], {
      MY_AGENT_API_BASE: base,
      MY_AGENT_PATTERN_LIVE_CHAINS:
        process.env.MY_AGENT_PATTERN_LIVE_CHAINS || 'C_repo_inspect,C_local_docs',
    });
    rows.push({
      id: 'pattern-chain:live',
      ok: live.ok,
      tag: live.ok ? 'green' : 'red',
      layer: 'L2',
    });
  } else {
    rows.push({
      id: 'pattern-chain:live',
      ok: true,
      tag: 'explicit_skip',
      layer: 'L2',
      note: wantLive ? 'api_down' : 'live_not_requested',
    });
  }

  const ok = rows.filter((r) => r.tag !== 'explicit_skip').every((r) => r.ok);
  const report = {
    layer: 'L2',
    started,
    finished: new Date().toISOString(),
    ok,
    rows,
  };
  writeFileSync(path.join(OUT_DIR, 'l2-planes.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1]?.endsWith('l2-planes.mjs')) {
  runL2()
    .then((r) => {
      console.log(`=== FPV L2 ok=${r.ok} ===`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
