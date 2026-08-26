#!/usr/bin/env node
/**
 * Overnight FIX cycle harness (measure → triage → prove → optional live → log).
 * Does NOT auto-mutate product code (agent applies ≤3 fixes). Provides clear triage package.
 *
 *   node tools/lab/overnight-fix-cycle.mjs measure
 *   node tools/lab/overnight-fix-cycle.mjs prove
 *   node tools/lab/overnight-fix-cycle.mjs live-maturity
 *   node tools/lab/overnight-fix-cycle.mjs live-daily
 *   node tools/lab/overnight-fix-cycle.mjs append-log --cycle=1 --triage=... --fix=... --live=none
 *
 * Budget (whole night) env:
 *   MY_AGENT_FIX_MAX_LIVE=4  MY_AGENT_FIX_MAX_DAILY_LIVE=2
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const LOG = path.join(outDir, 'overnight-fix-cycle-log.md');
const BUDGET = path.join(outDir, 'overnight-fix-budget.json');
const TARGET = Number(process.env.MY_AGENT_DIM_TARGET || 95);
const base = (
  process.env.MY_AGENT_API_BASE || process.env.CQR_E2E_BASE_URL || 'http://127.0.0.1:10200'
).replace(/\/$/, '');

function loadBudget() {
  if (!existsSync(BUDGET)) {
    return {
      started: new Date().toISOString(),
      maturityLive: 0,
      dailyLive: 0,
      maxMaturityLive: Number(process.env.MY_AGENT_FIX_MAX_LIVE || 4),
      maxDailyLive: Number(process.env.MY_AGENT_FIX_MAX_DAILY_LIVE || 2),
      lastLiveSig: null,
      sameLiveFailStreak: 0,
    };
  }
  return JSON.parse(readFileSync(BUDGET, 'utf8'));
}
function saveBudget(b) {
  writeFileSync(BUDGET, `${JSON.stringify(b, null, 2)}\n`);
}

function runNode(rel, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, rel), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 40 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function readScore() {
  const p = path.join(outDir, 'maturity-scorecard.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function triageFrom(score) {
  const scores = score?.scores || {};
  const below = Object.entries(scores)
    .filter(([, v]) => v < TARGET)
    .sort((a, b) => a[1] - b[1])
    .map(([k, v]) => ({ dim: k, score: v, gap: TARGET - v }));
  const notes = [];
  for (const [dim, body] of Object.entries(score?.dims || {})) {
    const d = body?.details || {};
    if (d.notes?.length) notes.push({ dim, notes: d.notes });
    if (d.misses?.length) notes.push({ dim, misses: d.misses });
  }
  const cl = path.join(outDir, 'cursor-query-live-backtest.json');
  const liveFails = [];
  if (existsSync(cl)) {
    try {
      const j = JSON.parse(readFileSync(cl, 'utf8'));
      for (const r of j.results || []) {
        if (!r.hardOk || (r.failures || []).length) {
          liveFails.push({
            id: r.id,
            failures: r.failures || [],
            preview: String(r.contentPreview || '').slice(0, 160),
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Ranked fix themes (evidence → advice), max 3
  const themes = [];
  if (below.some((b) => b.dim === 'daily_loop')) {
    themes.push({
      theme: 'daily_real_live',
      evidence: 'daily_loop BELOW + no_real_daily_live',
      action:
        'Budget-permitting: real daily-smoke full once; never history rows. Improve product only if live fails have case ids.',
    });
  }
  if (below.some((b) => b.dim === 'l1_hardbars' || b.dim === 'cursor_feel')) {
    themes.push({
      theme: 'live_hardbars_quality',
      evidence: `l1=${scores.l1_hardbars} feel=${scores.cursor_feel} cons=${score?.gates?.consecutiveFull}`,
      action:
        'Real maturity --live (ledger only). Product fix on fail ids before re-run; no 3× same live fail without code change.',
    });
  }
  if (liveFails.length) {
    themes.push({
      theme: 'fix_live_case_ids',
      evidence: liveFails.map((f) => f.id).join(','),
      action: 'Code fix for hardOk=false cases: ' + liveFails.map((f) => `${f.id}:${(f.failures || []).join('|')}`).join('; '),
      cases: liveFails.slice(0, 8),
    });
  }
  if (below.some((b) => b.dim === 'harness_l0' || b.dim === 'three_plane')) {
    themes.push({
      theme: 'offline_l0_plane',
      evidence: below.filter((b) => b.dim === 'harness_l0' || b.dim === 'three_plane'),
      action: 'Fail L0 gates — fix verify goldens / plane matrix; no live spend until L0 green.',
    });
  }
  return {
    below,
    notes,
    liveFails,
    themesTop3: themes.slice(0, 3),
    productMean: score?.productMean,
    minScore: score?.minScore,
    allPass: score?.allPass,
    policy: score?.scoringPolicy,
    gates: score?.gates,
    scores,
  };
}

function appendSection(md) {
  if (!existsSync(LOG)) {
    writeFileSync(
      LOG,
      [
        '# Overnight FIX cycle log',
        '',
        `Started (file create): ${new Date().toISOString()}`,
        `Policy source: data/_skill_tool_lab/maturity-scorecard.md|.json`,
        `Budget: maturity-live≤4 · daily-full-live≤2 · fix≤3 themes/cycle`,
        '',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  appendFileSync(LOG, md.endsWith('\n') ? md : `${md}\n`, 'utf8');
}

const cmd = process.argv[2] || 'measure';
const arg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : '';
};

async function main() {
  if (cmd === 'measure') {
    console.log('### PROVE L0 (daily-smoke offline)');
    const d = runNode('tools/lab/daily-smoke.mjs', ['--offline-only']);
    console.log(d.ok ? 'L0 offline PASS' : 'L0 offline FAIL');
    console.log('### MATURITY --cold');
    const m = runNode('tools/lab/maturity-scorecard.mjs', ['--cold']);
    const score = readScore();
    const triage = triageFrom(score);
    writeFileSync(
      path.join(outDir, 'overnight-fix-last-triage.json'),
      `${JSON.stringify({ at: new Date().toISOString(), l0Offline: d.ok, score, triage }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ mean: score?.productMean, min: score?.minScore, scores: score?.scores, below: triage.below, themes: triage.themesTop3 }, null, 2));
    process.exit(score?.allPass ? 0 : d.ok ? 2 : 1);
  }

  if (cmd === 'prove') {
    const d = runNode('tools/lab/daily-smoke.mjs', ['--offline-only']);
    const m = runNode('tools/lab/maturity-scorecard.mjs', ['--cold']);
    const score = readScore();
    console.log(JSON.stringify({ l0: d.ok, mean: score?.productMean, scores: score?.scores, policy: score?.scoringPolicy }, null, 2));
    process.exit(d.ok ? 0 : 1);
  }

  if (cmd === 'live-maturity') {
    const b = loadBudget();
    if (b.maturityLive >= b.maxMaturityLive) {
      console.error(`BUDGET_EXHAUSTED maturityLive ${b.maturityLive}/${b.maxMaturityLive}`);
      process.exit(3);
    }
    const r = runNode('tools/lab/maturity-scorecard.mjs', ['--live', '--repeats=1'], {
      MY_AGENT_API_BASE: base,
    });
    b.maturityLive += 1;
    const score = readScore();
    const hard = score?.dims?.l1_hardbars?.details?.liveRuns?.slice(-1)[0];
    const sig = hard
      ? `c${hard.cursorHard}/${hard.cursorTotal}|k${hard.chainPass}/${hard.chainTotal}|e${hard.emptyN}|a${hard.abandonN}|bars=${hard.barsOk}`
      : 'unknown';
    if (!hard?.barsOk) {
      if (b.lastLiveSig === sig) b.sameLiveFailStreak += 1;
      else {
        b.lastLiveSig = sig;
        b.sameLiveFailStreak = 1;
      }
    } else {
      b.sameLiveFailStreak = 0;
      b.lastLiveSig = sig;
    }
    if (b.sameLiveFailStreak >= 3) {
      console.error(`SAME_LIVE_FAIL_STREAK>=3 ${sig} — fix code before more live`);
    }
    saveBudget(b);
    console.log(JSON.stringify({ ok: r.ok, budget: b, mean: score?.productMean, scores: score?.scores, sig }, null, 2));
    process.exit(b.sameLiveFailStreak >= 3 ? 4 : r.ok ? 0 : 1);
  }

  if (cmd === 'live-daily') {
    const b = loadBudget();
    if (b.dailyLive >= b.maxDailyLive) {
      console.error(`BUDGET_EXHAUSTED dailyLive ${b.dailyLive}/${b.maxDailyLive}`);
      process.exit(3);
    }
    const r = runNode('tools/lab/daily-smoke.mjs', [], { MY_AGENT_API_BASE: base });
    b.dailyLive += 1;
    saveBudget(b);
    runNode('tools/lab/maturity-scorecard.mjs', ['--cold']);
    const score = readScore();
    console.log(JSON.stringify({ ok: r.ok, budget: b, mean: score?.productMean, scores: score?.scores }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'append-log') {
    const cycle = arg('cycle') || '?';
    const phase = arg('phase') || 'cycle';
    const triage = arg('triage') || '(see overnight-fix-last-triage.json)';
    const fix = arg('fix') || '(none)';
    const live = arg('live') || 'none';
    const prove = arg('prove') || '';
    const score = readScore();
    const body = [
      `## Cycle ${cycle} · ${phase} · ${new Date().toISOString()}`,
      '',
      `- policy: \`${score?.scoringPolicy || '?'}\``,
      `- productMean: **${score?.productMean}** · min: **${score?.minScore}** · allPass: **${score?.allPass}**`,
      `- scores: \`${JSON.stringify(score?.scores || {})}\``,
      `- gates: \`${JSON.stringify(score?.gates || {})}\``,
      `- BELOW: ${Object.entries(score?.scores || {})
        .filter(([, v]) => v < TARGET)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '_none_'}`,
      `- triage: ${triage}`,
      `- fix (≤3): ${fix}`,
      `- prove: ${prove}`,
      `- live: ${live}`,
      '',
      '---',
      '',
    ].join('\n');
    appendSection(body);
    console.log(`appended cycle ${cycle} → ${LOG}`);
    process.exit(0);
  }

  console.error(`unknown cmd ${cmd}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
