#!/usr/bin/env node
/**
 * MY Agent skill & tool lab — exercise product surface and report pass/skip/fail.
 *
 * Usage:
 *   node tools/lab/skill-tool-lab.mjs
 *   node tools/lab/skill-tool-lab.mjs --level=0|1|2
 *   node tools/lab/skill-tool-lab.mjs --fail-on-skip
 *   MY_AGENT_LAB_FAIL_ON_SKIP=1 node tools/lab/skill-tool-lab.mjs
 *   MY_AGENT_LAB_BROWSER=1 node tools/lab/skill-tool-lab.mjs
 *   MY_AGENT_LAB_L2=1 node tools/lab/skill-tool-lab.mjs --level=2
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './catalog.mjs';
import { runToolsDirect } from './runners/tools-direct.mjs';
import { runSkills } from './runners/skills-l0.mjs';
import { runBrowserTools } from './runners/browser-tools.mjs';
import { runAutomatonDry } from './runners/automaton-dry.mjs';
import { runSkillsL2 } from './runners/skills-l2.mjs';
import { runDomainL1 } from './runners/domain-l1.mjs';
import { runEmbeddingCold } from './runners/embedding-cold.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;

const args = process.argv.slice(2);
const catalogOnly = args.includes('--catalog-only');
const levelArg = args.find((a) => a.startsWith('--level='));
const level = levelArg ? Number(levelArg.split('=')[1]) : 1;
const wantBrowser = args.includes('--browser') || process.env.MY_AGENT_LAB_BROWSER === '1';
const failOnSkip =
  args.includes('--fail-on-skip') || process.env.MY_AGENT_LAB_FAIL_ON_SKIP === '1';

/** Skips that remain allowed under --fail-on-skip (true soft/opt-in). */
const ALLOWED_SKIP_RE =
  /skipped\s*≠\s*pass|noop|weak_pass|opt-in|MY_AGENT_LAB_|playwright unavailable|pipeline.?script unavailable|pipeline_script|openclaw_live|set MY_AGENT_LAB_L2|unavailable \(capability|not available/i;

function ensureBuild() {
  if (existsSync(path.join(root, 'core/dist/agent/tools.js'))) return;
  console.log('building core…');
  const r = spawnSync(process.execPath, [path.join(root, 'tools/build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function summarize(rows) {
  const c = { pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const r of rows) {
    if (c[r.result] != null) c[r.result] += 1;
    else c.fail += 1;
  }
  return c;
}

function applyFailOnSkip(rows) {
  if (!failOnSkip) return rows;
  return rows.map((r) => {
    if (r.result !== 'skip') return r;
    const blob = `${r.item} ${r.note || ''}`;
    if (ALLOWED_SKIP_RE.test(blob)) return r;
    return {
      ...r,
      result: 'fail',
      note: `fail-on-skip: ${r.note || 'unexpected skip'}`,
    };
  });
}

function mdReport(catalog, rows, summary) {
  const lines = [
    '# MY Agent Skill/Tool Lab Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    failOnSkip ? 'Mode: --fail-on-skip (unexpected skips → fail)' : '',
    '',
    '## Catalog counts',
    '',
    `- code tools: ${catalog.counts.code_tools}`,
    `- browser tools: ${catalog.counts.browser_tools}`,
    `- skills: ${catalog.counts.skills}`,
    `- automaton: ${catalog.counts.automaton}`,
    `- domains: ${catalog.counts.domains}`,
    '',
    '## Summary',
    '',
    `| pass | fail | skip | blocked |`,
    `| ---: | ---: | ---: | ---: |`,
    `| ${summary.pass} | ${summary.fail} | ${summary.skip} | ${summary.blocked} |`,
    '',
    '## Results',
    '',
    '| suite | item | level | result | ms | note |',
    '| --- | --- | ---: | --- | ---: | --- |',
  ];
  for (const r of rows) {
    const note = String(r.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${r.suite} | ${r.item} | ${r.level} | ${r.result} | ${r.ms} | ${note} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  ensureBuild();
  const catalog = await loadCatalog();
  const outDir = path.join(root, 'data', '_skill_tool_lab');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  if (catalogOnly) {
    console.log(JSON.stringify(catalog.counts, null, 2));
    console.log('catalog ->', path.join(outDir, 'catalog.json'));
    return;
  }

  let rows = [];
  const namesMatch =
    JSON.stringify(catalog.code_tools) === JSON.stringify(catalog.code_tool_names_export);
  rows.push({
    suite: 'catalog',
    item: 'code_tools_vs_names_export',
    level: 0,
    result: namesMatch ? 'pass' : 'fail',
    ms: 0,
    note: `tools=${catalog.code_tools.length}`,
  });
  rows.push({
    suite: 'catalog',
    item: 'skills_manifest',
    level: 0,
    result: catalog.skills.length === 3 ? 'pass' : 'fail',
    ms: 0,
    note: catalog.skills.map((s) => s.id).join(','),
  });

  rows.push(...(await runSkills(root, catalog, Math.min(level, 1))));
  rows.push(...(await runAutomatonDry(root)));
  rows.push(...(await runDomainL1(root)));

  let fixture = path.join(outDir, 'fixture');
  if (level >= 1) {
    console.log('tools L1 (direct execute)…');
    const toolRun = await runToolsDirect(root, catalog, { browser: wantBrowser });
    fixture = toolRun.fixture;
    rows.push(...toolRun.rows);
    writeFileSync(path.join(outDir, 'fixture-path.txt'), `${fixture}\n`, 'utf8');

    console.log('browser tools…');
    rows.push(...(await runBrowserTools(root, fixture, { force: wantBrowser })));

    console.log('embedding cold…');
    rows.push(...(await runEmbeddingCold(root, outDir)));
  }

  if (level >= 2 || process.env.MY_AGENT_LAB_L2 === '1') {
    console.log('skills L2…');
    process.env.MY_AGENT_LAB_L2 = process.env.MY_AGENT_LAB_L2 || '1';
    rows.push(...(await runSkillsL2(root)));
  }

  rows = applyFailOnSkip(rows);
  const summary = summarize(rows);
  const report = {
    ok: summary.fail === 0,
    level,
    fail_on_skip: failOnSkip,
    summary,
    catalog_counts: catalog.counts,
    rows,
  };

  writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(outDir, 'report.md'), mdReport(catalog, rows, summary), 'utf8');

  console.log('');
  console.log(
    JSON.stringify(
      { ok: report.ok, fail_on_skip: failOnSkip, summary, out: outDir },
      null,
      2,
    ),
  );
  console.log('report ->', path.join(outDir, 'report.md'));

  const fails = rows.filter((r) => r.result === 'fail');
  const skips = rows.filter((r) => r.result === 'skip');
  writeFileSync(
    path.join(outDir, 'findings.json'),
    `${JSON.stringify(
      {
        fails: fails.map((f) => ({ item: f.item, note: f.note })),
        skips: skips.map((s) => ({ item: s.item, note: s.note })),
        hints: [
          fails.length ? 'Fix fail rows first.' : 'No fails at this level.',
          failOnSkip
            ? 'fail-on-skip: only ALLOWED_SKIP soft/opt-in skips remain.'
            : 'Use --fail-on-skip for CI strictness on unexpected skips.',
        ].filter(Boolean),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
