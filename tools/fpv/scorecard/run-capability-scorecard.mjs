#!/usr/bin/env node
/**
 * Capability scorecard — fixed catalog + evidence-adjusted scores.
 *
 *   node tools/fpv/scorecard/run-capability-scorecard.mjs
 *   node tools/fpv/scorecard/run-capability-scorecard.mjs --run-verifies
 *   node tools/fpv/scorecard/run-capability-scorecard.mjs --base=http://127.0.0.1:10200
 *
 * Reads journeys / prior verify outputs under data/_fpv + optional live health.
 * Does NOT invent green: missing evidence → dark penalty (not free points).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const OUT = path.join(REPO, 'data', '_fpv');
const CATALOG = path.join(HERE, 'capability-scorecard.json');

const runVerifies = process.argv.includes('--run-verifies');
const base = (
  process.env.MY_AGENT_API_BASE
  || process.env.CQR_E2E_BASE_URL
  || process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length)
  || 'http://127.0.0.1:10200'
).replace(/\/$/, '');

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function journeyPathCandidates(id) {
  const out = [path.join(OUT, `journey-${id}.json`)];
  // Market specialized runner historically writes journey-market-process.json
  if (id === 'J_market_process') {
    out.push(path.join(OUT, 'journey-market-process.json'));
  }
  return out;
}

function classifyJourney(id) {
  let j = null;
  for (const p of journeyPathCandidates(id)) {
    j = readJson(p);
    if (j) break;
  }
  if (!j) return { tag: 'dark', ok: false, live: false, note: 'missing' };
  if (j.tag === 'env-red') return { tag: 'env-red', ok: false, live: false, note: j.note };
  if (j.offlineOnly || j.note === 'offline-only' || j.tag === 'explicit_skip') {
    return { tag: 'explicit_skip', ok: Boolean(j.ok), live: false, note: j.note || 'offline-only' };
  }
  return { tag: j.ok ? 'green' : 'red', ok: Boolean(j.ok), live: true, note: j.note || null };
}

function runNpm(script) {
  const r = spawnSync('npm', ['run', script, '--silent'], {
    cwd: REPO,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status ?? 1, tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-400) };
}

async function healthOk() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const j = await res.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}

function pathOk(rel) {
  return existsSync(path.join(REPO, rel.replace(/\//g, path.sep)));
}

function fileHasMarker(rel, marker) {
  const p = path.join(REPO, rel.replace(/\//g, path.sep));
  if (!existsSync(p)) return false;
  try {
    return readFileSync(p, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function adjustScore(item, evidence) {
  let score = item.baseline;
  const notes = [];

  // Journey evidence
  for (const jid of item.evidence.journeys || []) {
    const st = evidence.journeys[jid];
    if (!st || st.tag === 'dark') {
      score -= 8;
      notes.push(`journey_dark:${jid}`);
    } else if (st.tag === 'red') {
      score -= 18;
      notes.push(`journey_red:${jid}`);
    } else if (st.tag === 'env-red') {
      score -= 6;
      notes.push(`journey_env:${jid}`);
    } else if (st.tag === 'explicit_skip' || !st.live) {
      // IMP-RMT-01: skipUnless / offline-only is not a product failure — light touch only
      const softSkip = Boolean(item.evidence?.skipUnless);
      score -= softSkip ? 1 : 3;
      notes.push(softSkip ? `journey_skipUnless:${jid}` : `journey_offline:${jid}`);
    } else if (st.live && st.ok) {
      score += 2;
      notes.push(`journey_live:${jid}`);
    }
  }

  // Verify evidence
  for (const v of item.evidence.verifies || []) {
    const st = evidence.verifies[v];
    if (!st) {
      score -= 4;
      notes.push(`verify_unknown:${v}`);
    } else if (!st.ok) {
      score -= 12;
      notes.push(`verify_red:${v}`);
    } else {
      notes.push(`verify_ok:${v}`);
    }
  }

  // Path / marker
  for (const p of item.evidence.pathChecks || []) {
    if (!pathOk(p)) {
      score -= 20;
      notes.push(`path_missing:${p}`);
    }
  }
  for (const m of item.evidence.markers || []) {
    const paths = item.evidence.pathChecks?.length
      ? item.evidence.pathChecks
      : ['ui/workspace/src/components/ChatPane.tsx', 'core/src/routes/dispatch.ts'];
    const hit = paths.some((p) => fileHasMarker(p, m))
      || fileHasMarker('ui/workspace/src/components/ChatPane.tsx', m)
      || fileHasMarker('core/src/routes/dispatch.ts', m);
    if (!hit) {
      score -= 5;
      notes.push(`marker_miss:${m}`);
    } else {
      notes.push(`marker_ok:${m}`);
    }
  }

  if (item.evidence.httpHealth) {
    if (evidence.health) {
      score += 1;
      notes.push('health_ok');
    } else {
      score -= 5;
      notes.push('health_down');
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const hardFails = [];
  for (const rule of item.hardFailIf || []) {
    if (rule === 'journey_red' && (item.evidence.journeys || []).some((id) => evidence.journeys[id]?.tag === 'red')) {
      hardFails.push(rule);
    }
    if (rule === 'verify_red' && (item.evidence.verifies || []).some((v) => evidence.verifies[v] && !evidence.verifies[v].ok)) {
      hardFails.push(rule);
    }
    if (rule === 'health_down' && item.evidence.httpHealth && !evidence.health) {
      hardFails.push(rule);
    }
    if (rule === 'path_missing' && (item.evidence.pathChecks || []).some((p) => !pathOk(p))) {
      hardFails.push(rule);
    }
  }

  return { score, notes, hardFails };
}

function bandFor(score, bands) {
  for (const b of bands) {
    if (score >= b.min) return b.label;
  }
  return 'backlog_or_skip';
}

const catalog = readJson(CATALOG);
if (!catalog?.items?.length) {
  console.error('capability-scorecard.json missing/invalid');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const evidence = {
  health: await healthOk(),
  journeys: {},
  verifies: {},
};

for (const item of catalog.items) {
  for (const jid of item.evidence.journeys || []) {
    if (!evidence.journeys[jid]) evidence.journeys[jid] = classifyJourney(jid);
  }
}

const verifySet = new Set();
for (const item of catalog.items) {
  for (const v of item.evidence.verifies || []) verifySet.add(v);
}

if (runVerifies) {
  console.log(`\n=== running ${verifySet.size} verifies ===`);
  for (const v of [...verifySet].sort()) {
    process.stdout.write(`  ${v} … `);
    const r = runNpm(v);
    evidence.verifies[v] = r;
    console.log(r.ok ? 'ok' : `FAIL(${r.status})`);
  }
} else {
  // Assume verifies ok unless we find a red flag file; prefer --run-verifies for hard truth.
  // Soft mode: treat package scripts as present = provisional ok, mark as assumed.
  for (const v of verifySet) {
    const pkg = readJson(path.join(REPO, 'package.json'));
    const has = Boolean(pkg?.scripts?.[v]);
    evidence.verifies[v] = { ok: has, assumed: true, note: has ? 'script_present_not_rerun' : 'script_missing' };
    if (!has) evidence.verifies[v].ok = false;
  }
}

const rows = [];
const humanRubricNotes = [];
for (const item of catalog.items) {
  const adj = adjustScore(item, evidence);
  if (item.humanRubric && typeof item.humanRubric === 'object') {
    humanRubricNotes.push({
      id: item.id,
      scale: item.humanRubric.scale ?? 3,
      note: item.humanRubric.note || '',
      // Intentionally omitted from productMean / score math (IMP-MKT-04).
    });
  }
  rows.push({
    id: item.id,
    label: item.label,
    domain: item.domain,
    priority: item.priority,
    baseline: item.baseline,
    score: adj.score,
    delta: adj.score - item.baseline,
    band: bandFor(adj.score, catalog.bands),
    hardFails: adj.hardFails,
    improveIds: item.improveIds || [],
    notes: adj.notes,
  });
}

const productMean = Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length);
const hardFailCount = rows.filter((r) => r.hardFails.length).length;
const byBand = {};
for (const r of rows) byBand[r.band] = (byBand[r.band] || 0) + 1;

const report = {
  generatedAt: new Date().toISOString(),
  catalogVersion: catalog.version,
  base,
  health: evidence.health,
  runVerifies,
  productMean,
  hardFailCount,
  byBand,
  humanRubricNotes,
  counts: {
    items: rows.length,
    liveJourneys: Object.values(evidence.journeys).filter((j) => j.live && j.ok).length,
    darkJourneys: Object.values(evidence.journeys).filter((j) => j.tag === 'dark').length,
  },
  journeys: evidence.journeys,
  rows: rows.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)),
  ok: hardFailCount === 0 && productMean >= 80,
};

writeFileSync(path.join(OUT, 'capability-scorecard.json'), `${JSON.stringify(report, null, 2)}\n`);

const md = [
  '# MY Agent Capability Scorecard',
  '',
  `generated: ${report.generatedAt}`,
  `productMean: **${productMean}**/100 · hardFails: **${hardFailCount}** · health: ${evidence.health} · runVerifies: ${runVerifies}`,
  `ok: **${report.ok}**`,
  '',
  '## Scores (low → high)',
  '',
  '| Score | ID | Label | Δ | Band | Hard | Improve |',
  '|------:|----|-------|--:|------|------|---------|',
  ...rows.map(
    (r) =>
      `| ${r.score} | \`${r.id}\` | ${r.label} | ${r.delta >= 0 ? '+' : ''}${r.delta} | ${r.band} | ${r.hardFails.join(',') || '—'} | ${(r.improveIds || []).join(', ') || '—'} |`,
  ),
  '',
  '## Bands',
  '',
  ...Object.entries(byBand).map(([k, v]) => `- ${k}: ${v}`),
  '',
  '## Human rubric (not in productMean)',
  '',
  ...(humanRubricNotes.length
    ? humanRubricNotes.map((h) => `- \`${h.id}\` scale=${h.scale}: ${h.note}`)
    : ['- none']),
  '',
];
writeFileSync(path.join(OUT, 'capability-scorecard.md'), md.join('\n'));

console.log(`\n=== capability-scorecard productMean=${productMean} hardFails=${hardFailCount} ok=${report.ok} ===`);
console.log(`wrote ${path.join(OUT, 'capability-scorecard.json')}`);
for (const r of rows.slice(0, 8)) {
  console.log(`  ${r.score}  ${r.id}  (${r.notes.slice(0, 3).join('; ')})`);
}

process.exit(report.ok ? 0 : 1);
