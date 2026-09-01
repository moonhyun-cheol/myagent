#!/usr/bin/env node
/**
 * Daily smoke — L0 offline gates + optional L1 live (three-plane hard bars).
 *
 *   node tools/lab/daily-smoke.mjs
 *   node tools/lab/daily-smoke.mjs --offline-only
 *   $env:MY_AGENT_API_BASE='http://127.0.0.1:10210'; npm run lab:daily-smoke
 *
 * Exit 0 only when offline green and (if live enabled and API up) live hard bars pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });

const offlineOnly =
  process.argv.includes('--offline-only') || process.env.MY_AGENT_SMOKE_OFFLINE === '1';
const base = (
  process.env.MY_AGENT_API_BASE || process.env.CQR_E2E_BASE_URL || 'http://127.0.0.1:10210'
).replace(/\/$/, '');
const liveChains =
  process.env.MY_AGENT_PATTERN_LIVE_CHAINS
  || 'C_local_docs,C_continue_deploy,C_repo_inspect';

function run(label, args, env = {}) {
  console.log(`\n### ${label}`);
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (out) console.log(out.slice(-4000));
  return { label, ok: r.status === 0, status: r.status ?? 1 };
}

async function healthOk() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    return Boolean(j?.ok);
  } catch {
    return false;
  }
}

async function main() {
  const rows = [];
  const started = new Date().toISOString();

  rows.push(
    run('verify:capability-policy', [
      path.join(root, 'tools/verify-capability-policy.mjs'),
    ]),
  );
  rows.push(
    run('verify:turn-decision', [path.join(root, 'tools/verify-turn-decision.mjs')]),
  );
  rows.push(
    run('verify:work-mode-loop', [path.join(root, 'tools/verify-work-mode-loop.mjs')]),
  );
  rows.push(
    run('verify:run-terminal-sanitize', [
      path.join(root, 'tools/verify-run-terminal-sanitize.mjs'),
    ]),
  );
  rows.push(
    run('verify:harness-goldens', [path.join(root, 'tools/verify-harness-goldens.mjs')]),
  );
  rows.push(
    run('lab:pattern-chain', [path.join(root, 'tools/lab/pattern-chain-backtest.mjs')]),
  );
  rows.push(
    run('lab:cursor-backtest', [path.join(root, 'tools/lab/cursor-query-backtest.mjs')]),
  );

  let liveRan = false;
  let liveNote = 'skipped (--offline-only or API down)';
  if (!offlineOnly) {
    const up = await healthOk();
    if (!up) {
      liveNote = `API not up at ${base} — start:api then re-run without --offline-only`;
      console.log(`\n### live SKIP: ${liveNote}`);
    } else {
      liveRan = true;
      rows.push(
        run('lab:cursor-backtest:live', [
          path.join(root, 'tools/lab/cursor-query-live-backtest.mjs'),
        ], { MY_AGENT_API_BASE: base }),
      );
      // Long cursor suite can leave API momentarily busy — health pause before chains.
      const { waitForApi } = await import('./lab-live-http.mjs');
      await waitForApi(base, 15_000);
      await new Promise((r) => setTimeout(r, 1500));
      rows.push(
        run('lab:pattern-chain:live', [
          path.join(root, 'tools/lab/pattern-chain-backtest.mjs'),
          '--live',
        ], {
          MY_AGENT_API_BASE: base,
          MY_AGENT_PATTERN_LIVE_CHAINS: liveChains,
        }),
      );
      liveNote = `ran @ ${base} chains=${liveChains}`;
    }
  }

  const offlineRows = rows.filter((r) => !r.label.includes('live'));
  const liveRows = rows.filter((r) => r.label.includes('live'));
  const offlineOk = offlineRows.every((r) => r.ok);
  // Live only counts when we actually ran live steps in THIS invocation.
  const liveOk = liveRan ? liveRows.every((r) => r.ok) : false;
  const ok = offlineOnly ? offlineOk : offlineOk && liveOk;

  const report = {
    generatedAt: started,
    finishedAt: new Date().toISOString(),
    base,
    offlineOnly,
    liveRan,
    liveNote,
    offlineOk,
    liveOk: liveRan ? liveOk : false,
    ok,
    rows,
    policy: 'real-live-only-v1',
  };
  const jsonPath = path.join(outDir, 'daily-smoke-report.json');
  const offlinePath = path.join(outDir, 'daily-smoke-offline.json');

  // Offline prove must NOT wipe a fresh real-live daily report (scorecard daily_loop).
  let writeMain = true;
  if (offlineOnly && existsSync(jsonPath)) {
    try {
      const prev = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const ageH =
        (Date.now() - Date.parse(prev.finishedAt || prev.generatedAt || 0)) / 3_600_000;
      const hadRealLive =
        prev.liveRan === true
        && prev.offlineOnly !== true
        && !String(prev.liveNote || '').includes('history');
      if (hadRealLive && Number.isFinite(ageH) && ageH <= 36) {
        writeMain = false;
        console.log(
          `preserve daily-smoke-report.json (real live ${ageH.toFixed(1)}h ago) — offline → daily-smoke-offline.json`,
        );
      }
    } catch {
      /* rewrite main */
    }
  }

  if (offlineOnly) {
    writeFileSync(offlinePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (writeMain) {
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  } else {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  const md = [
    '# Daily smoke',
    '',
    `Generated: ${report.finishedAt}`,
    '',
    `| Gate | OK |`,
    `|------|----|`,
    `| Offline (L0) | **${offlineOk ? 'PASS' : 'FAIL'}** |`,
    `| Live (L1) | **${liveRan ? (liveOk ? 'PASS' : 'FAIL') : 'SKIP'}** |`,
    `| Overall | **${ok ? 'PASS' : 'FAIL'}** |`,
    '',
    `Live note: ${liveNote}`,
    '',
    '## Steps',
    '',
    ...rows.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} \`${r.label}\` (exit ${r.status})`),
    '',
  ].join('\n');
  writeFileSync(path.join(outDir, 'daily-smoke-report.md'), md, 'utf8');
  console.log(`\n=== DAILY SMOKE ${ok ? 'PASS' : 'FAIL'} ===`);
  console.log(md);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
