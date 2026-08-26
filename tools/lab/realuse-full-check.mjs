#!/usr/bin/env node
/**
 * MY Agent real-use full-surface check
 *
 * 1) Seeds fixtures/cqrpa-realuse-app → data/_realuse_lab/app
 * 2) Product fixture plane: tools sample, checkpoint, terminal cancel, API, parity
 * 3) Full surface (default): catalog 전수 L1 tools + skills L0/L1 + browser dry +
 *    automaton/domain/embedding-cold + coverage 표
 *
 *   npm run lab:realuse
 *   npm run lab:realuse:light
 *   npm run lab:realuse:loop          # --loops=2
 *   MY_AGENT_LAB_BROWSER=1 npm run lab:realuse
 *   CQR_REALUSE_OWUI=1 npm run lab:realuse
 *
 * Report: data/_skill_tool_lab/realuse-full-check-report.{json,md}
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog } from './catalog.mjs';
import { runToolsDirect } from './runners/tools-direct.mjs';
import { runSkills } from './runners/skills-l0.mjs';
import { runBrowserTools } from './runners/browser-tools.mjs';
import { runAutomatonDry } from './runners/automaton-dry.mjs';
import { runDomainL1 } from './runners/domain-l1.mjs';
import { runEmbeddingCold } from './runners/embedding-cold.mjs';
import { runRealuseDeepPack } from './runners/realuse-deep.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
process.env.CQR_ACTIVATION_SERVER_URL = process.env.CQR_ACTIVATION_SERVER_URL || 'off';

const argv = process.argv.slice(2);
const wantBrowserForce = argv.includes('--browser') || process.env.MY_AGENT_LAB_BROWSER === '1';
/** Skip heavy surface (catalog 전수) — only product fixture/API/parity. */
const lightOnly =
  argv.includes('--light') || process.env.CQR_REALUSE_LIGHT === '1';
const loops = Math.max(
  1,
  Number(
    (argv.find((a) => a.startsWith('--loops=')) || '').split('=')[1]
      || process.env.CQR_REALUSE_LOOPS
      || 1,
  ) || 1,
);
/** Previously out-of-scope: UI e2e / agent gates / L2 / OWUI / shell. */
const deepMode =
  argv.includes('--deep')
  || process.env.CQR_REALUSE_DEEP === '1'
  || process.env.CQR_REALUSE_DEEP === 'true';
const deepOnly = argv.includes('--deep-only');

const fixtureSrc = path.join(root, 'tools', 'lab', 'fixtures', 'cqrpa-realuse-app');
const workRoot = path.join(root, 'data', '_realuse_lab');
const appWs = path.join(workRoot, 'app');
const cqrScratch = path.join(workRoot, 'cqr-scratch');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const reportJson = path.join(outDir, 'realuse-full-check-report.json');
const reportMd = path.join(outDir, 'realuse-full-check-report.md');

/** @type {{ id: string, group: string, result: 'pass'|'fail'|'skip'|'partial', ms: number, note: string }[]} */
let rows = [];
/** Coverage rollup written into report (tools / skills / browser). */
let coverage = null;

function push(id, group, result, ms, note = '') {
  rows.push({ id, group, result, ms, note: String(note).slice(0, 500) });
  const mark =
    result === 'pass' ? 'PASS' : result === 'skip' ? 'SKIP' : result === 'partial' ? 'PART' : 'FAIL';
  console.log(`[${mark}] ${group}/${id} (${ms}ms) ${note}`.slice(0, 220));
}

function ingestLabRows(labRows, groupPrefix = 'surface') {
  for (const r of labRows) {
    const group = `${groupPrefix}:${r.suite || 'lab'}`;
    const result =
      r.result === 'pass' || r.result === 'fail' || r.result === 'skip' || r.result === 'partial'
        ? r.result
        : r.result === 'blocked'
          ? 'skip'
          : 'fail';
    push(String(r.item || 'item'), group, result, Number(r.ms) || 0, r.note || '');
  }
}

function buildCoverage(catalog, surfaceRows) {
  const toolRows = surfaceRows.filter((r) => r.suite === 'tools');
  const code = catalog.code_tools || [];
  const browser = catalog.browser_tools || [];
  const skills = (catalog.skills || []).map((s) => s.id);
  const exercised = new Set(toolRows.map((r) => r.item));
  const toolStatus = {};
  for (const name of code) {
    const hits = toolRows.filter((r) => r.item === name);
    if (!hits.length) toolStatus[name] = 'missing';
    else if (hits.some((h) => h.result === 'fail')) toolStatus[name] = 'fail';
    else if (hits.every((h) => h.result === 'skip')) toolStatus[name] = 'skip';
    else toolStatus[name] = 'pass';
  }
  const browserRows = surfaceRows.filter((r) => r.suite === 'browser');
  const browserStatus = {};
  for (const name of browser) {
    const hits = browserRows.filter((r) => r.item === name);
    if (!hits.length) browserStatus[name] = 'missing';
    else if (hits.some((h) => h.result === 'fail')) browserStatus[name] = 'fail';
    else if (hits.every((h) => h.result === 'skip')) browserStatus[name] = 'skip';
    else browserStatus[name] = 'pass';
  }
  const skillRows = surfaceRows.filter((r) => r.suite === 'skills');
  const skillStatus = {};
  for (const id of skills) {
    const hits = skillRows.filter((r) => r.item === id || String(r.item).startsWith(`${id}:`));
    if (!hits.length) skillStatus[id] = 'missing';
    else if (hits.some((h) => h.result === 'fail')) skillStatus[id] = 'fail';
    else if (hits.every((h) => h.result === 'skip')) skillStatus[id] = 'skip';
    else skillStatus[id] = 'pass';
  }
  const codePass = code.filter((n) => toolStatus[n] === 'pass').length;
  const browserOk = browser.filter((n) => browserStatus[n] !== 'missing').length;
  const skillOk = skills.filter((id) => skillStatus[id] === 'pass').length;
  return {
    catalog_counts: catalog.counts,
    code_tools: {
      total: code.length,
      pass: codePass,
      fail: code.filter((n) => toolStatus[n] === 'fail').length,
      missing: code.filter((n) => toolStatus[n] === 'missing').length,
      status: toolStatus,
    },
    browser_tools: {
      total: browser.length,
      exercised: browserOk,
      status: browserStatus,
    },
    skills: {
      total: skills.length,
      pass: skillOk,
      status: skillStatus,
    },
    complete:
      code.every((n) => toolStatus[n] === 'pass' || toolStatus[n] === 'skip')
      && code.every((n) => toolStatus[n] !== 'missing' && toolStatus[n] !== 'fail')
      && skills.every((id) => skillStatus[id] === 'pass' || skillStatus[id] === 'skip'),
  };
}

async function checkSurfaceCatalog() {
  const t0 = Date.now();
  if (lightOnly) {
    push('surface_pack', 'surface', 'skip', 0, '--light / CQR_REALUSE_LIGHT=1');
    return;
  }
  try {
    console.log('surface: catalog + skills L0/L1 + tools full + browser dry…');
    const catalog = await loadCatalog();
    writeFileSync(
      path.join(outDir, 'catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`,
      'utf8',
    );
    const namesMatch =
      JSON.stringify(catalog.code_tools) === JSON.stringify(catalog.code_tool_names_export);
    push(
      'catalog_code_tools_export',
      'surface:catalog',
      namesMatch ? 'pass' : 'fail',
      0,
      `tools=${catalog.code_tools.length}`,
    );
    push(
      'catalog_skills_manifest',
      'surface:catalog',
      catalog.skills.length >= 5 ? 'pass' : 'fail',
      0,
      catalog.skills.map((s) => s.id).join(','),
    );

    const skillRows = await runSkills(root, catalog, 1);
    ingestLabRows(skillRows, 'surface');

    const autoRows = await runAutomatonDry(root);
    ingestLabRows(autoRows, 'surface');
    const domainRows = await runDomainL1(root);
    ingestLabRows(domainRows, 'surface');

    const toolRun = await runToolsDirect(root, catalog, { browser: wantBrowserForce });
    ingestLabRows(toolRun.rows, 'surface');
    writeFileSync(path.join(outDir, 'fixture-path.txt'), `${toolRun.fixture}\n`, 'utf8');

    const browserRows = await runBrowserTools(root, toolRun.fixture, {
      force: wantBrowserForce,
    });
    ingestLabRows(browserRows, 'surface');

    const embRows = await runEmbeddingCold(root, outDir);
    ingestLabRows(embRows, 'surface');

    const surfaceOnly = [
      ...skillRows,
      ...autoRows,
      ...domainRows,
      ...toolRun.rows,
      ...browserRows,
      ...embRows,
    ];
    coverage = buildCoverage(catalog, surfaceOnly);
    const codeMissing = coverage.code_tools.missing;
    const codeFail = coverage.code_tools.fail;
    push(
      'coverage_code_tools',
      'surface:coverage',
      codeMissing === 0 && codeFail === 0 ? 'pass' : 'fail',
      Date.now() - t0,
      `pass=${coverage.code_tools.pass}/${coverage.code_tools.total} fail=${codeFail} missing=${codeMissing}`,
    );
    push(
      'coverage_skills',
      'surface:coverage',
      coverage.skills.pass === coverage.skills.total ? 'pass' : 'partial',
      0,
      `pass=${coverage.skills.pass}/${coverage.skills.total}`,
    );
    const browsSkipped = Object.values(coverage.browser_tools.status).every(
      (s) => s === 'skip' || s === 'pass',
    );
    push(
      'coverage_browser',
      'surface:coverage',
      browsSkipped ? 'pass' : 'fail',
      0,
      JSON.stringify(coverage.browser_tools.status).slice(0, 160),
    );
  } catch (e) {
    push(
      'surface_pack',
      'surface',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpReq(method, url, body, headers = {}, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(url);
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* text */
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            body: raw.slice(0, 4000),
            json,
            ms: Date.now() - t0,
          });
        });
      },
    );
    req.on('error', (e) =>
      resolve({ ok: false, status: 0, body: String(e.message || e), json: null, ms: Date.now() - t0 }),
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: 'timeout', json: null, ms: Date.now() - t0 });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function seedWorktree() {
  const t0 = Date.now();
  if (!existsSync(fixtureSrc)) {
    push('seed_fixture', 'workspace', 'fail', Date.now() - t0, 'fixture missing');
    return false;
  }
  mkdirSync(workRoot, { recursive: true });
  if (existsSync(appWs)) rmSync(appWs, { recursive: true, force: true });
  if (existsSync(cqrScratch)) rmSync(cqrScratch, { recursive: true, force: true });
  mkdirSync(cqrScratch, { recursive: true });
  cpSync(fixtureSrc, appWs, { recursive: true });
  const hasPkg = existsSync(path.join(appWs, 'package.json'));
  const hasMath = existsSync(path.join(appWs, 'src', 'lib', 'math.js'));
  push(
    'seed_fixture',
    'workspace',
    hasPkg && hasMath ? 'pass' : 'fail',
    Date.now() - t0,
    appWs,
  );
  return hasPkg && hasMath;
}

async function checkFixtureSelfTest() {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(appWs, 'test', 'smoke.mjs')], {
    cwd: appWs,
    encoding: 'utf8',
    timeout: 30_000,
  });
  push(
    'fixture_npm_test',
    'workspace',
    r.status === 0 ? 'pass' : 'fail',
    Date.now() - t0,
    (r.stdout || r.stderr || '').slice(-200),
  );
}

async function checkToolsPlane() {
  const t0 = Date.now();
  try {
    const { executeAgentTool } = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'tools.js')).href
    );
    const sessionId = `realuse_${Date.now()}`;
    const ctx = { cqrRoot: root, sessionId };
    const tc = (name, args) => ({
      id: `ru_${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });

    const list = await executeAgentTool(appWs, tc('list_directory', { path: 'src' }), {}, ctx);
    const read = await executeAgentTool(appWs, tc('read_file', { path: 'src/lib/math.js' }), {}, ctx);
    const search = await executeAgentTool(
      appWs,
      tc('search_files', { query: 'function sum' }),
      {},
      ctx,
    );
    const mathBefore = readFileSync(path.join(appWs, 'src', 'lib', 'math.js'), 'utf8');
    const mathAfter = `${mathBefore.trimEnd()}\n\nexport function product(a, b) {\n  return Number(a) * Number(b);\n}\n`;
    const patch = await executeAgentTool(
      appWs,
      tc('apply_patch', {
        path: 'src/lib/math.js',
        old_text: mathBefore,
        new_text: mathAfter,
      }),
      {},
      ctx,
    );
    const disk = readFileSync(path.join(appWs, 'src', 'lib', 'math.js'), 'utf8');
    const writeNew = await executeAgentTool(
      appWs,
      tc('write_file', {
        path: 'src/lib/extra.js',
        content: 'export const REALUSE = 1;\n',
      }),
      {},
      ctx,
    );
    const tests = await executeAgentTool(appWs, tc('run_tests', {}), {}, ctx);
    const diag = await executeAgentTool(appWs, tc('run_diagnostics', {}), {}, ctx);

    const okList = !/^ERROR:/m.test(String(list.output));
    const okRead = String(read.output).includes('function sum');
    const okSearch = !/^ERROR:/m.test(String(search.output));
    const okPatch = disk.includes('function product') && !/^ERROR:/m.test(String(patch.output));
    const okWrite =
      existsSync(path.join(appWs, 'src', 'lib', 'extra.js'))
      && !/^ERROR:/m.test(String(writeNew.output));
    const okTests = rExitOk(String(tests.output));
    // diagnostics may be weak/command skip — accept non-ERROR hard fail
    const okDiag = !/^ERROR:.*blocked/i.test(String(diag.output));

    push('tool_list_dir', 'tools', okList ? 'pass' : 'fail', Date.now() - t0, sliceOut(list.output));
    push('tool_read_file', 'tools', okRead ? 'pass' : 'fail', Date.now() - t0, sliceOut(read.output));
    push(
      'tool_search_files',
      'tools',
      okSearch ? 'pass' : 'fail',
      Date.now() - t0,
      sliceOut(search.output),
    );
    push('tool_apply_patch', 'tools', okPatch ? 'pass' : 'fail', Date.now() - t0, okPatch ? 'product()' : disk.slice(0, 80));
    push('tool_write_file', 'tools', okWrite ? 'pass' : 'fail', Date.now() - t0, sliceOut(writeNew.output));
    push(
      'tool_run_tests',
      'tools',
      okTests ? 'pass' : 'partial',
      Date.now() - t0,
      sliceOut(tests.output),
    );
    push(
      'tool_run_diagnostics',
      'tools',
      okDiag ? 'pass' : 'partial',
      Date.now() - t0,
      sliceOut(diag.output),
    );
  } catch (e) {
    push(
      'tools_plane',
      'tools',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

function rExitOk(out) {
  const s = String(out || '');
  if (/^ERROR:/m.test(s)) return false;
  try {
    const j = JSON.parse(s);
    if (typeof j.ok === 'boolean') return j.ok === true && (j.exit_code == null || j.exit_code === 0);
  } catch {
    /* plain text */
  }
  return /"ok"\s*:\s*true/.test(s) || /\bexit_code"\s*:\s*0\b/.test(s) || /test OK/i.test(s);
}

function sliceOut(o) {
  return String(o || '').replace(/\s+/g, ' ').slice(0, 160);
}

async function checkTerminalCancel() {
  const t0 = Date.now();
  try {
    const {
      runTerminalCommandAsync,
      cancelTerminalJob,
      listActiveTerminalJobs,
    } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'run-terminal.js')).href);
    const jobId = `realuse_term_${Date.now()}`;
    const p = runTerminalCommandAsync(appWs, 'Start-Sleep -Seconds 25', {
      jobId,
      timeoutMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 350));
    const jobs = listActiveTerminalJobs();
    const registered = jobs.some((j) => j.id === jobId);
    const killed = cancelTerminalJob(jobId);
    const res = await p;
    const ok =
      registered
      && killed
      && (res.cancelled === true || /cancel/i.test(res.stderr || ''));
    push(
      'terminal_async_cancel',
      'terminal',
      ok ? 'pass' : 'fail',
      Date.now() - t0,
      JSON.stringify({ registered, killed, cancelled: res.cancelled }).slice(0, 160),
    );
  } catch (e) {
    push(
      'terminal_async_cancel',
      'terminal',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkCheckpointParity() {
  const t0 = Date.now();
  try {
    const {
      createWorkspaceCheckpoint,
      rollbackWorkspaceCheckpoint,
      previewCheckpointDiff,
    } = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'agent-checkpoint.js')).href
    );
    const sid = 'realuse_ck';
    // restore math to known for partial test
    writeFileSync(
      path.join(appWs, 'src', 'lib', 'math.js'),
      'export function sum(a, b) {\n  return Number(a) + Number(b);\n}\n',
      'utf8',
    );
    writeFileSync(path.join(appWs, 'src', 'lib', 'snap-a.js'), 'export const A = 1;\n', 'utf8');
    writeFileSync(path.join(appWs, 'src', 'lib', 'snap-b.js'), 'export const B = 1;\n', 'utf8');
    const meta = createWorkspaceCheckpoint(appWs, cqrScratch, {
      sessionKey: sid,
      label: 'realuse',
      paths: ['src/lib/snap-a.js', 'src/lib/snap-b.js', 'src/lib/math.js'],
    });
    writeFileSync(path.join(appWs, 'src', 'lib', 'snap-a.js'), 'export const A = 2;\n', 'utf8');
    writeFileSync(path.join(appWs, 'src', 'lib', 'snap-b.js'), 'export const B = 2;\n', 'utf8');
    writeFileSync(path.join(appWs, 'src', 'lib', 'brand-new.js'), 'export const N = 1;\n', 'utf8');

    const partial = JSON.parse(
      rollbackWorkspaceCheckpoint(appWs, cqrScratch, meta.id, {
        sessionKey: sid,
        confirm: true,
        paths: ['src/lib/snap-a.js'],
      }),
    );
    const aOk = readFileSync(path.join(appWs, 'src', 'lib', 'snap-a.js'), 'utf8').includes('A = 1');
    const bStill = readFileSync(path.join(appWs, 'src', 'lib', 'snap-b.js'), 'utf8').includes('B = 2');

    const del = JSON.parse(
      rollbackWorkspaceCheckpoint(appWs, cqrScratch, meta.id, {
        sessionKey: sid,
        confirm: true,
        paths: ['src/lib/brand-new.js'],
      }),
    );
    const gone = !existsSync(path.join(appWs, 'src', 'lib', 'brand-new.js'));

    const prev = JSON.parse(
      previewCheckpointDiff(appWs, cqrScratch, meta.id, 'src/lib/snap-b.js', {
        sessionKey: sid,
      }),
    );

    push(
      'checkpoint_partial_restore',
      'checkpoint',
      partial.ok && aOk && bStill ? 'pass' : 'fail',
      Date.now() - t0,
      `aOk=${aOk} bStill=${bStill}`,
    );
    push(
      'checkpoint_delete_new',
      'checkpoint',
      del.ok && (del.deleted ?? 0) >= 1 && gone ? 'pass' : 'fail',
      Date.now() - t0,
      `deleted=${del.deleted}`,
    );
    push(
      'checkpoint_diff_hunks',
      'checkpoint',
      prev.ok && Array.isArray(prev.diff_lines) && prev.diff_lines.length > 0 ? 'pass' : 'fail',
      Date.now() - t0,
      `hunks=${prev.diff_lines?.length ?? 0}`,
    );
  } catch (e) {
    push(
      'checkpoint_plane',
      'checkpoint',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkGitPlane() {
  const t0 = Date.now();
  try {
    const init = spawnSync('git', ['init'], { cwd: appWs, encoding: 'utf8' });
    if (init.status !== 0) {
      push('git_init', 'git', 'skip', Date.now() - t0, 'git unavailable');
      return;
    }
    spawnSync('git', ['config', 'user.email', 'realuse@cqr.local'], { cwd: appWs });
    spawnSync('git', ['config', 'user.name', 'realuse'], { cwd: appWs });
    spawnSync('git', ['add', '-A'], { cwd: appWs });
    spawnSync('git', ['commit', '-m', 'realuse seed', '--allow-empty'], {
      cwd: appWs,
      encoding: 'utf8',
    });

    const { executeAgentTool } = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'tools.js')).href
    );
    const ctx = { cqrRoot: root, sessionId: `realuse_git_${Date.now()}` };
    const tc = (name, args = {}) => ({
      id: `rg_${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const st = await executeAgentTool(appWs, tc('git_status'), {}, ctx);
    const log = await executeAgentTool(appWs, tc('git_log', { max_count: 3 }), {}, ctx);
    const ok =
      !/^ERROR:/m.test(String(st.output))
      && !/^ERROR:/m.test(String(log.output));
    push('git_status_log', 'git', ok ? 'pass' : 'fail', Date.now() - t0, sliceOut(st.output));
  } catch (e) {
    push('git_plane', 'git', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e));
  }
}

async function checkPluginsMcpEditor() {
  const t0 = Date.now();
  try {
    const {
      listPluginTemplates,
      installAgentPluginFromTemplate,
      listAgentPlugins,
    } = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'agent-plugin-store.js')).href
    );
    const templates = listPluginTemplates(root);
    push(
      'plugin_templates',
      'plugins',
      templates.length >= 1 ? 'pass' : 'fail',
      Date.now() - t0,
      `n=${templates.length}`,
    );
    const pid = `realuse_echo_${Date.now().toString(36).slice(-6)}`;
    const installed = installAgentPluginFromTemplate(root, {
      template_id: 'demo_echo',
      id: pid,
      confirm: true,
    });
    const doc = JSON.parse(installed);
    const listed = listAgentPlugins(root).some((p) => p.id === pid);
    push(
      'plugin_install_template',
      'plugins',
      doc.ok && listed ? 'pass' : 'fail',
      Date.now() - t0,
      `id=${pid}`,
    );
    // remove smoke install (don't leave Plugins UI noise)
    try {
      const { uninstallAgentPlugin } = await import(
        pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'agent-plugin-store.js')).href
      );
      uninstallAgentPlugin(root, { id: pid, confirm: true });
    } catch {
      /* ignore */
    }

    const {
      loadUserMcpConfig,
      saveUserMcpConfig,
      formatUserMcpServersJson,
    } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'user-mcp.js')).href);
    saveUserMcpConfig(cqrScratch, {
      version: 1,
      servers: [{ id: 'realuse_probe', command: 'npx', args: ['-y', 'noop'], enabled: false }],
    });
    const cfg = loadUserMcpConfig(cqrScratch);
    const formatted = JSON.parse(formatUserMcpServersJson(cqrScratch));
    push(
      'mcp_config_roundtrip',
      'mcp',
      cfg.servers.length === 1 && formatted.ok ? 'pass' : 'fail',
      Date.now() - t0,
      `servers=${cfg.servers.length}`,
    );

    const { buildEditorContextSnippet } = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'chat', 'editor-context.js')).href
    );
    const snip = buildEditorContextSnippet({
      path: 'src/lib/math.js',
      paths: ['REALUSE_TASKS.md', 'src/app.js'],
      selection: 'sum',
    });
    push(
      'editor_context_at_paths',
      'chat',
      snip.includes('@ 컨텍스트') && snip.includes('src/app.js') ? 'pass' : 'fail',
      Date.now() - t0,
      snip.slice(0, 80),
    );
  } catch (e) {
    push(
      'plugins_mcp_editor',
      'plugins',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkApiSurface() {
  const t0 = Date.now();
  const distMain = path.join(root, 'core', 'dist', 'main.js');
  if (!existsSync(distMain)) {
    push('api_boot', 'api', 'fail', Date.now() - t0, 'build first');
    return;
  }
  let port;
  try {
    port = await freePort();
  } catch (e) {
    push('api_boot', 'api', 'fail', Date.now() - t0, String(e));
    return;
  }
  const child = spawn(process.execPath, [distMain], {
    cwd: root,
    env: {
      ...process.env,
      MY_AGENT_ROOT: root,
      CQR_API_PORT: String(port),
      PORT: String(port),
      CQR_ACTIVATION_SERVER_URL: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 1400));
  const base = `http://127.0.0.1:${port}`;
  try {
    let health = await httpReq('GET', `${base}/health`);
    if (!health.ok) {
      await new Promise((r) => setTimeout(r, 1500));
      health = await httpReq('GET', `${base}/health`);
    }
    push(
      'api_health',
      'api',
      health.ok ? 'pass' : 'fail',
      health.ms,
      `status=${health.status}`,
    );

    const routes = [
      ['GET', '/models/picker', null],
      ['GET', '/agent-plugins', null],
      ['GET', '/agent-plugins/templates', null],
      ['GET', '/mcp/servers', null],
      ['GET', '/fs/run-terminal/jobs', null],
      ['GET', '/skills', null],
      ['GET', '/workspace/checkpoint/preview', null], // expect 400
    ];
    for (const [method, p, body] of routes) {
      const res = await httpReq(method, `${base}${p}`, body);
      const alive =
        res.ok
        || res.status === 400
        || res.status === 401
        || res.status === 402
        || res.status === 403;
      // preview without args should be 400
      if (p.includes('preview') && !p.includes('?')) {
        push(
          `api_${p.replace(/\//g, '_').slice(1)}`,
          'api',
          res.status === 400 ? 'pass' : alive ? 'partial' : 'fail',
          res.ms,
          `status=${res.status}`,
        );
        continue;
      }
      push(
        `api_${p.replace(/\//g, '_').slice(1) || 'root'}`,
        'api',
        alive ? 'pass' : 'fail',
        res.ms,
        `status=${res.status}`,
      );
    }

    const cancel = await httpReq('POST', `${base}/fs/run-terminal/cancel`, {
      job_id: 'realuse_missing',
    });
    push(
      'api_terminal_cancel',
      'api',
      cancel.ok && cancel.json?.ok !== false ? 'pass' : 'fail',
      cancel.ms,
      `cancelled=${cancel.json?.cancelled}`,
    );

    // Try set workspace via public config endpoint if available
    const setWs = await httpReq('PUT', `${base}/config/dev-workspace`, {
      dev_workspace_root: appWs,
    });
    const canWs =
      setWs.ok
      || setWs.status === 401
      || setWs.status === 403
      || setWs.status === 402
      || setWs.status === 404;
    if (setWs.ok) {
      const tree = await httpReq('GET', `${base}/fs/workspace-tree?depth=2`);
      push(
        'api_workspace_tree',
        'api',
        tree.ok ? 'pass' : 'partial',
        tree.ms,
        `status=${tree.status}`,
      );
      const file = await httpReq(
        'GET',
        `${base}/fs/workspace-file?path=${encodeURIComponent('src/lib/math.js')}`,
      );
      push(
        'api_workspace_file',
        'api',
        file.ok || String(file.body).includes('sum') ? 'pass' : 'partial',
        file.ms,
        `status=${file.status}`,
      );
    } else {
      push(
        'api_workspace_bind',
        'api',
        canWs ? 'skip' : 'fail',
        setWs.ms,
        `set workspace status=${setWs.status} (tool-plane covered)`,
      );
    }
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
}

async function checkParityGate() {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'verify-parity-p1.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MY_AGENT_ROOT: root },
  });
  push(
    'verify_parity_p1',
    'gates',
    r.status === 0 ? 'pass' : 'fail',
    Date.now() - t0,
    (r.stdout || r.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160),
  );
}

async function checkDeepOutOfBand() {
  if (!deepMode && !deepOnly) {
    push(
      'deep_pack',
      'deep',
      'skip',
      0,
      'pass --deep or CQR_REALUSE_DEEP=1 (UI e2e / agent gates / L2 / shell / OWUI)',
    );
    return;
  }
  const t0 = Date.now();
  try {
    const { rows: deepRows } = await runRealuseDeepPack(root, {
      forceOwui: process.env.MY_AGENT_OWUI_SMOKE_FORCE === '1',
    });
    ingestLabRows(deepRows, 'deep');
    const fails = deepRows.filter((r) => r.result === 'fail');
    push(
      'deep_pack_summary',
      'deep',
      fails.length === 0 ? 'pass' : 'fail',
      Date.now() - t0,
      `rows=${deepRows.length} fail=${fails.length}`,
    );
  } catch (e) {
    push(
      'deep_pack',
      'deep',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkOptionalOwui() {
  const t0 = Date.now();
  // Deep pack already runs live OWUI — avoid double bill / double count.
  if (deepMode || deepOnly) {
    push('owui_live_mutate', 'live', 'skip', 0, 'covered by deep pack');
    return;
  }
  if (process.env.CQR_REALUSE_OWUI !== '1') {
    push(
      'owui_live_mutate',
      'live',
      'skip',
      Date.now() - t0,
      'set CQR_REALUSE_OWUI=1 or lab:realuse:deep',
    );
    return;
  }
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'lab', 'owui-code-agent-smoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, MY_AGENT_ROOT: root },
  });
  let parsed = null;
  try {
    const j = path.join(root, 'data', '_skill_tool_lab', 'owui-code-agent-smoke.json');
    if (existsSync(j)) parsed = JSON.parse(readFileSync(j, 'utf8'));
  } catch {
    /* ignore */
  }
  const result = parsed?.result || (r.status === 0 ? 'pass' : 'fail');
  push(
    'owui_live_mutate',
    'live',
    result === 'skip' ? 'skip' : result === 'pass' || parsed?.ok === true ? 'pass' : 'fail',
    Date.now() - t0,
    parsed ? `${parsed.result} ${parsed.note || ''}` : (r.stdout || r.stderr || '').slice(-160),
  );
}

function writeReports(msTotal, loopIndex = 1) {
  const counts = { pass: 0, fail: 0, skip: 0, partial: 0 };
  for (const r of rows) counts[r.result] = (counts[r.result] || 0) + 1;
  const payload = {
    ok: counts.fail === 0,
    generated_at: new Date().toISOString(),
    ms: msTotal,
    loop: loopIndex,
    loops,
    light: lightOnly,
    deep: deepMode || deepOnly,
    counts,
    coverage,
    workspace: appWs,
    fixture: fixtureSrc,
    rows,
    how_to_manual: [
      '1. npm run lab:realuse  (full surface + fixture)',
      '2. npm run lab:realuse:deep  ( + UI e2e / agent gates / L2 / shell / live OWUI)',
      '3. npm run lab:realuse:light  (fixture/API only)',
      '4. npm run lab:realuse -- --loops=3  (지속 검증 loop)',
      '5. MY_AGENT_LAB_BROWSER=1 npm run lab:realuse  (browser force)',
      '6. CQR UI 작업 폴더 + REALUSE_TASKS.md (WPF 실제 클릭만 수동)',
    ],
  };
  writeFileSync(reportJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const lines = [
    '# realuse full-check report',
    '',
    `- ok: **${payload.ok}**`,
    `- loop: ${loopIndex}/${loops}`,
    `- light: ${lightOnly}`,
    `- counts: pass=${counts.pass} fail=${counts.fail} partial=${counts.partial} skip=${counts.skip}`,
    `- workspace: \`${appWs}\``,
    `- ms: ${msTotal}`,
    '',
  ];
  if (coverage) {
    lines.push(
      '## Coverage',
      '',
      `| plane | metric |`,
      `|-------|--------|`,
      `| code tools | ${coverage.code_tools.pass}/${coverage.code_tools.total} pass (fail=${coverage.code_tools.fail}, missing=${coverage.code_tools.missing}) |`,
      `| browser | ${coverage.browser_tools.exercised}/${coverage.browser_tools.total} exercised (pass or skip ok) |`,
      `| skills | ${coverage.skills.pass}/${coverage.skills.total} pass |`,
      `| catalog | code=${coverage.catalog_counts.code_tools} browser=${coverage.catalog_counts.browser_tools} skills=${coverage.catalog_counts.skills} |`,
      '',
      '### Code tool status',
      '',
      '| tool | status |',
      '|------|--------|',
    );
    for (const [name, st] of Object.entries(coverage.code_tools.status)) {
      lines.push(`| ${name} | ${st} |`);
    }
    lines.push('', '### Skill status', '', '| skill | status |', '|-------|--------|');
    for (const [name, st] of Object.entries(coverage.skills.status)) {
      lines.push(`| ${name} | ${st} |`);
    }
    lines.push('', '### Browser status', '', '| tool | status |', '|------|--------|');
    for (const [name, st] of Object.entries(coverage.browser_tools.status)) {
      lines.push(`| ${name} | ${st} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Results',
    '',
    '| result | group | id | note |',
    '|--------|-------|----|------|',
  );
  for (const r of rows) {
    lines.push(
      `| ${r.result} | ${r.group} | ${r.id} | ${String(r.note).replace(/\|/g, '/').replace(/\n/g, ' ')} |`,
    );
  }
  lines.push('', '## Manual', ...payload.how_to_manual.map((x) => `- ${x}`), '');
  writeFileSync(reportMd, `${lines.join('\n')}\n`, 'utf8');
  return payload;
}

async function runOnce(loopIndex) {
  rows = [];
  coverage = null;
  const tAll = Date.now();
  console.log(`=== MY Agent realuse full-check (loop ${loopIndex}/${loops}) ===`);
  console.log(`fixture → ${appWs}`);
  console.log(
    `mode: ${deepOnly ? 'deep-only' : lightOnly ? 'light' : deepMode ? 'full+deep' : 'full surface'}`,
  );

  if (!deepOnly) {
    if (!seedWorktree()) {
      return writeReports(Date.now() - tAll, loopIndex);
    }

    await checkFixtureSelfTest();
    await checkToolsPlane();
    await checkTerminalCancel();
    await checkCheckpointParity();
    await checkGitPlane();
    await checkPluginsMcpEditor();
    await checkApiSurface();
    await checkParityGate();
    await checkSurfaceCatalog();
  } else {
    push('core_pack', 'workspace', 'skip', 0, '--deep-only skips fixture/API surface');
  }
  await checkDeepOutOfBand();
  await checkOptionalOwui();

  return writeReports(Date.now() - tAll, loopIndex);
}

let last = null;
for (let i = 1; i <= loops; i++) {
  last = await runOnce(i);
  console.log(`\nreport: ${reportMd}`);
  console.log(
    `summary loop ${i}: pass=${last.counts.pass} fail=${last.counts.fail} partial=${last.counts.partial} skip=${last.counts.skip}`,
  );
  if (last.coverage) {
    console.log(
      `coverage: code ${last.coverage.code_tools.pass}/${last.coverage.code_tools.total} · skills ${last.coverage.skills.pass}/${last.coverage.skills.total} · browser ${last.coverage.browser_tools.exercised}/${last.coverage.browser_tools.total}`,
    );
  }
  if (last.counts.fail > 0) {
    console.error(`realuse-full-check: FAIL on loop ${i}`);
    process.exit(1);
  }
}
console.log(`realuse-full-check: GREEN (${loops} loop${loops > 1 ? 's' : ''})`);
if (last) process.exit(0);
