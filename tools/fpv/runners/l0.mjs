#!/usr/bin/env node
/** L0 offline goldens from manifest.l0Scripts. Fail → block L2+. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, OUT_DIR, argFlag } from '../lib/paths.mjs';
import { runNode, runNpm } from '../lib/spawn.mjs';

const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'tools/fpv/manifest.json'), 'utf8'),
);

export async function runL0(opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const quick = opts.quick || argFlag('--quick');
  const scripts = quick
    ? manifest.l0Scripts.filter((s) =>
      /capability-policy|outcome-gate|turn-decision|skills|market-fidelity|fixture-contract|pattern-chain/.test(
        s.id,
      ))
    : manifest.l0Scripts;

  const rows = [];
  const started = new Date().toISOString();
  for (const s of scripts) {
    console.log(`\n### L0 ${s.id}`);
    let r;
    if (s.npm) r = runNpm(s.npm);
    else if (s.node) r = runNode(s.node, s.args || []);
    else r = { ok: false, status: 1, out: 'no runner' };
    const tail = (r.out || '').trim().slice(-1200);
    if (tail) console.log(tail);
    rows.push({
      id: s.id,
      ok: r.ok,
      status: r.status,
      tag: r.ok ? 'green' : 'red',
      layer: 'L0',
    });
    if (!r.ok && (opts.failFast || argFlag('--fail-fast'))) break;
  }

  const ok = rows.every((x) => x.ok);
  const report = {
    layer: 'L0',
    started,
    finished: new Date().toISOString(),
    quick: Boolean(quick),
    ok,
    rows,
  };
  writeFileSync(path.join(OUT_DIR, 'l0.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('l0.mjs')) {
  runL0()
    .then((r) => {
      console.log(`\n=== FPV L0 ok=${r.ok} (${r.rows.filter((x) => x.ok).length}/${r.rows.length}) ===`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
