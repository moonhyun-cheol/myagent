#!/usr/bin/env node
/**
 * Generic FPV journey runner (JSON definitions under journeys/).
 * Market P0 still uses specialized run-journey-market.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, OUT_DIR, apiBase, argFlag, absFromRepo } from '../lib/paths.mjs';
import { resolveAlias, rewritePrompt } from '../lib/fixture-contract.mjs';
import {
  createSession,
  streamChat,
  uploadAttachment,
  waitForApi,
  sleep,
  withInfraRetry,
  healthOk,
} from '../lib/http-chat.mjs';
import { runNpm } from '../lib/spawn.mjs';
import {
  bindWorkspaceForPlane,
  bindDevWorkspace,
} from '../../lab/lab-workspace-bind.mjs';
import { isMainModule } from '../lib/is-main.mjs';

const TIMEOUT_MS = Number(process.env.MY_AGENT_LIVE_BT_TIMEOUT_MS || 420_000);

function expandText(text) {
  return String(text || '').replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, key) => {
    const r = resolveAlias(key);
    if (!r.path) throw Object.assign(new Error(`env-red: missing {{${key}}}`), { tag: 'env-red' });
    return r.path;
  });
}

function scoreExpect(content, expect = {}, error) {
  const failures = [];
  const text = String(content || '');
  if (error) failures.push('http_error');
  if (!text.trim()) failures.push('empty');
  if (/모델이\s*빈\s*응답|empty\s+response/i.test(text)) failures.push('empty_or_infra');
  if (expect.minLen && text.length < expect.minLen) failures.push('too_short');
  for (const pat of expect.mustMatch || []) {
    if (!new RegExp(pat, 'i').test(text)) failures.push(`missing:${pat}`);
  }
  for (const pat of expect.forbid || []) {
    if (new RegExp(pat, 'i').test(text)) failures.push(`forbid:${pat}`);
  }
  if (expect.diskProbe) {
    const rootAlias = expect.diskProbe.relativeToAlias;
    const root = resolveAlias(rootAlias).path;
    const file = root ? path.join(root, expect.diskProbe.file) : null;
    if (!file || !existsSync(file)) failures.push('disk_missing');
    else {
      const body = readFileSync(file, 'utf8');
      for (const needle of expect.diskProbe.includes || []) {
        if (!body.includes(needle)) failures.push(`disk_missing:${needle}`);
      }
    }
  }
  // When disk probe already proves the marker, do not also require it in prose.
  if (expect.diskProbe && !failures.some((f) => String(f).startsWith('disk_'))) {
    const filtered = failures.filter((f) => !String(f).startsWith('missing:'));
    failures.length = 0;
    failures.push(...filtered);
  }
  return { ok: failures.length === 0, failures, preview: text.slice(0, 500) };
}

async function loadGates() {
  const t = Date.now();
  const plane = await import(
    pathToFileURL(path.join(REPO_ROOT, 'core/dist/agent/agent-surface-plane.js')).href + `?t=${t}`
  );
  return { plane };
}

function offlineRoute(gates, message, mode) {
  const classified = gates.plane.classifySurfacePlane({
    message,
    mode,
    explicitMode: mode,
    mutatePrimary: false,
  });
  const surface = classified.plane;
  const ideForce = gates.plane.surfaceAllowsIdeEditForce(surface);
  return { surface, ideForce };
}

export async function runJourneyFile(journeyRel, opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const journeyPath = path.isAbsolute(journeyRel)
    ? journeyRel
    : path.join(REPO_ROOT, 'tools/fpv', journeyRel);
  const journey = JSON.parse(readFileSync(journeyPath, 'utf8'));
  const offlineOnly = opts.offlineOnly || argFlag('--offline-only') || process.env.MY_AGENT_FPV_OFFLINE === '1';
  const base = opts.base || apiBase();
  const report = {
    journey: journey.id,
    title: journey.title,
    generatedAt: new Date().toISOString(),
    base,
    offlineOnly,
    steps: [],
    ok: false,
    tag: 'red',
  };

  // optional secret gate → explicit_skip
  if (journey.skipUnlessSecret) {
    const secretOk =
      Boolean(process.env[journey.skipUnlessSecret]?.trim())
      || (journey.skipUnlessFile
        && existsSync(path.isAbsolute(journey.skipUnlessFile)
          ? journey.skipUnlessFile
          : path.join(REPO_ROOT, journey.skipUnlessFile)));
    if (!secretOk) {
      report.ok = true;
      report.tag = 'explicit_skip';
      report.note = `skipUnlessSecret:${journey.skipUnlessSecret}`;
      writeJourney(report);
      return report;
    }
  }

  // fixture aliases
  for (const key of journey.fixtureAliases || []) {
    const r = resolveAlias(key);
    if (!r.ok || !r.path) {
      report.ok = false;
      report.tag = 'env-red';
      report.note = `missing fixture ${key}`;
      report.steps.push({ id: 'S0_fixture', ok: false, failures: [`env_red:${key}`], tag: 'env-red' });
      writeJourney(report);
      return report;
    }
  }

  const gates = await loadGates().catch(() => null);

  for (const step of journey.steps || []) {
    if (step.kind === 'npm') {
      const r = runNpm(step.npm);
      report.steps.push({
        id: step.id,
        kind: 'npm',
        ok: r.ok,
        failures: r.ok ? [] : ['npm_fail'],
        tag: r.ok ? 'green' : 'red',
      });
      continue;
    }

    if (step.kind === 'http_get') {
      if (offlineOnly) {
        report.steps.push({
          id: step.id,
          kind: 'http_get',
          ok: true,
          tag: 'explicit_skip',
          note: 'offline-only',
        });
      }
      continue;
    }

    let message = expandText(step.text || '');
    message = rewritePrompt(message);

    if (step.offlineRoutingOnly || offlineOnly) {
      if (!gates) {
        report.steps.push({
          id: step.id,
          ok: false,
          failures: ['gates_unavailable'],
          tag: 'red',
        });
        continue;
      }
      const route = offlineRoute(gates, message || step.text || 'x', step.mode || 'chat');
      const failures = [];
      const exp = step.expect?.routing || {};
      if (exp.notSurface && route.surface === exp.notSurface) failures.push('routed_coding');
      if (exp.noIdeForce && route.ideForce) failures.push('ide_force');
      report.steps.push({
        id: step.id,
        ok: failures.length === 0,
        failures,
        surface: route.surface,
        tag: failures.length === 0 ? 'green' : 'red',
        offline: true,
      });
      continue;
    }
  }

  if (offlineOnly) {
    const needsLiveDisk = (journey.steps || []).some((s) => s.expect?.diskProbe);
    report.ok = report.steps.every((s) => s.ok || s.tag === 'explicit_skip');
  if (needsLiveDisk) {
      report.tag = 'explicit_skip';
      report.note = 'offline-only: disk-probe journey not executed live';
      report.ok = true; // skip ≠ fail
    } else {
      report.tag = report.ok ? 'green' : 'red';
      report.note = 'offline-only';
    }
    writeJourney(report);
    return report;
  }

  await waitForApi(base, 20_000);
  if (!(await healthOk(base))) {
    report.ok = false;
    report.tag = 'env-red';
    report.note = 'api_down';
    writeJourney(report);
    return report;
  }

  await waitForApi(base, 15_000);
  let sessionId = await createSession(base);
  report.sessionId = sessionId;

  const lockedWorkspace = journey.bindWorkspace ? expandText(journey.bindWorkspace) : null;

  // bind workspace if requested (toy mutate needs explicit root)
  if (lockedWorkspace) {
    try {
      await bindDevWorkspace(base, lockedWorkspace);
    } catch (e) {
      report.ok = false;
      report.tag = 'env-red';
      report.note = `workspace_bind_failed: ${e instanceof Error ? e.message : e}`;
      writeJourney(report);
      return report;
    }
  }

  for (const step of journey.steps || []) {
    if (step.kind === 'npm' || step.offlineRoutingOnly) continue;
    if (step.kind === 'http_get') {
      try {
        const res = await fetch(`${base}${step.path}`, {
          method: 'GET',
          signal: AbortSignal.timeout(12_000),
          headers: { accept: 'application/json' },
        });
        const ok = res.status !== 404 && res.status < 500;
        report.steps.push({
          id: step.id,
          kind: 'http_get',
          ok,
          failures: ok ? [] : [`status_${res.status}`],
          tag: ok ? 'green' : 'red',
          status: res.status,
        });
        console.log(`\n==== ${journey.id} / ${step.id} ====`);
        console.log(`  ${ok ? 'PASS' : 'FAIL'} GET ${step.path} ${res.status}`);
      } catch (e) {
        report.steps.push({
          id: step.id,
          ok: false,
          failures: ['http_error'],
          tag: 'env-red',
          error: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }
    console.log(`\n==== ${journey.id} / ${step.id} ====`);
    const message = rewritePrompt(expandText(step.text || ''));
    let attachmentIds = [];
    if (step.attachAlias) {
      try {
        const filePath = resolveAlias(step.attachAlias).path;
        if (!filePath || !existsSync(filePath)) {
          throw Object.assign(new Error(`missing attach fixture ${step.attachAlias}`), {
            tag: 'env-red',
          });
        }
        const id = await uploadAttachment(base, sessionId, filePath);
        attachmentIds = [id];
        console.log(`  attached ${step.attachAlias} → ${id}`);
      } catch (e) {
        report.steps.push({
          id: step.id,
          ok: false,
          failures: ['attach_upload_failed'],
          tag: e.tag === 'env-red' ? 'env-red' : 'red',
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
    }
    try {
      if (lockedWorkspace) await bindDevWorkspace(base, lockedWorkspace);
      else await bindWorkspaceForPlane(base, step.plane || 'knowledge');
    } catch {
      /* ignore */
    }
    const raw = await withInfraRetry(
      async (attempt) => {
        if (attempt >= 2) {
          const sid = await createSession(base).catch(() => sessionId);
          if (sid !== sessionId) {
            console.log(`  session rotated → ${sid}`);
            sessionId = sid;
          }
        }
        return streamChat(
          base,
          sessionId,
          message,
          step.mode || 'chat',
          TIMEOUT_MS,
          attachmentIds,
        );
      },
      { base, extra: 2 },
    );
    const score = scoreExpect(raw.content, step.expect, raw.error);
    report.steps.push({
      id: step.id,
      mode: step.mode,
      sessionId,
      ms: raw.ms,
      attachments: attachmentIds,
      ...score,
      tag: score.ok ? 'green' : 'red',
      error: raw.error || null,
    });
    console.log(`  ${score.ok ? 'PASS' : 'FAIL'} ${(score.failures || []).join(',') || '-'}`);
    await sleep(800);
  }

  // same-session oracle
  const needSame = journey.oracles?.requireSameSession || [];
  if (needSame.length) {
    const ids = new Set(
      report.steps.filter((s) => needSame.includes(s.id) && s.sessionId).map((s) => s.sessionId),
    );
    if (ids.size > 1) {
      report.steps.push({
        id: 'oracle_same_session',
        ok: false,
        failures: ['session_split'],
        tag: 'red',
      });
    }
  }

  report.ok = report.steps.every((s) => s.ok || s.tag === 'explicit_skip');
  report.tag = report.ok ? 'green' : report.tag === 'env-red' ? 'env-red' : 'red';
  writeJourney(report);
  return report;
}

function writeJourney(report) {
  const safe = String(report.journey || 'journey').replace(/[^\w.-]+/g, '_');
  const jsonPath = path.join(OUT_DIR, `journey-${safe}.json`);
  const mdPath = path.join(OUT_DIR, `journey-${safe}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# FPV Journey: ${report.journey}`,
    '',
    `Generated: ${report.generatedAt}`,
    `OK: **${report.ok}** (${report.tag})`,
    report.note ? `Note: ${report.note}` : '',
    '',
    '| Step | Result | Failures |',
    '|------|:------:|----------|',
    ...report.steps.map(
      (s) => `| ${s.id} | ${s.ok ? 'PASS' : 'FAIL'} | ${(s.failures || []).join(', ') || '-'} |`,
    ),
    '',
  ];
  writeFileSync(mdPath, lines.filter(Boolean).join('\n'), 'utf8');
  console.log(`wrote ${jsonPath}`);
}

if (isMainModule(import.meta.url)) {
  const file = process.argv.find((a) => a.startsWith('--journey='))?.split('=')[1]
    || 'journeys/local-docs.json';
  runJourneyFile(file)
    .then((r) => process.exit(r.ok || r.tag === 'env-red' ? (r.ok ? 0 : 2) : 1))
    .catch((e) => {
      console.error(e);
      process.exit(e.tag === 'env-red' ? 2 : 1);
    });
}
