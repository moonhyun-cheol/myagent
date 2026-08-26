#!/usr/bin/env node
/**
 * DEPRECATED measure-only overnight loop.
 * Prefer human/agent overnight FIX cycles: MEASURE→TRIAGE→FIX≤3→PROVE→LIVE(budget)→LOG
 *   tools/lab/overnight-fix-cycle.mjs + overnight-fix-cycle-log.md
 *
 * To force measure-only (not overnight main): pass --force-measure-only
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
const LOG = path.join(outDir, 'overnight-cold-loop.log');
const STATE = path.join(outDir, 'overnight-cold-loop-state.json');

const args = process.argv.slice(2);
if (!args.includes('--force-measure-only')) {
  console.error(
    [
      'REFUSED: overnight-cold-loop is measure-only and is not the overnight main.',
      'Use: tools/lab/overnight-fix-cycle.mjs + agent FIX≤3 per cycle.',
      'Or pass --force-measure-only for explicit measure-only (discouraged overnight).',
    ].join('\n'),
  );
  process.exit(2);
}
function arg(name, def) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

// Default until: next local 08:30 if now past 08:30 else today 08:30 doesn't make sense → tomorrow 08:30 KST-ish
function defaultUntil() {
  const d = new Date();
  // +15.5h roughly to 8:30 next morning if now ~16:30
  const end = new Date(d.getTime() + 16 * 3600_000);
  end.setMinutes(30, 0, 0);
  // prefer 08:30
  const target = new Date(d);
  target.setHours(8, 30, 0, 0);
  if (target.getTime() <= d.getTime()) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

const untilIso = arg('until', process.env.MY_AGENT_OVERNIGHT_UNTIL || defaultUntil());
const liveEvery = Number(arg('live-every', process.env.MY_AGENT_OVERNIGHT_LIVE_EVERY || 10));
const maxCycles = Number(arg('max-cycles', process.env.MY_AGENT_OVERNIGHT_MAX || 40));
// Default 15 min between offline cycles — cuts Cursor-adjacent LLM to ~2–4 live suites overnight
const sleepMs = Number(arg('sleep-ms', process.env.MY_AGENT_OVERNIGHT_SLEEP_MS || 900_000));
const base = (
  process.env.MY_AGENT_API_BASE || process.env.CQR_E2E_BASE_URL || 'http://127.0.0.1:10200'
).replace(/\/$/, '');
const allowLive = !args.includes('--offline-only');
const liveRepeats = Number(arg('live-repeats', '1')); // default 1 to save tokens
// Max live suites in one overnight window (hard stop even if live-every fires)
const maxLive = Number(arg('max-live', process.env.MY_AGENT_OVERNIGHT_MAX_LIVE || 3));

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  appendFileSync(LOG, `${msg}\n`, 'utf8');
}

function run(label, argv, env = {}) {
  log(`run ${label}`);
  const r = spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 30 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (out) {
    const tail = out.slice(-2500);
    appendFileSync(LOG, `${tail}\n`, 'utf8');
  }
  return { ok: r.status === 0, status: r.status ?? 1 };
}

function runNpm(script) {
  return spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', script],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: process.env,
      maxBuffer: 30 * 1024 * 1024,
    },
  ).status === 0;
}

async function healthOk() {
  try {
    const j = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) }).then((r) =>
      r.json(),
    );
    return Boolean(j?.ok);
  } catch {
    return false;
  }
}

function readMaturity() {
  const p = path.join(outDir, 'maturity-scorecard.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  // Blocking sleep without Atomics (SharedArrayBuffer optional on some Node builds).
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 500)'], {
      encoding: 'utf8',
      timeout: 2000,
    });
  }
}

async function main() {
  const until = Date.parse(untilIso);
  log(`overnight-cold-loop until=${untilIso} liveEvery=${liveEvery} maxCycles=${maxCycles} maxLive=${maxLive} sleepMs=${sleepMs} allowLive=${allowLive}`);
  log('token policy: offline default; ≤maxLive full live suites; no Cursor agent spawn');

  const state = {
    started: new Date().toISOString(),
    cycles: 0,
    offlinePass: 0,
    offlineFail: 0,
    liveAttempts: 0,
    lastMean: null,
    bestMean: 0,
    history: [],
  };

  // one build at start
  log('initial build');
  runNpm('build');

  while (state.cycles < maxCycles && Date.now() < until) {
    state.cycles += 1;
    log(`======== cycle ${state.cycles} ========`);

    const off = run('daily-smoke offline', [
      path.join(root, 'tools/lab/daily-smoke.mjs'),
      '--offline-only',
    ]);
    if (off.ok) state.offlinePass += 1;
    else state.offlineFail += 1;

    // cold maturity (0 LLM)
    run('maturity cold', [path.join(root, 'tools/lab/maturity-scorecard.mjs'), '--cold']);
    let m = readMaturity();
    let mean = m?.productMean ?? 0;
    state.lastMean = mean;
    if (mean > state.bestMean) state.bestMean = mean;
    log(`cold mean=${mean} min=${m?.minScore} scores=${JSON.stringify(m?.scores || {})}`);

    // scheduled live (expensive) — hard-capped by maxLive
    const dueLive =
      allowLive
      && liveEvery > 0
      && state.liveAttempts < maxLive
      && (state.cycles % liveEvery === 0 || (!off.ok && state.cycles > 1 && state.liveAttempts < maxLive));
    if (dueLive) {
      if (!(await healthOk())) {
        log('API down — skip live (no LLM)');
        // try start api once
        spawnSync(
          process.platform === 'win32' ? 'powershell.exe' : 'sh',
          process.platform === 'win32'
            ? [
                '-NoProfile',
                '-Command',
                `Start-Process node -ArgumentList 'core/dist/main.js' -WorkingDirectory '${root.replace(/'/g, "''")}' -WindowStyle Hidden`,
              ]
            : ['-c', `cd "${root}" && node core/dist/main.js &`],
          { encoding: 'utf8', windowsHide: true },
        );
        sleep(5000);
      }
      if (await healthOk()) {
        state.liveAttempts += 1;
        log(`LIVE maturity --live --repeats=${liveRepeats} (LLM cost)`);
        run(
          'maturity live',
          [
            path.join(root, 'tools/lab/maturity-scorecard.mjs'),
            '--live',
            `--repeats=${liveRepeats}`,
          ],
          { MY_AGENT_API_BASE: base },
        );
        m = readMaturity();
        mean = m?.productMean ?? mean;
        state.lastMean = mean;
        if (mean > state.bestMean) state.bestMean = mean;
        log(`after-live mean=${mean} min=${m?.minScore}`);

        // full daily+live at most once per night (extra LLM)
        if (state.liveAttempts === 1) {
          log('daily-smoke FULL once (includes live — extra LLM)');
          run('daily-smoke full', [path.join(root, 'tools/lab/daily-smoke.mjs')], {
            MY_AGENT_API_BASE: base,
          });
          run('maturity cold after daily', [path.join(root, 'tools/lab/maturity-scorecard.mjs'), '--cold']);
          m = readMaturity();
          mean = m?.productMean ?? mean;
          log(`after-daily mean=${mean}`);
        }
      } else {
        log('API still down — live skipped');
      }
    }

    state.history.push({
      cycle: state.cycles,
      at: new Date().toISOString(),
      offlineOk: off.ok,
      mean: state.lastMean,
      live: dueLive,
    });
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);

    // stop early if cold floors green and we have consecutive live full in ledger + mean high — optional soft target
    if (m?.allPass && (m?.scores?.l1_hardbars || 0) >= 95) {
      log('all dims ≥95 under cold policy — keep looping for stability until until=');
    }

    if (Date.now() + sleepMs >= until) break;
    log(`sleep ${sleepMs}ms`);
    sleep(sleepMs);
  }

  // final cold score
  run('final cold maturity', [path.join(root, 'tools/lab/maturity-scorecard.mjs'), '--cold']);
  const finalM = readMaturity();
  state.finished = new Date().toISOString();
  state.final = finalM;
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    path.join(outDir, 'overnight-cold-loop-report.md'),
    [
      '# Overnight cold loop',
      '',
      `Finished: ${state.finished}`,
      `Cycles: ${state.cycles}`,
      `Offline pass/fail: ${state.offlinePass}/${state.offlineFail}`,
      `Live attempts: ${state.liveAttempts}`,
      `Best productMean: ${state.bestMean}`,
      `Final productMean: ${finalM?.productMean}`,
      `Final min: ${finalM?.minScore}`,
      `Final scores: ${JSON.stringify(finalM?.scores)}`,
      '',
      `> ${finalM?.disclaimer || ''}`,
      '',
    ].join('\n'),
    'utf8',
  );
  log(`DONE cycles=${state.cycles} bestMean=${state.bestMean} finalMean=${finalM?.productMean}`);
  process.exit(0);
}

main().catch((e) => {
  log(String(e));
  process.exit(1);
});
