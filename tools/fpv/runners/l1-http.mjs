#!/usr/bin/env node
/** L1 HTTP matrix — happy GET routes + intentional fail probes. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, OUT_DIR, apiBase } from '../lib/paths.mjs';
import { healthOk } from '../lib/http-chat.mjs';
import { isMainModule } from '../lib/is-main.mjs';

const facts = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'core/config/defaults/product-facts.json'), 'utf8'),
);

const SKIP_EXACT = new Set(['/assets/', '/outputs', '/license', '/mcp', '/generate', '/fs', '/browser']);

function listGetProbes() {
  const routes = Array.isArray(facts.api?.routes) ? facts.api.routes : [];
  const exact = routes
    .filter((r) => r.method === 'GET' && r.match === 'exact')
    .map((r) => r.path)
    .filter((p) => p && !String(p).includes(':') && !SKIP_EXACT.has(p));
  const must = ['/health', '/models', '/config', '/skills', '/sessions', '/agent-plugins'];
  return [...new Set([...must, ...exact])].slice(0, 40);
}

export async function runL1(opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const base = opts.base || apiBase();
  const started = new Date().toISOString();
  const rows = [];

  if (!(await healthOk(base))) {
    const report = {
      layer: 'L1',
      started,
      finished: new Date().toISOString(),
      base,
      ok: false,
      tag: 'env-red',
      note: 'API health not reachable',
      rows: [],
    };
    writeFileSync(path.join(OUT_DIR, 'l1-http.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  for (const p of listGetProbes()) {
    const url = `${base}${p}`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(12_000),
        headers: { accept: 'application/json,*/*' },
      });
      const ok = res.status !== 404 && res.status < 500;
      rows.push({
        id: `GET ${p}`,
        ok,
        status: res.status,
        tag: ok ? 'green' : 'red',
        expect: 'happy',
      });
      console.log(`  ${ok ? 'PASS' : 'FAIL'} GET ${p} ${res.status}`);
    } catch (e) {
      rows.push({
        id: `GET ${p}`,
        ok: false,
        status: 0,
        tag: 'env-red',
        expect: 'happy',
        error: e instanceof Error ? e.message : String(e),
      });
      console.log(`  ENV  GET ${p} ${e instanceof Error ? e.message : e}`);
    }
  }

  // Intentional fail matrix — unknown path: SPA may 200(index) or router 404
  try {
    const res = await fetch(`${base}/__fpv_no_such_route__`, {
      method: 'GET',
      signal: AbortSignal.timeout(8_000),
    });
    const ok = res.status === 404 || res.status === 200;
    rows.push({
      id: 'GET /__fpv_no_such_route__',
      ok,
      status: res.status,
      tag: ok ? 'green' : 'red',
      expect: 'spa_200_or_404',
      note: res.status === 200 ? 'spa_fallback' : null,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} GET unknown → ${res.status} (expect 200|404)`);
  } catch (e) {
    rows.push({
      id: 'GET /__fpv_no_such_route__',
      ok: false,
      tag: 'env-red',
      expect: 'spa_200_or_404',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({}));
    const id = j?.id || j?.sessionId || j?.session?.id;
    const ok = res.ok && Boolean(id);
    rows.push({
      id: 'POST /sessions',
      ok,
      status: res.status,
      tag: ok ? 'green' : 'red',
      expect: 'happy',
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} POST /sessions ${res.status}`);
  } catch (e) {
    rows.push({
      id: 'POST /sessions',
      ok: false,
      tag: 'env-red',
      expect: 'happy',
      error: e instanceof Error ? e.message : String(e),
    });
    console.log(`  ENV  POST /sessions ${e instanceof Error ? e.message : e}`);
  }

  // Attachments without multipart must not succeed (4xx or 5xx both = fail-closed)
  try {
    const res = await fetch(`${base}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    const ok = res.status >= 400;
    rows.push({
      id: 'POST /attachments (no multipart)',
      ok,
      status: res.status,
      tag: ok ? 'green' : 'red',
      expect: 'fail_closed_4xx_or_5xx',
      note: res.status >= 500 ? 'server_error_on_bad_body — prefer 4xx later' : null,
    });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} POST /attachments bare → ${res.status} (expect ≥400)`);
  } catch (e) {
    rows.push({
      id: 'POST /attachments (no multipart)',
      ok: false,
      tag: 'env-red',
      expect: 'fail_closed_4xx_or_5xx',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const critical = rows.filter((r) => r.id === 'GET /health' || r.id === 'POST /sessions');
  const productRed = rows.filter((r) => r.tag === 'red');
  const envRed = rows.filter((r) => r.tag === 'env-red');
  const report = {
    layer: 'L1',
    started,
    finished: new Date().toISOString(),
    base,
    ok: critical.every((r) => r.ok) && productRed.length === 0,
    tag: envRed.length && !critical.every((r) => r.ok) ? 'env-red' : undefined,
    rows,
  };
  writeFileSync(path.join(OUT_DIR, 'l1-http.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMainModule(import.meta.url)) {
  runL1()
    .then((r) => {
      console.log(`=== FPV L1 ok=${r.ok} rows=${r.rows.length} ===`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
