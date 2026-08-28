#!/usr/bin/env node
/**
 * Full-surface stress — covers layers beyond web_dev file scaffold:
 *  1) agent maxstress (optional skip if demo already on disk)
 *  2) Playwright real DOM vs demo
 *  3) OpenClaw config + /health (no slash side effects)
 *  4) Market pipeline capability honesty (+ optional live file probe)
 *  5) Product UI/shell inAppBrowser call-path evidence
 *  6) Embedding / repo-map / search_files quality on demo workspace
 *  7) Automaton dry schema
 *  8) Embedding cold (zero-hit soft)
 *  9) Skill quality (routing + inject honesty)
 * 10) Path-free greenfield soft fixture (no LLM)
 *
 *   node tools/lab/full-surface-stress.mjs
 *   MY_AGENT_LAB_SKIP_AGENT=1 node tools/lab/full-surface-stress.mjs   # reuse demo on disk
 *   MY_AGENT_LAB_BROWSER=1 MY_AGENT_LAB_OPENCLAW_LIVE=1 …                   # tighten optional fails
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;

const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'full-surface-stress-report.json');

function resolveDemoWs() {
  const max = process.env.CQR_MAXSTRESS_WS?.trim();
  if (max) return max;
  const dedicated = path.join(process.env.USERPROFILE || '', 'Desktop', 'CQR_MaxStress_Demo');
  if (existsSync(path.join(dedicated, 'public/index.html'))) return dedicated;
  const all = path.join(process.env.USERPROFILE || '', 'Desktop', 'CQR_AllSkill_Demo');
  if (existsSync(path.join(all, 'public/index.html'))) return all;
  return dedicated;
}

function summarize(rows) {
  const s = { pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const r of rows) {
    if (r.result === 'pass') s.pass += 1;
    else if (r.result === 'fail') s.fail += 1;
    else if (r.result === 'blocked') s.blocked += 1;
    else s.skip += 1;
  }
  return s;
}

const t0 = Date.now();
const allRows = [];
const demoWs = resolveDemoWs();

// --- 1) Agent maxstress (optional) ---
const skipAgent =
  process.env.MY_AGENT_LAB_SKIP_AGENT === '1'
  || (process.env.MY_AGENT_LAB_SKIP_AGENT !== '0'
    && existsSync(path.join(demoWs, 'package.json'))
    && existsSync(path.join(demoWs, 'public/index.html')));

if (!skipAgent) {
  console.log('\n=== [1/10] agent-only maxstress (live LLM) ===');
  const r = spawnSync(process.execPath, [path.join(root, 'tools/lab/agent-only-maxstress.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      MY_AGENT_CODE_OWUI_PROTOCOL: process.env.MY_AGENT_CODE_OWUI_PROTOCOL || 'text',
      MY_AGENT_CODE_AUTOPILOT: '1',
    },
    encoding: 'utf8',
    timeout: 900_000,
  });
  allRows.push({
    suite: 'agent_maxstress',
    item: 'run',
    level: 2,
    result: r.status === 0 ? 'pass' : 'fail',
    ms: 0,
    note: (r.stdout || r.stderr || '').slice(-400),
  });
  if (r.stdout) console.log(r.stdout.slice(-1500));
  if (r.status !== 0 && r.stderr) console.error(r.stderr.slice(-800));
} else {
  console.log('\n=== [1/10] agent-only maxstress SKIP (demo on disk; set MY_AGENT_LAB_SKIP_AGENT=0 to force) ===');
  // Still re-verify gates
  const r = spawnSync(
    process.execPath,
    [path.join(root, 'tools/lab/agent-only-maxstress.mjs')],
    {
      cwd: root,
      env: {
        ...process.env,
        CQR_MAXSTRESS_VERIFY_ONLY: '1',
        CQR_MAXSTRESS_WS: demoWs,
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  allRows.push({
    suite: 'agent_maxstress',
    item: 'verify_only',
    level: 1,
    result: r.status === 0 ? 'pass' : 'fail',
    ms: 0,
    note: `ws=${demoWs}; ${(r.stdout || '').slice(-240)}`,
  });
  console.log(r.stdout?.slice(-800) || r.stderr?.slice(-400));
}

const ws = resolveDemoWs();

// --- 2) Playwright real ---
console.log('\n=== [2/10] Playwright browser real (maxstress DOM) ===');
{
  const { runMaxstressBrowserSurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/maxstress-browser.mjs')).href
  );
  const rows = await runMaxstressBrowserSurface(root, ws);
  allRows.push(...rows);
  console.log(JSON.stringify(summarize(rows)));
}

// --- 3) OpenClaw ---
console.log('\n=== [3/10] OpenClaw config + health ===');
{
  const { runOpenClawSurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/openclaw-surface.mjs')).href
  );
  const rows = await runOpenClawSurface(root);
  allRows.push(...rows);
  console.log(JSON.stringify(rows.map((r) => `${r.item}:${r.result}`)));
}

// --- 4) Market pipeline ---
console.log('\n=== [4/10] Market pipeline capability ===');
{
  const { runMarketPipelineSurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/market-pipeline-surface.mjs')).href
  );
  const rows = await runMarketPipelineSurface(root);
  allRows.push(...rows);
  console.log(JSON.stringify(rows.map((r) => `${r.item}:${r.result}`)));
}

// --- 5) Shell/UI integration ---
console.log('\n=== [5/10] Product UI/shell in-app browser evidence ===');
{
  const { runShellUiIntegrationSurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/shell-ui-surface.mjs')).href
  );
  const rows = runShellUiIntegrationSurface(root);
  allRows.push(...rows);
  console.log(JSON.stringify(rows.map((r) => `${r.item}:${r.result}`)));
}

// --- 6) Embedding quality warm ---
console.log('\n=== [6/10] Embedding/index quality (warm demo) ===');
{
  const { runEmbeddingQualitySurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/embedding-quality.mjs')).href
  );
  const rows = await runEmbeddingQualitySurface(root, ws);
  allRows.push(...rows);
  console.log(JSON.stringify(rows.map((r) => `${r.item}:${r.result}`)));
}

// --- 7) Automaton dry ---
console.log('\n=== [7/10] Automaton dry schema ===');
{
  const { runAutomatonDry } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/automaton-dry.mjs')).href
  );
  const rows = await runAutomatonDry(root);
  allRows.push(...rows);
  console.log(JSON.stringify(summarize(rows)));
}

// --- 8) Embedding cold ---
console.log('\n=== [8/10] Embedding cold zero-hit ===');
{
  const { runEmbeddingCold } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/embedding-cold.mjs')).href
  );
  const rows = await runEmbeddingCold(root, outDir);
  allRows.push(...rows);
  console.log(JSON.stringify(rows.map((r) => `${r.item}:${r.result}`)));
}

// --- 9) Skill quality honesty ---
console.log('\n=== [9/10] Skill quality (routing+inject honesty) ===');
{
  const { runSkillQualitySurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/skill-quality-surface.mjs')).href
  );
  const rows = await runSkillQualitySurface(root);
  allRows.push(...rows);
  console.log(JSON.stringify(summarize(rows)));
}

// --- 10) Pathless greenfield golden ---
console.log('\n=== [10/10] Greenfield pathless fixture (no LLM) ===');
{
  const { runGreenfieldPathlessSurface } = await import(
    pathToFileURL(path.join(root, 'tools/lab/runners/greenfield-pathless.mjs')).href
  );
  const rows = await runGreenfieldPathlessSurface(root);
  allRows.push(...rows);
  console.log(JSON.stringify(rows.map((r) => `${r.item}:${r.result}`)));
}

const summary = summarize(allRows);
const bySuite = {};
for (const r of allRows) {
  bySuite[r.suite] = bySuite[r.suite] || { pass: 0, fail: 0, skip: 0 };
  bySuite[r.suite][r.result === 'pass' ? 'pass' : r.result === 'fail' ? 'fail' : 'skip'] += 1;
}

// Policy: fails break; skips OK unless MY_AGENT_LAB_FULL_FORCE=1 (then skip of required suites fail)
const requiredNoSkip = String(process.env.MY_AGENT_LAB_FULL_FORCE || '').trim() === '1';
let ok = summary.fail === 0;
if (requiredNoSkip) {
  // Browser + agent must pass when force; others may still skip with note
  const browserFail = allRows.some((r) => r.suite === 'browser_real' && r.result !== 'pass');
  const agentFail = allRows.some((r) => r.suite === 'agent_maxstress' && r.result === 'fail');
  if (browserFail || agentFail) ok = false;
}

// Structural: shell_ui must never skip silently when files exist
const shellFails = allRows.filter((r) => r.suite === 'shell_ui' && r.result === 'fail');
if (shellFails.length) ok = false;

const report = {
  ok,
  ms: Date.now() - t0,
  workspace: ws,
  summary,
  bySuite,
  honesty: {
    inject_ne_skill_quality: true,
    openclaw_slash_not_auto: true,
    market_full_research_not_default: true,
    shell_wpf_click_manual: true,
  },
  residual_docs: {
    openclaw: 'tools/lab/OPENCLAW_RUNBOOK.md',
    ops: 'tools/lab/OPS_RESIDUAL_FIXES.md',
  },
  rows: allRows,
  maxstressReport: existsSync(path.join(outDir, 'agent-only-maxstress-report.json'))
    ? JSON.parse(readFileSync(path.join(outDir, 'agent-only-maxstress-report.json'), 'utf8'))
    : null,
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log('\n=== FULL SURFACE SUMMARY ===');
console.log(JSON.stringify({ ok, summary, bySuite, workspace: ws, report: reportPath }, null, 2));
process.exit(ok ? 0 : 1);
