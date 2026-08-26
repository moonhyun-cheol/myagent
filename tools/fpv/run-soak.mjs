#!/usr/bin/env node
/**
 * FPV soak — run fpv:full N times and diff oracle/gaps across runs.
 *
 *   npm run fpv:soak -- --times=2 --base=http://127.0.0.1:10200
 *   npm run fpv:soak -- --times=2 --offline
 *   npm run fpv:soak -- --times=1 --offline --compress-ab
 *   npm run fpv:soak -- --times=1 --l2-live
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, argFlag, argValue, apiBase } from './lib/paths.mjs';
import { runNode } from './lib/spawn.mjs';

const times = Math.max(1, Number(argValue('--times=', process.env.MY_AGENT_FPV_SOAK_TIMES || '2')));
const offline = argFlag('--offline') || argFlag('--offline-only');
const compressAb = argFlag('--compress-ab');
const compressAbOnly = argFlag('--compress-ab-only');
const l2Live = argFlag('--l2-live');
const base = apiBase();

mkdirSync(OUT_DIR, { recursive: true });
const soakDir = path.join(OUT_DIR, `soak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(soakDir, { recursive: true });

let compressAbResult = null;
if (compressAb || compressAbOnly) {
  console.log('\n======== SOAK compress A/B ========');
  const r = runNode('tools/verify-history-compress.mjs', ['--compress-ab']);
  const gapPath = path.join(OUT_DIR, 'compress-ab.json');
  const gap = existsSync(gapPath) ? JSON.parse(readFileSync(gapPath, 'utf8')) : null;
  compressAbResult = { ok: r.ok, status: r.status, gap };
  writeFileSync(path.join(soakDir, 'compress-ab.json'), `${JSON.stringify(compressAbResult, null, 2)}\n`);
  if (!r.ok) {
    console.error('compress-ab failed');
    process.exit(1);
  }
}

const runs = [];
if (!compressAbOnly) {
  for (let i = 1; i <= times; i++) {
    console.log(`\n======== SOAK ${i}/${times} ========`);
    const args = [];
    if (offline) args.push('--offline');
    args.push(`--base=${base}`);
    if (l2Live) args.push('--l2-live');
    const r = runNode('tools/fpv/run-full.mjs', args);
    const oraclePath = path.join(OUT_DIR, 'oracle.json');
    const oracle = existsSync(oraclePath) ? JSON.parse(readFileSync(oraclePath, 'utf8')) : null;
    const summaryPath = path.join(OUT_DIR, 'full-summary.json');
    const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
    const snap = {
      i,
      ok: r.ok,
      status: r.status,
      counts: oracle?.counts || null,
      gaps: oracle?.gaps || [],
      reportDir: summary?.reportDir || null,
      scoreHonestMean: summary?.scoreHonestMean ?? oracle?.scoreHonest?.productMean ?? null,
      l2Live,
    };
    writeFileSync(path.join(soakDir, `run-${i}.json`), `${JSON.stringify(snap, null, 2)}\n`);
    runs.push(snap);
  }
}

function gapKey(g) {
  return `${g.id}|${g.tag}|${g.ticket || ''}`;
}

const regressions = [];
if (runs.length >= 2) {
  const a = new Set((runs[0].gaps || []).map(gapKey));
  const b = new Set((runs[runs.length - 1].gaps || []).map(gapKey));
  for (const k of b) {
    if (!a.has(k)) regressions.push({ kind: 'new_gap', key: k });
  }
  for (const k of a) {
    if (!b.has(k)) regressions.push({ kind: 'resolved_gap', key: k });
  }
  const c0 = runs[0].counts || {};
  const c1 = runs[runs.length - 1].counts || {};
  if ((c1.red || 0) > (c0.red || 0)) {
    regressions.push({ kind: 'red_increased', from: c0.red, to: c1.red });
  }
  if ((c1.dark || 0) > (c0.dark || 0)) {
    regressions.push({ kind: 'dark_increased', from: c0.dark, to: c1.dark });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  times,
  offline,
  compressAb: Boolean(compressAb || compressAbOnly),
  compressAbOnly: Boolean(compressAbOnly),
  compressAbResult,
  l2Live: Boolean(l2Live),
  longHorizonNote: l2Live
    ? 'pattern-chain live subset included via --l2-live'
    : compressAbOnly
      ? 'compress-ab-only — full fpv skipped (preserves live journey evidence)'
      : 'L2 live not requested (pass --l2-live for long-horizon soak)',
  base,
  runs,
  regressions,
  ok:
    (compressAbOnly
      ? Boolean(compressAbResult?.ok)
      : runs.every((r) => r.ok)
        && !regressions.some((x) => x.kind === 'new_gap' || x.kind.endsWith('_increased')))
    && (compressAbResult ? compressAbResult.ok : true),
};
writeFileSync(path.join(soakDir, 'soak-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  path.join(soakDir, 'soak-summary.md'),
  [
    '# FPV Soak',
    '',
    `times=${times} offline=${offline} compressAb=${compressAb || compressAbOnly} compressAbOnly=${compressAbOnly} l2Live=${l2Live} ok=**${report.ok}**`,
    '',
    ...(runs.length
      ? runs.map(
          (r) =>
            `- run ${r.i}: ok=${r.ok} green=${r.counts?.green} red=${r.counts?.red} dark=${r.counts?.dark} mean=${r.scoreHonestMean}`,
        )
      : ['- full runs skipped (--compress-ab-only)']),
    '',
    '## Compress A/B',
    compressAbResult
      ? `- ok=${compressAbResult.ok} gap=${JSON.stringify(compressAbResult.gap?.gap || compressAbResult.gap || {})}`
      : '- skipped',
    '',
    '## Regressions',
    ...(regressions.length ? regressions.map((x) => `- ${x.kind}: ${x.key || `${x.from}→${x.to}`}`) : ['- none']),
    '',
  ].join('\n'),
);

console.log(`\n=== FPV SOAK ok=${report.ok} dir=${soakDir} ===`);
process.exit(report.ok ? 0 : 1);
