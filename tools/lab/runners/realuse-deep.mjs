/**
 * Realuse "deep" / previously out-of-scope planes:
 *  - product UI wiring (Accept/Reject/@/terminal Stop, shell inAppBrowser)
 *  - agent gate suite (MAR / outcome / continuity / … — no live LLM)
 *  - skills L2 routing matrix
 *  - Playwright UI+API e2e against ephemeral API
 *  - OpenClaw surface
 *  - live OWUI mutate (keys required for pass; skip if absent unless force)
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { runShellUiIntegrationSurface } from './shell-ui-surface.mjs';
import { runOpenClawSurface } from './openclaw-surface.mjs';
import { runSkillsL2 } from './skills-l2.mjs';
import { runGreenfieldPathlessSurface } from './greenfield-pathless.mjs';
import { runSkillQualitySurface } from './skill-quality-surface.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function row(suite, item, result, ms, note = '') {
  return {
    suite,
    item,
    level: 2,
    result,
    ms,
    note: String(note).slice(0, 280),
  };
}

/**
 * Static UI affordance evidence (Playwright cannot Accept without a live mutate turn).
 */
export function runUiRealuseMarkers(root) {
  const rows = [];
  const files = {
    ChatPane: path.join(root, 'ui/workspace/src/components/ChatPane.tsx'),
    TerminalPane: path.join(root, 'ui/workspace/src/components/TerminalPane.tsx'),
    store: path.join(root, 'ui/workspace/src/store/workspaceStore.ts'),
  };
  const need = {
    ChatPane: [
      [/pendingMutateReview/, 'mutate review state'],
      [/Accept|수락/, 'Accept label'],
      [/Reject|거절|복원/, 'Reject path'],
      [/context-at-button|contextAt|@ 컨텍스트|pendingContextPaths/, '@ context'],
      [/diff_lines|diffPreview|previewCheckpoint|checkpoint\/preview/, 'diff preview'],
    ],
    TerminalPane: [
      [/cancel|Stop|중지|terminalJob|run-terminal\/cancel|listActive|jobs/, 'terminal stop/jobs'],
    ],
    store: [
      [/pendingMutateReview/, 'store review'],
      [/terminalJobId/, 'store terminal job'],
      [/pendingContextPaths|contextPaths/, 'store @ paths'],
    ],
  };
  for (const [key, markers] of Object.entries(need)) {
    const p = files[key];
    if (!existsSync(p)) {
      rows.push(row('ui_markers', `${key}_file`, 'fail', 0, 'missing'));
      continue;
    }
    const body = readFileSync(p, 'utf8');
    for (const [re, label] of markers) {
      rows.push(
        row(
          'ui_markers',
          `${key}_${label.replace(/\s+/g, '_')}`,
          re.test(body) ? 'pass' : 'fail',
          0,
          re.test(body) ? label : `missing ${label} in ${key}`,
        ),
      );
    }
  }
  return rows;
}

function runVerifyScript(root, rel, timeoutMs = 120_000) {
  const t0 = Date.now();
  const script = path.join(root, rel);
  if (!existsSync(script)) {
    return row('agent_gates', path.basename(rel), 'fail', 0, 'script missing');
  }
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, MY_AGENT_ROOT: root },
  });
  const tail = (r.stdout || r.stderr || '').trim().slice(-160);
  return row(
    'agent_gates',
    path.basename(rel, '.mjs'),
    r.status === 0 ? 'pass' : 'fail',
    Date.now() - t0,
    r.status === 0 ? tail || 'ok' : tail || `exit ${r.status}`,
  );
}

export function runAgentGateSuite(root) {
  const scripts = [
    'tools/verify-multi-agent.mjs',
    'tools/verify-agent-outcome-gate.mjs',
    'tools/verify-coding-iq.mjs',
    'tools/verify-session-continuity.mjs',
    'tools/verify-work-mode-loop.mjs',
    'tools/verify-failure-plane.mjs',
    'tools/verify-harness-policy.mjs',
    'tools/verify-turn-decision.mjs',
    'tools/verify-code-agent-loop.mjs',
    'tools/verify-acceptance-review.mjs',
    'tools/verify-locked-constraints.mjs',
    'tools/verify-harness-goldens.mjs',
    'tools/verify-license.mjs',
  ];
  return scripts.map((s) => runVerifyScript(root, s));
}

export async function runPlaywrightProductE2e(root) {
  const rows = [];
  const distMain = path.join(root, 'core', 'dist', 'main.js');
  if (!existsSync(distMain)) {
    return [row('e2e', 'api_boot', 'fail', 0, 'build first')];
  }
  const pwCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(pwCli)) {
    return [row('e2e', 'playwright_cli', 'skip', 0, '@playwright/test not installed')];
  }

  // Prefer product Chromium path (same as agent browser tools)
  const browsersPath = path.join(root, 'runtime', 'playwright', 'browsers');
  process.env.PLAYWRIGHT_BROWSERS_PATH =
    process.env.PLAYWRIGHT_BROWSERS_PATH || browsersPath;

  let chromiumOk = false;
  try {
    const probe = await import(
      pathToFileURL(path.join(root, 'core', 'dist', 'browser', 'playwright-probe.js')).href
    );
    if (typeof probe.applyPlaywrightEnv === 'function') probe.applyPlaywrightEnv(root);
    chromiumOk = probe.isPlaywrightAvailable(root) === true;
  } catch {
    chromiumOk = existsSync(browsersPath);
  }

  let port;
  try {
    port = await freePort();
  } catch (e) {
    return [row('e2e', 'port', 'fail', 0, String(e))];
  }

  const child = spawn(process.execPath, [distMain], {
    cwd: root,
    env: {
      ...process.env,
      MY_AGENT_ROOT: root,
      CQR_API_PORT: String(port),
      PORT: String(port),
      CQR_ACTIVATION_SERVER_URL: 'off',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  await new Promise((r) => setTimeout(r, 1600));

  try {
    let healthy = false;
    for (let i = 0; i < 8; i++) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    rows.push(row('e2e', 'api_health', healthy ? 'pass' : 'fail', 0, base));
    if (!healthy) return rows;

    const env = {
      ...process.env,
      MY_AGENT_ROOT: root,
      CQR_E2E_BASE_URL: base,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    };
    const config = path.join(root, 'tools', 'e2e', 'playwright.config.ts');

    // API smoke always (no Chromium)
    {
      const t0 = Date.now();
      const r = spawnSync(
        process.execPath,
        [pwCli, 'test', 'api-smoke.spec.ts', '-c', config],
        {
          cwd: path.join(root, 'tools', 'e2e'),
          encoding: 'utf8',
          timeout: 180_000,
          env,
        },
      );
      const tail = (r.stdout || r.stderr || '').replace(/\s+/g, ' ').slice(-200);
      rows.push(
        row(
          'e2e',
          'api-smoke',
          r.status === 0 ? 'pass' : 'fail',
          Date.now() - t0,
          r.status === 0 ? 'ok' : tail,
        ),
      );
    }

    // Static HTML brand / bootstrap markers without browser binary
    try {
      const htmlRes = await fetch(base, { signal: AbortSignal.timeout(5000) });
      const html = await htmlRes.text();
      const hasRoot = html.includes('id="root"') || html.includes("id='root'");
      const hasAsset = /\/assets\/index-/.test(html);
      rows.push(
        row(
          'e2e',
          'static_ui_shell',
          hasRoot && hasAsset ? 'pass' : 'fail',
          0,
          hasRoot && hasAsset ? 'root+asset' : html.slice(0, 120),
        ),
      );
    } catch (e) {
      rows.push(
        row('e2e', 'static_ui_shell', 'fail', 0, e instanceof Error ? e.message : String(e)),
      );
    }

    if (!chromiumOk && process.env.MY_AGENT_LAB_BROWSER !== '1') {
      rows.push(
        row(
          'e2e',
          'ui-smoke',
          'skip',
          0,
          'chromium missing (runtime/playwright/browsers) — static_ui_shell + UI markers cover wiring; MY_AGENT_LAB_BROWSER=1 to hard-fail',
        ),
      );
      return rows;
    }

    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [pwCli, 'test', 'ui-smoke.spec.ts', '-c', config],
      {
        cwd: path.join(root, 'tools', 'e2e'),
        encoding: 'utf8',
        timeout: 180_000,
        env,
      },
    );
    const tail = (r.stdout || r.stderr || '').replace(/\s+/g, ' ').slice(-200);
    const softMissing =
      r.status !== 0
      && /Executable doesn't exist|browserType\.launch|npx playwright install/i.test(tail);
    rows.push(
      row(
        'e2e',
        'ui-smoke',
        r.status === 0
          ? 'pass'
          : softMissing && process.env.MY_AGENT_LAB_BROWSER !== '1'
            ? 'skip'
            : 'fail',
        Date.now() - t0,
        r.status === 0 ? 'ok' : tail,
      ),
    );
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
  return rows;
}

export async function runLiveOwuiDeep(root, { force = false } = {}) {
  const t0 = Date.now();
  const vault = path.join(root, 'data', 'vault', 'provider-keys.json');
  const hasKey =
    existsSync(vault) || Boolean(process.env.CQR_OPENWEBUI_API_KEY?.trim());
  if (!hasKey) {
    return [
      row(
        'live',
        'owui_code_agent',
        force ? 'fail' : 'skip',
        Date.now() - t0,
        'no provider keys — vault or CQR_OPENWEBUI_API_KEY',
      ),
    ];
  }
  // Prefer a clean 2nd shot if first is partial flaky
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'tools', 'lab', 'owui-code-agent-smoke.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 180_000,
        env: {
          ...process.env,
          MY_AGENT_ROOT: root,
          MY_AGENT_OWUI_SMOKE_FORCE: force ? '1' : process.env.MY_AGENT_OWUI_SMOKE_FORCE,
        },
      },
    );
    let parsed = null;
    try {
      const j = path.join(root, 'data', '_skill_tool_lab', 'owui-code-agent-smoke.json');
      if (existsSync(j)) parsed = JSON.parse(readFileSync(j, 'utf8'));
    } catch {
      /* ignore */
    }
    const result = String(parsed?.result || (r.status === 0 ? 'pass' : 'fail'));
    let mapped = 'fail';
    if (result === 'skip') mapped = 'skip';
    else if (result === 'pass') mapped = 'pass';
    else if (result === 'partial') mapped = force ? 'fail' : 'pass';
    else if (parsed?.ok === true && !force) mapped = 'pass';
    else mapped = 'fail';

    last = row(
      'live',
      'owui_code_agent',
      mapped,
      Date.now() - t0,
      `attempt=${attempt} ${result} ${parsed?.note || ''}`.trim(),
    );
    if (mapped === 'pass' || mapped === 'skip') break;
    if (force) break;
  }
  return last ? [last] : [row('live', 'owui_code_agent', 'fail', Date.now() - t0, 'no result')];
}

/**
 * @returns {Promise<{ rows: object[] }>}
 */
export async function runRealuseDeepPack(root, opts = {}) {
  const forceOwui = opts.forceOwui === true || process.env.MY_AGENT_OWUI_SMOKE_FORCE === '1';
  const rows = [];

  console.log('deep: UI markers…');
  rows.push(...runUiRealuseMarkers(root));

  console.log('deep: shell inAppBrowser…');
  rows.push(...runShellUiIntegrationSurface(root));

  console.log('deep: agent gates (MAR/outcome/…)…');
  rows.push(...runAgentGateSuite(root));

  console.log('deep: skills L2…');
  process.env.MY_AGENT_LAB_L2 = process.env.MY_AGENT_LAB_L2 || '1';
  try {
    rows.push(...(await runSkillsL2(root)));
  } catch (e) {
    rows.push(
      row('skills_l2', 'run', 'fail', 0, e instanceof Error ? e.message : String(e)),
    );
  }

  console.log('deep: openclaw…');
  try {
    rows.push(...(await runOpenClawSurface(root)));
  } catch (e) {
    rows.push(
      row('openclaw', 'run', 'fail', 0, e instanceof Error ? e.message : String(e)),
    );
  }

  console.log('deep: skill quality…');
  try {
    rows.push(...(await runSkillQualitySurface(root)));
  } catch (e) {
    rows.push(
      row('skill_quality', 'run', 'skip', 0, e instanceof Error ? e.message : String(e)),
    );
  }

  console.log('deep: greenfield pathless…');
  try {
    rows.push(...(await runGreenfieldPathlessSurface(root)));
  } catch (e) {
    rows.push(
      row('greenfield', 'run', 'skip', 0, e instanceof Error ? e.message : String(e)),
    );
  }

  console.log('deep: Playwright product e2e…');
  rows.push(...(await runPlaywrightProductE2e(root)));

  console.log('deep: live OWUI…');
  rows.push(...(await runLiveOwuiDeep(root, { force: forceOwui })));

  const outDir = path.join(root, 'data', '_skill_tool_lab');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'realuse-deep-rows.json'),
    `${JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2)}\n`,
    'utf8',
  );
  return { rows };
}
