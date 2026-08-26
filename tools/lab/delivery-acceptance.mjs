#!/usr/bin/env node
/**
 * MY Agent delivery acceptance (납기 검수)
 *
 * Receiver-side checklist with disk/run evidence — not marketing claims.
 * Builds/uses:
 * - skill-tool-lab strict
 * - harness/domain/embedding/goldens
 * - delta zip inventory (no full install required)
 * - local API /health smoke (ephemeral port)
 * - isolated fixture: write→read→patch via executeAgentTool
 *
 * Usage:
 *   node tools/lab/delivery-acceptance.mjs
 *   node tools/lab/delivery-acceptance.mjs --full-agent   # also run verify:agent (longer)
 *
 * Report: data/_skill_tool_lab/delivery-acceptance-report.{json,md}
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
process.env.CQR_ACTIVATION_SERVER_URL = process.env.CQR_ACTIVATION_SERVER_URL || 'off';

const fullAgent = process.argv.includes('--full-agent');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });

/** @type {{ id: string, group: string, result: 'pass'|'fail'|'skip'|'partial', ms: number, note: string }[]} */
const rows = [];

function push(id, group, result, ms, note = '') {
  rows.push({ id, group, result, ms, note: String(note).slice(0, 400) });
  const mark = result === 'pass' ? 'PASS' : result === 'skip' ? 'SKIP' : result === 'partial' ? 'PART' : 'FAIL';
  console.log(`[${mark}] ${group}/${id} (${ms}ms) ${note}`.slice(0, 200));
}

function runNode(script, args = [], timeoutMs = 300_000) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'tools', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, MY_AGENT_ROOT: root, CQR_ACTIVATION_SERVER_URL: 'off' },
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    ms: Date.now() - t0,
    out: `${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(-600),
  };
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

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          body: body.slice(0, 2000),
          ms: Date.now() - t0,
        });
      });
    });
    req.on('error', (e) =>
      resolve({ ok: false, status: 0, body: String(e.message || e), ms: Date.now() - t0 }),
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: 'timeout', ms: Date.now() - t0 });
    });
  });
}

async function checkDeltaZip() {
  const t0 = Date.now();
  const ptr = path.join(root, 'deploy', 'output', 'LATEST_DELTA_ZIP.txt');
  if (!existsSync(ptr)) {
    push('delta_pointer', 'deploy', 'fail', Date.now() - t0, 'LATEST_DELTA_ZIP.txt missing');
    return;
  }
  const zip = readFileSync(ptr, 'utf8').trim();
  if (!existsSync(zip)) {
    push('delta_zip', 'deploy', 'fail', Date.now() - t0, `missing ${zip}`);
    return;
  }
  const sz = statSync(zip).size;
  if (sz < 100_000) {
    push('delta_zip', 'deploy', 'fail', Date.now() - t0, `too small ${sz}`);
    return;
  }
  push('delta_zip', 'deploy', 'pass', Date.now() - t0, `${path.basename(zip)} ${(sz / 1e6).toFixed(2)}MB`);

  const list = spawnSync('tar', ['-tf', zip], { encoding: 'utf8', maxBuffer: 20e6 });
  if (list.status !== 0) {
    push('delta_manifest', 'deploy', 'partial', Date.now() - t0, 'tar list failed');
    return;
  }
  const names = list.stdout.replace(/\\/g, '/');
  const need = [
    'core/dist/main.js',
    'ui/workspace/dist/index.html',
    'tools/update/apply-delta.ps1',
    'UPDATE.bat',
    'manifest.json',
    'MYAgent.exe',
    'bin/cqr-pa/cqr-pa.exe',
  ];
  const missing = need.filter((n) => !names.includes(n));
  push(
    'delta_contents',
    'deploy',
    missing.length ? 'fail' : 'pass',
    Date.now() - t0,
    missing.length ? `missing ${missing.join(',')}` : 'required paths present',
  );
}

async function checkToolMutation() {
  const t0 = Date.now();
  const fixture = path.join(outDir, 'accept-fixture');
  if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
  mkdirSync(path.join(fixture, 'src'), { recursive: true });
  writeFileSync(
    path.join(fixture, 'src', 'app.js'),
    "export function greet() { return 'hi'; }\n",
    'utf8',
  );

  try {
    const { executeAgentTool } = await import(
      pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
    );
    const tc = (name, args) => ({
      id: `acc_${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const ctx = { cqrRoot: root, sessionId: `accept_${Date.now()}` };
    const read1 = await executeAgentTool(
      fixture,
      tc('read_file', { path: 'src/app.js' }),
      {},
      ctx,
    );
    const patch = await executeAgentTool(
      fixture,
      tc('apply_patch', {
        path: 'src/app.js',
        old_text: "return 'hi';",
        new_text: "return 'ok';",
      }),
      {},
      ctx,
    );
    const read2 = await executeAgentTool(
      fixture,
      tc('read_file', { path: 'src/app.js' }),
      {},
      ctx,
    );
    const disk = readFileSync(path.join(fixture, 'src', 'app.js'), 'utf8');
    const ok =
      !/^ERROR:/m.test(String(read1.output))
      && !/^ERROR:/m.test(String(patch.output))
      && disk.includes("return 'ok'")
      && String(read2.output).includes("return 'ok'");
    push(
      'tool_mutate_roundtrip',
      'runtime',
      ok ? 'pass' : 'fail',
      Date.now() - t0,
      ok ? 'read→apply_patch→disk' : disk.slice(0, 120),
    );
  } catch (e) {
    push(
      'tool_mutate_roundtrip',
      'runtime',
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkApiHealth() {
  const t0 = Date.now();
  const distMain = path.join(root, 'core', 'dist', 'main.js');
  if (!existsSync(distMain)) {
    push('api_health', 'runtime', 'fail', Date.now() - t0, 'core/dist/main.js missing — build first');
    return;
  }

  let port;
  try {
    port = await freePort();
  } catch (e) {
    push('api_health', 'runtime', 'fail', Date.now() - t0, String(e));
    return;
  }

  const child = spawn(process.execPath, [distMain], {
    cwd: root,
    env: {
      ...process.env,
      MY_AGENT_ROOT: root,
      CQR_API_PORT: String(port),
      CQR_ACTIVATION_SERVER_URL: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let bootLog = '';
  child.stdout?.on('data', (d) => {
    bootLog += d.toString();
  });
  child.stderr?.on('data', (d) => {
    bootLog += d.toString();
  });

  // Wait for listen (bounded)
  await new Promise((r) => setTimeout(r, 1200));
  let health = await httpGet(`http://127.0.0.1:${port}/health`);
  if (!health.ok) {
    await new Promise((r) => setTimeout(r, 1500));
    health = await httpGet(`http://127.0.0.1:${port}/health`);
  }

  let skills = await httpGet(`http://127.0.0.1:${port}/skills`);
  // license may block — accept 200 or 401/403 as "route alive"
  const skillsAlive =
    skills.ok || skills.status === 401 || skills.status === 403 || skills.status === 402;

  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  // Windows
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }

  if (!health.ok) {
    push(
      'api_health',
      'runtime',
      'fail',
      Date.now() - t0,
      `GET /health failed ${health.status} ${health.body.slice(0, 100)} | boot=${bootLog.slice(-200)}`,
    );
    return;
  }
  push('api_health', 'runtime', 'pass', Date.now() - t0, `port=${port} health ${health.status}`);
  push(
    'api_skills_route',
    'runtime',
    skillsAlive ? 'pass' : 'partial',
    Date.now() - t0,
    `GET /skills status=${skills.status}`,
  );
}

function checkProductLayout() {
  const t0 = Date.now();
  const must = [
    'ui/workspace/dist/index.html',
    'core/dist/main.js',
    'core/src/routes/dispatch.ts',
    'shell/CqrPa.Shell/CqrPa.Shell.csproj',
    'AGENTS.md',
    'tools/lab/skill-tool-lab.mjs',
  ];
  const missing = must.filter((p) => !existsSync(path.join(root, p)));
  push(
    'layout_artifacts',
    'product',
    missing.length ? 'fail' : 'pass',
    Date.now() - t0,
    missing.length ? missing.join(',') : 'single UI + core + shell present',
  );

  // No legacy UI
  const legacy = existsSync(path.join(root, 'ui', 'web'));
  push(
    'no_legacy_ui_web',
    'product',
    legacy ? 'fail' : 'pass',
    Date.now() - t0,
    legacy ? 'ui/web still present' : 'ui/web removed',
  );
}

async function main() {
  console.log('=== MY Agent delivery acceptance ===\n');
  const started = new Date().toISOString();

  // Build once
  {
    const r = runNode('build.mjs', [], 180_000);
    push('build', 'product', r.ok ? 'pass' : 'fail', r.ms, r.ok ? 'core+workspace' : r.out.slice(-200));
    if (!r.ok) {
      // continue for partial report but API/tool will fail
    }
  }

  checkProductLayout();
  await checkDeltaZip();

  // Static / offline suite
  const suite = [
    { script: 'verify-delta-apply.mjs', id: 'delta_apply_script' },
    { script: 'verify-harness-goldens.mjs', id: 'harness_goldens' },
    { script: 'verify-embedding-cold.mjs', id: 'embedding_cold' },
    { script: 'verify-skills.mjs', id: 'skills' },
    { script: 'verify-domain-registry.mjs', id: 'domain_registry' },
    { script: 'verify-tool-facade.mjs', id: 'tool_facade' },
    { script: 'verify-multi-agent.mjs', id: 'multi_agent' },
    { script: 'verify-agent-outcome-gate.mjs', id: 'outcome_gate' },
    { script: 'verify-work-mode-loop.mjs', id: 'work_mode' },
    { script: 'verify-failure-plane.mjs', id: 'failure_plane' },
  ];

  for (const { script, id } of suite) {
    const r = runNode(script);
    push(id, 'suite', r.ok ? 'pass' : 'fail', r.ms, r.ok ? 'exit 0' : r.out.slice(-180));
  }

  {
    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'tools/lab/skill-tool-lab.mjs'), '--level=1', '--fail-on-skip'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, MY_AGENT_ROOT: root },
      },
    );
    push(
      'lab_strict',
      'suite',
      r.status === 0 ? 'pass' : 'fail',
      Date.now() - t0,
      (r.stdout || r.stderr || '').trim().slice(-180),
    );
  }
  await checkToolMutation();
  await checkApiHealth();

  // Market capability honesty
  {
    const t0 = Date.now();
    try {
      const { getMarketPipelineCapability } = await import(
        pathToFileURL(path.join(root, 'core/dist/skills/market-pipeline-capability.js')).href
      );
      const cap = getMarketPipelineCapability(root);
      push(
        'market_capability_report',
        'product',
        'pass',
        Date.now() - t0,
        `${cap.status}: ${cap.message_ko}`,
      );
    } catch (e) {
      push(
        'market_capability_report',
        'product',
        'fail',
        Date.now() - t0,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // predeploy (no --stage; delta-only deploys may lack full stage node)
  {
    const r = runNode('predeploy-check.mjs', [], 300_000);
    push('predeploy', 'suite', r.ok ? 'pass' : 'fail', r.ms, r.ok ? 'OK' : r.out.slice(-200));
  }

  if (fullAgent) {
    console.log('\n--full-agent: npm run verify:agent…');
    const t0 = Date.now();
    const r = spawnSync('npm', ['run', 'verify:agent'], {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, CQR_ACTIVATION_SERVER_URL: 'off' },
    });
    push(
      'verify_agent',
      'suite',
      r.status === 0 ? 'pass' : 'fail',
      Date.now() - t0,
      r.status === 0 ? 'ok' : (r.stdout || r.stderr || '').trim().slice(-200),
    );
  } else {
    push('verify_agent', 'suite', 'skip', 0, 'pass --full-agent to run (long)');
  }

  // Verdict
  const counts = { pass: 0, fail: 0, skip: 0, partial: 0 };
  for (const r of rows) counts[r.result] = (counts[r.result] || 0) + 1;

  const hardFails = rows.filter((r) => r.result === 'fail');
  const verdict =
    hardFails.length === 0
      ? 'PASS'
      : hardFails.some((f) =>
          /build|layout|tool_mutate|lab_strict|delta_contents|api_health|predeploy/.test(f.id),
        )
        ? 'FAIL'
        : 'PARTIAL';

  const report = {
    product: 'MY Agent',
    version: JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).version,
    role: 'delivery_acceptance_receiver',
    started,
    finished: new Date().toISOString(),
    verdict,
    counts,
    git: spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout?.trim(),
    residual_risks: [
      'See tools/lab/OPS_RESIDUAL_FIXES.md + tools/lab/OPENCLAW_RUNBOOK.md.',
      'R1–R15 product residual closed in code (probe timeout, Autopilot, text protocol, finish scrub, full-surface lab).',
      'Playwright browser tools skip without bootstrap — set MY_AGENT_LAB_BROWSER=1 after tools/bootstrap-playwright-if-needed.ps1',
      'OpenClaw: vault + /health; slash is manual only (never auto in lab).',
      'Market full research never auto; MY_AGENT_LAB_MARKET_LIVE=1 = file+parse probe only.',
      'Shell inAppBrowser: disk call-path gated; WPF real-click is manual ops Acceptance.',
      'Skill inject pass ≠ business deliverable quality; L2_LLM is skeleton only.',
      'Live OWUI agent: node tools/lab/owui-code-agent-smoke.mjs (skip if no key)',
      'predeploy --stage: auto --node-mode=deferred when stage lacks portable node',
      fullAgent ? null : 'verify:agent not run unless --full-agent',
      'Full surface: npm run lab:full-surface (optional ops complete)',
    ].filter(Boolean),
    rows,
  };

  writeFileSync(
    path.join(outDir, 'delivery-acceptance-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  const lines = [
    '# MY Agent Delivery Acceptance Report',
    '',
    `Verdict: **${verdict}**`,
    `Version: ${report.version} · git ${report.git}`,
    `When: ${report.started} → ${report.finished}`,
    '',
    `pass=${counts.pass} fail=${counts.fail} skip=${counts.skip} partial=${counts.partial}`,
    '',
    '## Gate table',
    '',
    '| result | group | id | ms | note |',
    '| --- | --- | --- | ---: | --- |',
    ...rows.map(
      (r) =>
        `| ${r.result} | ${r.group} | ${r.id} | ${r.ms} | ${String(r.note).replace(/\|/g, '/')} |`,
    ),
    '',
    '## Residual risks',
    ...report.residual_risks.map((x) => `- ${x}`),
    '',
    '## Acceptance criteria (receiver)',
    '- **P0**: build, single workspace UI, tool mutate round-trip, lab strict 0 fail, delta zip complete',
    '- **P1**: predeploy OK, outcome/work-mode/failure-plane, API /health',
    '- **P2**: skills/domains/embeddings goldens',
    '- Not required for ship: live OWUI code agent session, OpenClaw live, full install zip',
    '',
  ];
  writeFileSync(path.join(outDir, 'delivery-acceptance-report.md'), lines.join('\n'), 'utf8');

  console.log('\n' + JSON.stringify({ verdict, counts, report: path.join(outDir, 'delivery-acceptance-report.md') }, null, 2));
  process.exit(verdict === 'FAIL' ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
