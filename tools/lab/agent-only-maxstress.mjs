#!/usr/bin/env node
/**
 * Max-stress agent-only project rebuild — multi-skill surface under one agent run.
 * No tools gap-fill. Default workspace: Desktop/CQR_MaxStress_Demo (not AllSkill).
 *
 *   node tools/lab/agent-only-maxstress.mjs
 *   CQR_MAXSTRESS_WS=C:\path\to\ws node tools/lab/agent-only-maxstress.mjs
 *   CQR_MAXSTRESS_VERIFY_ONLY=1 …   # disk + npm test + http smoke only
 *   CQR_MAXSTRESS_HTTP_FALLBACK=1 … # (debug) allow file-read as http ok — default OFF
 *
 * Note: ignores MY_AGENT_DEMO_WS unless CQR_MAXSTRESS_USE_DEMO_WS=1 (pollution guard).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
if (!process.env.MY_AGENT_CODE_OWUI_PROTOCOL) {
  process.env.MY_AGENT_CODE_OWUI_PROTOCOL = 'text';
}
process.env.MY_AGENT_CODE_AUTOPILOT = process.env.MY_AGENT_CODE_AUTOPILOT || '1';

function resolveWorkspace() {
  const max = process.env.CQR_MAXSTRESS_WS?.trim();
  if (max) return max;
  if (process.env.CQR_MAXSTRESS_USE_DEMO_WS === '1' && process.env.MY_AGENT_DEMO_WS?.trim()) {
    return process.env.MY_AGENT_DEMO_WS.trim();
  }
  // Pollution guard: never silently reuse MY_AGENT_DEMO_WS / AllSkill.
  return path.join(process.env.USERPROFILE || '', 'Desktop', 'CQR_MaxStress_Demo');
}

const workspace = resolveWorkspace();
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'agent-only-maxstress-report.json');

const required = [
  'public/index.html',
  'public/styles.css',
  'public/app.js',
  'public/gallery.html',
  'src/lib.js',
  'src/store.js',
  'src/ui.js',
  'data/seed.json',
  'docs/concept-brief.md',
  'docs/market-snapshot.md',
  'docs/acceptance.md',
  'prompts/lookbook.md',
  'prompts/midjourney-pack.md',
  'scripts/serve.mjs',
  'test/smoke.test.js',
  'package.json',
  'README.md',
];

/** Per-path soft requirements (path may implement either monobundle or module split). */
const pathMarkers = {
  'public/index.html': [
    /id=["']brand["']/,
    /id=["']hero-title["']/,
    /id=["']cta-primary["']/,
    /id=["']task-input["']/,
    /id=["']add-btn["']/,
    /id=["']task-list["']/,
    /id=["']concept-note["']/,
    /id=["']market-chip["']/,
  ],
  'public/app.js': [
    /task-list/,
    /add-btn/,
    /localStorage/,
    /cqr-maxstress-v1/,
  ],
  'public/gallery.html': [/id=["']gallery-grid["']/, /id=["']lookbook-ref["']/],
  'src/lib.js': [/version|1\.0\.0-max/],
  'src/store.js': [/export|function|const|loadTasks/i],
  'src/ui.js': [/export|function|render/i],
  'data/seed.json': [/\{[\s\S]*\}/],
  'package.json': [
    /"name"\s*:/,
    /"test"\s*:\s*"node --test test\/smoke\.test\.js"/,
  ],
  'test/smoke.test.js': [/assert|test\(|ok\(/i],
  'scripts/serve.mjs': [
    /createServer|http\.|listen/,
    /import\.meta\.main|pathToFileURL/,
  ],
  'docs/concept-brief.md': [/.{40,}/],
  'docs/market-snapshot.md': [/.{40,}/],
  'docs/acceptance.md': [/Acceptance|클릭|brand/i],
  'prompts/lookbook.md': [/.{30,}/],
  'prompts/midjourney-pack.md': [/.{30,}/],
  'README.md': [/MaxStress|CQR|npm test/i],
};

/** Workspace-wide semantic gates (module split ok). */
const semanticGates = [
  { id: 'storage_key', re: /cqr-maxstress-v1/ },
  { id: 'localStorage', re: /localStorage/ },
  { id: 'version_export', re: /1\.0\.0-max|export\s+function\s+version/ },
  { id: 'brand_id', re: /id=["']brand["']/ },
];

function wipeExceptSeed() {
  if (process.env.CQR_MAXSTRESS_VERIFY_ONLY === '1') {
    if (!existsSync(workspace)) {
      console.error('VERIFY_ONLY but workspace missing:', workspace);
      process.exit(1);
    }
    return;
  }
  // Continue a partial run (stream-safe chunked writes may need >8 turns).
  if (process.env.CQR_MAXSTRESS_NO_WIPE === '1' && existsSync(workspace)) {
    console.log('NO_WIPE=1 — keep existing files, continue missing only');
    if (!existsSync(path.join(workspace, 'SEED.md'))) {
      writeFileSync(
        path.join(workspace, 'SEED.md'),
        `# CQR MaxStress Demo — agent-only seed\n\nBrand: **Studio Line Max**\nStorage key: cqr-maxstress-v1\n`,
        'utf8',
      );
    }
    return;
  }
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  for (const name of readdirSync(workspace)) {
    if (name === 'SEED.md' || name === '.git') continue;
    rmSync(path.join(workspace, name), { recursive: true, force: true });
  }
  writeFileSync(
    path.join(workspace, 'SEED.md'),
    `# CQR MaxStress Demo — agent-only seed

Do not leave SEED only. Implement full tree listed in lab driver required[].
Brand: **Studio Line Max**
Storage key: cqr-maxstress-v1
`,
    'utf8',
  );
}

function filesOf(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesOf(full, base, acc);
    else acc.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return acc;
}

function readBlob() {
  const parts = [];
  for (const rel of filesOf(workspace)) {
    try {
      parts.push(readFileSync(path.join(workspace, rel), 'utf8'));
    } catch {
      /* skip */
    }
  }
  return parts.join('\n');
}

function markerFails() {
  const fails = [];
  for (const [rel, res] of Object.entries(pathMarkers)) {
    const abs = path.join(workspace, rel);
    if (!existsSync(abs)) {
      fails.push(`${rel}: missing`);
      continue;
    }
    const body = readFileSync(abs, 'utf8');
    for (const re of res) {
      if (!re.test(body)) fails.push(`${rel}: /${re.source}/`);
    }
  }
  const blob = readBlob();
  for (const g of semanticGates) {
    if (!g.re.test(blob)) fails.push(`semantic:${g.id}`);
  }
  const publicApp = path.join(workspace, 'public/app.js');
  if (existsSync(publicApp)) {
    const appBody = readFileSync(publicApp, 'utf8');
    if (/(?:from\s*|import\s*\()\s*["']\.\.\/src\//.test(appBody)) {
      fails.push('public/app.js: browser_forbidden_../src_import');
    }
  }
  return fails;
}

async function httpDomSmoke() {
  /** Live bind required. File read ≠ pass (opt-in only: CQR_MAXSTRESS_HTTP_FALLBACK=1). */
  const allowFallback = process.env.CQR_MAXSTRESS_HTTP_FALLBACK === '1';
  const result = {
    ok: false,
    skipped: false,
    note: '',
    brand: false,
    gallery: false,
    healthOk: false,
    bound: false,
    fallbackUsed: false,
  };
  if (!existsSync(path.join(workspace, 'scripts/serve.mjs'))) {
    result.skipped = true;
    result.note = 'no serve.mjs';
    return result;
  }
  const port = 18765 + Math.floor(Math.random() * 200);
  let stderrBuf = '';
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: workspace,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (c) => {
    stderrBuf += String(c);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fetchText = (urlPath) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: urlPath, timeout: 2500 },
        (res) => {
          let d = '';
          res.on('data', (c) => {
            d += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });

  try {
    let lastErr = null;
    let health = null;
    for (let i = 0; i < 8; i++) {
      await wait(i === 0 ? 400 : 250);
      try {
        health = await fetchText('/health');
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!health) {
      result.note = `http_bind_fail (${lastErr instanceof Error ? lastErr.message : String(lastErr)}; stderr=${stderrBuf.slice(0, 200)})`;
      if (allowFallback) {
        const indexBody = readFileSync(path.join(workspace, 'public/index.html'), 'utf8');
        const galBody = readFileSync(path.join(workspace, 'public/gallery.html'), 'utf8');
        result.brand = /id=["']brand["']/.test(indexBody);
        result.gallery = /id=["']gallery-grid["']/.test(galBody);
        result.fallbackUsed = true;
        result.ok = result.brand && result.gallery;
        result.note = `http-fallback-file (${result.note})`;
      }
      return result;
    }
    result.bound = true;
    result.healthOk =
      health.status === 200
      && (/ok\s*:\s*true|"ok"\s*:\s*true/i.test(health.body)
        || /cqr-maxstress-v1/i.test(health.body));
    const idx = await fetchText('/index.html').catch(() => fetchText('/'));
    const gal = await fetchText('/gallery.html');
    const indexBody = idx.body || '';
    const galBody = gal.body || '';
    result.brand = /id=["']brand["']/.test(indexBody);
    result.gallery = /id=["']gallery-grid["']/.test(galBody);
    result.ok = result.healthOk && result.brand && result.gallery;
    result.note = result.ok
      ? `http :${port}`
      : `http_partial :${port} health=${health.status} brand=${result.brand} gallery=${result.gallery}`;
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  return result;
}

wipeExceptSeed();

const verifyOnly = process.env.CQR_MAXSTRESS_VERIFY_ONLY === '1';

const { ProviderStore } = await import(
  pathToFileURL(path.join(root, 'core/dist/providers/provider-store.js')).href
);
const { runCodeAgent } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/code-agent.js')).href
);
const { resolveCodeOwuiProtocolMode, loadHarnessPolicy } = await import(
  pathToFileURL(path.join(root, 'core/dist/providers/harness-policy.js')).href
);
const { looksLikeColdMultiCreate, buildTaskChecklist } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/agent-task-checklist.js')).href
);

const store = new ProviderStore(path.join(root, 'data', 'vault', 'provider-keys.json'), root);
const prefer = process.env.MY_AGENT_OWUI_SMOKE_PROVIDER || 'custom';
let resolved = null;
for (const id of [prefer, 'custom', 'openwebui', 'open_webui', 'ollama']) {
  try {
    const r = store.resolveProvider(id);
    if (r) {
      resolved = { id, ...r };
      break;
    }
  } catch {
    /* next */
  }
}
if (!resolved) {
  writeFileSync(reportPath, JSON.stringify({ ok: false, note: 'no provider' }, null, 2));
  console.error('no provider');
  process.exit(1);
}

const protocol = resolveCodeOwuiProtocolMode();
const harness = loadHarnessPolicy();
const baseUser = `작업 모드: AGENT. Autopilot ON. SEED.md 유지. 빈 Desktop 워크스페이스에 멀티스킬 데모 프로젝트를 한 실행에서 완성.

브랜드: Studio Line Max
목표: CQR skill 표면(web landing, web_dev, concept, market, prompt_master)을 파일로 모두 증거.

## 필수 파일 (전부 write_file, 완료 전 missing 0)

1. public/index.html — full landing + task UI
   ids: brand, hero-title, cta-primary, task-input, add-btn, task-list, concept-note, market-chip
   brand text must include "Studio Line Max"
   Asset hrefs MUST be root-relative under public host: href="/styles.css" script src="/app.js" links href="/gallery.html"
   (NOT /public/... — Playwright serves public/ as web root)
2. public/styles.css — non-generic look (no Inter/Roboto), paper + cobalt accents
3. public/app.js — localStorage key EXACTLY cqr-maxstress-v1; add/toggle/delete tasks on #task-list/#task-input/#add-btn
   Browser-standalone REQUIRED: plain IIFE or self-contained module; DO NOT import ../src/* from public/app.js
   Acceptance: clicking #add-btn with #task-input text MUST append an <li> under #task-list
4. public/gallery.html — MUST contain id="gallery-grid" AND id="lookbook-ref" (literal attributes)
5. src/lib.js — export function version(){ return '1.0.0-max' }
6. src/store.js — load/save helpers using cqr-maxstress-v1
7. src/ui.js — render helpers
8. data/seed.json — { brand, conceptLine, marketLine, lookbookTags[] }
9. docs/concept-brief.md — ≥80 words
10. docs/market-snapshot.md — ≥80 words (do NOT claim pipeline ran)
11. docs/acceptance.md — click path index → add task → gallery
12. prompts/lookbook.md
13. prompts/midjourney-pack.md — 3 variations
14. scripts/serve.mjs — http server on process.env.PORT||18929, project ROOT:
    /health → JSON {app:'cqr-maxstress-v1',id:'brand',version:'1.0.0-max',ok:true}
    / and /index.html → public/index.html
    /gallery.html → public/gallery.html
    /styles.css /app.js → public/*
    also serve /src/* /data/* /prompts/* as static files
    WINDOWS-SAFE entry (REQUIRED — naive file:// + process.argv[1] string compare NEVER binds on Windows):
      import { pathToFileURL } from 'node:url';
      // Prefer: if (import.meta.main) { ...listen... }
      // Or: if (import.meta.url === pathToFileURL(process.argv[1]).href) { ...listen(PORT,'127.0.0.1')... }
      // FORBIDDEN: if (import.meta.url === \`file://\${process.argv[1]}\`)
15. test/smoke.test.js — assert version / package / brand; ESM only (no require) if "type":"module"
16. package.json — name can be cqr-maxstress-demo or cqr-maxstress-v1
    scripts.test EXACTLY "node --test test/smoke.test.js" (FORBIDDEN: "node --test test/" directory arg breaks Node 22+)
    scripts.start "node scripts/serve.mjs"
17. README.md — MaxStress / npm test

규칙:
- 매 턴 write_file ≤2개 (OWUI 스트림 안정). Autopilot로 missing 0까지 이어서.
- TOOL_CALL / WIRING_SMOKE 유저 답 금지.
- Exit Gate: missing 0 + npm test exit 0 + live HTTP /health 200 (file fallback ≠ pass).
- First: write_file public/index.html then continue remaining paths across steps.
- Do NOT query_repo_map / search_embeddings on empty greenfield.`;

const maxTurns = Number(process.env.MY_AGENT_DEMO_AGENT_TURNS || 20);
let lastResult = null;
const allMutated = new Set();
const allStatuses = [];
const turnSummaries = [];
const t0 = Date.now();

const preCheck = buildTaskChecklist(baseUser);
console.log(
  JSON.stringify(
    {
      workspace,
      provider: resolved.id,
      model: resolved.modelId,
      codeOwuiProtocol: protocol,
      probeTimeoutMs: harness.owuiProbeTimeoutMs,
      mode: 'maxstress',
      coldCreate: looksLikeColdMultiCreate(baseUser),
      requireRetrieval: preCheck.requireRetrieval,
      checklistLabels: preCheck.labels,
    },
    null,
    2,
  ),
);

if (verifyOnly) {
  console.log('VERIFY_ONLY — skip agent; recheck disk + npm test + http');
  for (const f of filesOf(workspace)) allMutated.add(f);
  turnSummaries.push({ turn: 0, steps: 0, verifyOnly: true });
} else {
  for (let turn = 1; turn <= maxTurns; turn++) {
    const missingBefore = required.filter((f) => !existsSync(path.join(workspace, f)));
    const marksBefore = markerFails();
    let npmFailHint = '';
    let httpFailHint = '';
    if (turn > 1 && missingBefore.length === 0 && marksBefore.length === 0) {
      // Soft-check npm + live HTTP before stop — keep OWUI repairing until both green.
      let npmOk = true;
      if (existsSync(path.join(workspace, 'package.json'))) {
        const soft = spawnSync('npm', ['test'], {
          cwd: workspace,
          encoding: 'utf8',
          shell: true,
          timeout: 60_000,
        });
        npmOk = soft.status === 0;
        if (!npmOk) npmFailHint = `${soft.stdout || ''}\n${soft.stderr || ''}`.slice(0, 600);
      }
      if (npmOk) {
        const softHttp = await httpDomSmoke();
        if (softHttp.ok) break;
        httpFailHint = softHttp.note || 'http_bind_fail';
      }
    }

    const resume = process.env.CQR_MAXSTRESS_NO_WIPE === '1' || turn > 1;
    let userMessage = baseUser;
    if (
      resume
      && (missingBefore.length || marksBefore.length || npmFailHint || httpFailHint || turn > 1)
    ) {
      const parts = ['이어서 AGENT Autopilot. Fix ONLY remaining gaps. Prefer write_file FULL rewrite; avoid edit_file.'];
      if (missingBefore.length) {
        parts.push(
          `Still MISSING paths:\n${missingBefore.map((m) => `- ${m}`).join('\n')}`,
        );
      }
      if (marksBefore.length) {
        parts.push(
          `MARKER FAILS (must edit these files now):\n${marksBefore.map((m) => `- ${m}`).join('\n')}`,
        );
        parts.push(
          'Hard rules: public/gallery.html needs literal id="gallery-grid" and id="lookbook-ref"; public/app.js must include localStorage + key cqr-maxstress-v1, append <li> on #add-btn, and MUST NOT import ../src/*.',
        );
        if (marksBefore.some((m) => /serve\.mjs/i.test(m))) {
          parts.push(
            'scripts/serve.mjs: DO NOT edit_file. write_file FULL rewrite with /health JSON ok:true, listen(PORT,\'127.0.0.1\'), and import.meta.main || pathToFileURL(process.argv[1]).href guard.',
          );
        }
      }
      if (npmFailHint) {
        parts.push(
          `npm test FAILED — use write_file, not edit_file.\n1) package.json scripts.test MUST be exactly "node --test test/smoke.test.js" (never "node --test test/").\n2) test/smoke.test.js must be ESM:\nimport assert from 'node:assert/strict';\nimport { describe, it } from 'node:test';\nimport { version } from '../src/lib.js';\ndescribe('smoke', () => { it('v', () => assert.equal(version(), '1.0.0-max')); });\nNO require().\n\nnpm stderr:\n${npmFailHint}`,
        );
      }
      if (httpFailHint) {
        parts.push(
          `LIVE HTTP FAILED (${httpFailHint}). rewrite scripts/serve.mjs with write_file.\nMust listen on process.env.PORT||18929 at 127.0.0.1.\nEntry guard MUST be Windows-safe:\n  import { pathToFileURL } from 'node:url';\n  if (import.meta.main || import.meta.url === pathToFileURL(process.argv[1]).href) {\n    createServer().listen(PORT, '127.0.0.1', ...)\n  }\nFORBIDDEN: \`file://\${process.argv[1]}\` string compare (never binds on Windows).\nMap /health JSON ok:true and /index.html,/gallery.html from public/.`,
        );
      }
      parts.push('Ensure semantic: cqr-maxstress-v1, id=brand, version 1.0.0-max.');
      userMessage = parts.join('\n');
    }

    console.log(
      `\n=== maxstress turn ${turn}/${maxTurns} missing=${missingBefore.length} markers=${marksBefore.length} npmHint=${Boolean(npmFailHint)} httpHint=${Boolean(httpFailHint)} ===`,
    );
    try {
      lastResult = await runCodeAgent({
        workspaceRoot: workspace,
        userMessage,
        systemPrompt:
          'MY Agent code agent maxstress. Mutate every missing path. write_file bursts. No retrieval-first on empty scaffold. Max 20 steps.',
        workspaceContext: `maxstress desktop ${workspace}`,
        history: [],
        providerId: resolved.id,
        modelId: resolved.modelId || undefined,
        providerStore: store,
        nasWriteConsent: false,
        cqrRoot: root,
        sessionId: `agent_only_max_${Date.now()}_t${turn}`,
        autopilot: true,
        maxSteps: 20,
        forceToolPack: 'web_dev',
        onToolApproval: async () => true,
        onStatus: (s) => {
          const line = String(s).slice(0, 220);
          allStatuses.push(`t${turn}:${line}`);
          console.log(' ', line);
        },
      });
    } catch (e) {
      lastResult = {
        content: e instanceof Error ? e.message : String(e),
        steps: 0,
        mutatedPaths: [],
      };
      allStatuses.push(`t${turn}:throw: ${lastResult.content}`);
    }
    for (const p of lastResult?.mutatedPaths || []) allMutated.add(p);
    const miss = required.filter((f) => !existsSync(path.join(workspace, f)));
    const marks = markerFails();
    turnSummaries.push({
      turn,
      steps: lastResult?.steps ?? 0,
      mutated: lastResult?.mutatedPaths || [],
      stillMissing: miss.length,
      stillMarkers: marks.length,
    });
    console.log(
      `turn ${turn} done steps=${lastResult?.steps} mutated=${(lastResult?.mutatedPaths || []).join(',') || '(none)'} stillMissing=${miss.length} stillMarkers=${marks.length}`,
    );
    if (miss.length === 0 && marks.length === 0) {
      let npmOk = true;
      if (existsSync(path.join(workspace, 'package.json'))) {
        const soft = spawnSync('npm', ['test'], {
          cwd: workspace,
          encoding: 'utf8',
          shell: true,
          timeout: 60_000,
        });
        npmOk = soft.status === 0;
        if (!npmOk) console.log(`npm still failing after turn ${turn}; continue repair`);
      }
      if (npmOk) {
        const softHttp = await httpDomSmoke();
        if (softHttp.ok) break;
        console.log(`http still failing after turn ${turn}: ${softHttp.note}; continue repair`);
      }
    }
  }
}

const files = filesOf(workspace);
const missing = required.filter((f) => !existsSync(path.join(workspace, f)));
const markFails = markerFails();
const mutated = [...allMutated];

let npmTest = { ok: false, code: null, out: '' };
if (existsSync(path.join(workspace, 'package.json'))) {
  const r = spawnSync('npm', ['test'], {
    cwd: workspace,
    encoding: 'utf8',
    shell: true,
    timeout: 60_000,
  });
  npmTest = {
    ok: r.status === 0,
    code: r.status,
    out: `${r.stdout || ''}\n${r.stderr || ''}`.slice(0, 2000),
  };
  console.log(`npm test exit=${r.status}`);
}

const checkFails = [];
for (const rel of ['public/app.js', 'src/lib.js', 'src/store.js', 'src/ui.js', 'scripts/serve.mjs']) {
  const abs = path.join(workspace, rel);
  if (!existsSync(abs)) continue;
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status !== 0) checkFails.push(`${rel}: ${(r.stderr || r.stdout || '').slice(0, 120)}`);
}

const content = String(lastResult?.content || '');
const contentLeak =
  /TOOL_CALL\s*:/i.test(content) || /WIRING_SMOKE/i.test(content) || /ANSWER_SYNTH_/i.test(content);
const nextActionLeak = /다음\s*조치\s*[:：]/i.test(content);
const retrievalTax = allStatuses.some((s) => /Retrieval first/i.test(s));

const httpSmoke = await httpDomSmoke();
console.log('httpDomSmoke', JSON.stringify(httpSmoke));

const ok =
  missing.length === 0
  && markFails.length === 0
  && mutated.length > 0
  && npmTest.ok
  && checkFails.length === 0
  && !contentLeak
  && (!nextActionLeak || verifyOnly)
  && httpSmoke.ok
  && (verifyOnly || !retrievalTax);

const report = {
  ok,
  ms: Date.now() - t0,
  protocol,
  probeTimeoutMs: harness.owuiProbeTimeoutMs,
  provider: resolved.id,
  model: resolved.modelId,
  workspace,
  steps_last: lastResult?.steps,
  turns: turnSummaries,
  mutated,
  missing,
  markerFails: markFails,
  checkFails,
  npmTest: { ok: npmTest.ok, code: npmTest.code, out: npmTest.out.slice(0, 800) },
  contentLeak,
  nextActionLeak,
  retrievalTax,
  requireRetrievalExpected: preCheck.requireRetrieval,
  coldCreate: looksLikeColdMultiCreate(baseUser),
  httpSmoke,
  content: content.slice(0, 800),
  files,
  statuses: allStatuses.slice(0, 160),
  autopilotForceCount: allStatuses.filter((s) => /Autopilot —|다음 조치.*강제/i.test(s)).length,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok,
      ms: report.ms,
      missing,
      markerFails: markFails.length,
      npmTestOk: npmTest.ok,
      contentLeak,
      nextActionLeak,
      retrievalTax,
      httpOk: httpSmoke.ok,
      httpBound: httpSmoke.bound,
      httpHealthOk: httpSmoke.healthOk,
      httpFallbackUsed: httpSmoke.fallbackUsed,
      mutated: mutated.length,
      report: reportPath,
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
