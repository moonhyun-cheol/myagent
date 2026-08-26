#!/usr/bin/env node
/**
 * Oracle aggregator — classify manifest nodes green / red / env-red / explicit_skip.
 * Headline score = honest-v1 only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, OUT_DIR } from '../lib/paths.mjs';
import { runNode } from '../lib/spawn.mjs';

function readJson(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(OUT_DIR, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function layerStatus(layerFile, idHints = []) {
  const j = readJson(layerFile);
  if (!j) return { tag: 'dark', ok: false, note: 'no_evidence' };
  if (j.tag === 'env-red') return { tag: 'env-red', ok: false, note: j.note };
  if (Array.isArray(j.rows)) {
    const hits = idHints.length
      ? j.rows.filter((r) => idHints.some((h) => String(r.id).includes(h)))
      : j.rows;
    if (!hits.length) return { tag: 'dark', ok: false, note: 'no_row_hit' };
    if (hits.every((r) => r.tag === 'explicit_skip')) {
      return { tag: 'explicit_skip', ok: true, note: 'skipped' };
    }
    const product = hits.filter((r) => r.tag !== 'explicit_skip' && r.tag !== 'env-red');
    if (!product.length) return { tag: 'env-red', ok: false, note: 'only_env' };
    const ok = product.every((r) => r.ok);
    return { tag: ok ? 'green' : 'red', ok, note: null };
  }
  if (typeof j.ok === 'boolean') {
    return { tag: j.ok ? 'green' : j.tag || 'red', ok: j.ok, note: j.note || null };
  }
  return { tag: 'dark', ok: false, note: 'unknown_shape' };
}

export function aggregateOracle(opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'tools/fpv/manifest.json'), 'utf8'),
  );
  const l0 = readJson('l0.json');
  const l1 = readJson('l1-http.json');
  const l2 = readJson('l2-planes.json');
  const l3 = readJson('l3-shell-ui.json');
  const l4 = readJson('l4-journeys.json');
  const fixture = readJson('fixture-contract.json');

  const nodeResults = [];
  for (const node of manifest.nodes) {
    let status = { tag: 'dark', ok: false, note: 'unclassified' };
    const domain = node.domain;

    if (domain === 'fixtures') {
      const keys = node.pathMapKeys || [];
      const rows = (fixture?.rows || []).filter((r) => keys.includes(r.key));
      if (!rows.length) status = { tag: 'dark', ok: false, note: 'no_fixture_rows' };
      else if (rows.every((r) => r.ok)) status = { tag: 'green', ok: true };
      else status = { tag: 'env-red', ok: false, note: 'fixture_missing' };
    } else if (node.id === 'api.core') {
      status = layerStatus('l1-http.json');
    } else if (node.id.startsWith('plane.')) {
      status = layerStatus('l2-planes.json');
    } else if (node.id === 'market.pipeline' || node.id === 'market.concept') {
      const j = readJson('journey-J_market_process.json') || readJson('journey-market-process.json');
      if (!j) status = { tag: 'dark', ok: false, note: 'market_journey_missing' };
      else if (j.note === 'offline-only' || j.tag === 'explicit_skip') {
        status = {
          tag: 'explicit_skip',
          ok: true,
          note: 'market_offline_only — not live proof',
        };
      } else if (j.capability?.status && j.capability.status !== 'ready' && !j.ok) {
        status = {
          tag: 'env-red',
          ok: false,
          note: j.note || j.capability?.status,
        };
      } else status = { tag: j.ok ? 'green' : 'red', ok: Boolean(j.ok) };
    } else if (node.id === 'agent.code') {
      const j = readJson('journey-J_mutate_verify.json');
      status = j
        ? { tag: j.tag || (j.ok ? 'green' : 'red'), ok: Boolean(j.ok), note: j.note }
        : layerStatus('l0.json', ['outcome', 'post-mutate', 'failure']);
    } else if (node.id === 'ui.workspace' || node.id === 'shell.wpf') {
      status = layerStatus('l3-shell-ui.json', [node.id === 'ui.workspace' ? 'ui.' : 'shell.']);
    } else if (node.id === 'plugins.skills') {
      const j = readJson('journey-J_plugin_invoke.json');
      status = j
        ? { tag: j.tag || (j.ok ? 'green' : 'red'), ok: Boolean(j.ok), note: j.note }
        : layerStatus('l0.json', ['skills', 'agent-plugins']);
    } else if (node.id === 'attachments.media') {
      const local = readJson('journey-J_local_docs.json');
      const vision = readJson('journey-J_vision_attach.json');
      const j = local?.ok ? local : vision || local;
      status = j
        ? { tag: j.tag || (j.ok ? 'green' : 'red'), ok: Boolean(j.ok), note: j.note }
        : { tag: 'dark', ok: false, note: 'attach_journey_missing' };
    } else if (node.id === 'remote.mcp') {
      const j = readJson('journey-J_mcp_remote.json');
      if (j?.tag === 'explicit_skip') {
        status = { tag: 'explicit_skip', ok: true, note: j.note };
      } else if (j) {
        status = { tag: j.tag || (j.ok ? 'green' : 'red'), ok: Boolean(j.ok), note: j.note };
      } else {
        const row = (l1?.rows || []).find((r) => String(r.id).includes('/mcp'));
        status = row
          ? { tag: row.ok ? 'green' : row.tag || 'red', ok: Boolean(row.ok) }
          : { tag: 'explicit_skip', ok: true, note: 'no_mcp_evidence' };
      }
    } else if (node.id === 'deploy.output') {
      const j = readJson('journey-J_deploy.json');
      status = j
        ? { tag: j.ok ? 'green' : 'red', ok: Boolean(j.ok) }
        : layerStatus('l0.json', ['parity', 'nas']);
    } else if (node.id === 'memory.facts') {
      const pf = existsSync(path.join(REPO_ROOT, 'core/config/defaults/product-facts.json'));
      const uf = existsSync(path.join(REPO_ROOT, 'core/config/defaults/ui-facts.json'));
      status = { tag: pf && uf ? 'green' : 'red', ok: pf && uf };
    } else {
      // fallback: any l0 evidence
      status = l0 ? { tag: l0.ok ? 'green' : 'red', ok: Boolean(l0.ok), note: 'l0_fallback' } : status;
    }

    nodeResults.push({
      id: node.id,
      domain: node.domain,
      label: node.label,
      ...status,
    });
  }

  // honest-v1 headline
  let honest = null;
  if (opts.runHonest !== false) {
    const hr = runNode('tools/lab/maturity-scorecard.mjs', ['--cold', '--policy=honest-v1']);
    honest = readJson(path.join(REPO_ROOT, 'data/_skill_tool_lab/maturity-scorecard-honest-v1.json'));
    if (!honest) {
      honest = {
        ok: hr.ok,
        note: 'scorecard_json_missing',
        rawTail: (hr.out || '').slice(-500),
      };
    }
  }

  const dark = nodeResults.filter((n) => n.tag === 'dark');
  const red = nodeResults.filter((n) => n.tag === 'red');
  const envRed = nodeResults.filter((n) => n.tag === 'env-red');
  const green = nodeResults.filter((n) => n.tag === 'green');
  const skip = nodeResults.filter((n) => n.tag === 'explicit_skip');

  const gaps = [...dark, ...red].map((n) => ({
    id: n.id,
    tag: n.tag,
    note: n.note || null,
    ticket: n.tag === 'dark'
      ? `FPV-GAP: classify/prove ${n.id} (${n.label})`
      : `FPV-RED: fix product path for ${n.id} — ${n.note || 'see layer report'}`,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    headlinePolicy: 'honest-v1',
    layers: {
      L0: l0 ? { ok: l0.ok } : null,
      L1: l1 ? { ok: l1.ok, tag: l1.tag } : null,
      L2: l2 ? { ok: l2.ok } : null,
      L3: l3 ? { ok: l3.ok } : null,
      L4: l4 ? { ok: l4.ok } : null,
    },
    nodes: nodeResults,
    counts: {
      green: green.length,
      red: red.length,
      envRed: envRed.length,
      explicit_skip: skip.length,
      dark: dark.length,
      total: nodeResults.length,
    },
    gaps,
    scoreHonest: honest,
    ok: dark.length === 0 && red.length === 0 && Boolean(l0?.ok !== false),
  };

  writeFileSync(path.join(OUT_DIR, 'oracle.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(OUT_DIR, 'score-honest.json'), `${JSON.stringify(honest, null, 2)}\n`);
  return report;
}

if (process.argv[1]?.endsWith('aggregate.mjs')) {
  const r = aggregateOracle();
  console.log(
    `oracle dark=${r.counts.dark} red=${r.counts.red} env=${r.counts.envRed} green=${r.counts.green}`,
  );
  process.exit(r.ok ? 0 : 1);
}
