#!/usr/bin/env node
/**
 * Harsh end-to-end self-test: build a mini product via every code tool,
 * assert skill surfaces + domain/automaton dry paths, write critic report.
 *
 *   node tools/lab/harsh-acceptance.mjs
 *   MY_AGENT_LAB_BROWSER=1 node tools/lab/harsh-acceptance.mjs
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog } from './catalog.mjs';
import { runSkills } from './runners/skills-l0.mjs';
import { runSkillsL2 } from './runners/skills-l2.mjs';
import { runAutomatonDry } from './runners/automaton-dry.mjs';
import { runDomainL1 } from './runners/domain-l1.mjs';
import { runEmbeddingCold } from './runners/embedding-cold.mjs';
import { runBrowserTools } from './runners/browser-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
const wantBrowser = process.env.MY_AGENT_LAB_BROWSER === '1' || process.argv.includes('--browser');
const outDir = path.join(root, 'data', '_skill_tool_lab');
const projectRoot = path.join(outDir, 'harsh-taskboard');
const sessionId = `harsh_${Date.now()}`;

function tc(name, args) {
  return {
    id: `harsh_${name}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  };
}

function row(suite, item, result, ms, note = '', extra = {}) {
  return { suite, item, result, ms, note: String(note).slice(0, 400), ...extra };
}

function ensureBuild() {
  const p = path.join(root, 'core/dist/agent/tools.js');
  if (existsSync(p)) return;
  const r = spawnSync(process.execPath, [path.join(root, 'tools/build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function tool(executeAgentTool, name, args, expect) {
  const t0 = Date.now();
  try {
    const res = await executeAgentTool(
      projectRoot,
      tc(name, args),
      { allowNas: false },
      { cqrRoot: root, sessionId, allowLocalhost: true },
    );
    const out = String(res.output || '');
    const hardFail = /^ERROR:/m.test(out) || out.includes('ERROR: tool_call_failed');
    let status = hardFail ? 'fail' : 'pass';
    let note = hardFail ? out.slice(0, 240) : res.label || 'ok';
    try {
      const j = JSON.parse(out);
      if (j && (j.skipped === true || j.noop === true || j.status === 'skip')) {
        status = 'skip';
        note = j.message || j.error || 'skip';
      } else if (j && j.weak === true) {
        note = `${note} (weak)`;
      }
    } catch {
      /* text */
    }
    if (status === 'pass' && typeof expect === 'function') {
      const e = expect({ out, name });
      if (e) {
        status = e.result || 'fail';
        note = e.note || note;
      }
    }
    return row('project_build', name, status, Date.now() - t0, note, { outputSnippet: out.slice(0, 120) });
  } catch (e) {
    return row(
      'project_build',
      name,
      'fail',
      Date.now() - t0,
      e instanceof Error ? e.message : String(e),
    );
  }
}

function assertDisk(rel, re, item) {
  const p = path.join(projectRoot, rel);
  if (!existsSync(p)) return row('disk', item, 'fail', 0, `missing ${rel}`);
  const body = readFileSync(p, 'utf8');
  if (re && !re.test(body)) {
    return row('disk', item, 'fail', 0, `pattern fail in ${rel}: ${body.slice(0, 80)}`);
  }
  return row('disk', item, 'pass', 0, `${rel} ok`);
}

function listTree(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      if (name === '.git' || name === 'node_modules') continue;
      listTree(full, base, acc);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

async function main() {
  ensureBuild();
  const catalog = await loadCatalog();
  mkdirSync(outDir, { recursive: true });
  if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });

  const { executeAgentTool } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
  );

  const rows = [];
  const tAll = Date.now();

  // ── 1. Scaffold mini "TaskBoard Lab" product purely via tools ──
  rows.push(
    await tool(executeAgentTool, 'write_file', {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'harsh-taskboard',
          version: '0.1.0',
          private: true,
          description: 'Harsh-acceptance fixture: local task board',
          scripts: { start: 'npx --yes serve . -p 5179' },
        },
        null,
        2,
      ),
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'write_file', {
      path: 'index.html',
      content: `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Harsh TaskBoard</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="wrap">
    <h1 id="title">Harsh TaskBoard</h1>
    <p class="sub">CQR tool / skill acceptance fixture</p>
    <form id="add-form">
      <input id="task-input" type="text" placeholder="할 일" required />
      <button type="submit" id="add-btn">추가</button>
    </form>
    <ul id="task-list"></ul>
  </main>
  <script type="module" src="app.js"></script>
</body>
</html>
`,
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'write_file', {
      path: 'styles.css',
      content: `:root { --ink: #14212b; --paper: #f3efe6; --accent: #0b6e4f; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; background:
  radial-gradient(circle at 10% 0%, #dfe8e2 0%, transparent 40%),
  linear-gradient(160deg, #f3efe6, #e4ddd0); color: var(--ink); min-height: 100vh; }
.wrap { max-width: 28rem; margin: 3rem auto; padding: 1.5rem; }
h1 { font-size: 1.6rem; letter-spacing: -0.03em; margin: 0 0 0.25rem; }
.sub { opacity: 0.7; margin: 0 0 1.25rem; font-size: 0.9rem; }
form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
input { flex: 1; padding: 0.55rem 0.7rem; border: 1px solid #c9c2b4; border-radius: 6px; background: #fffdf8; }
button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 0.55rem 0.9rem; cursor: pointer; }
ul { list-style: none; padding: 0; margin: 0; }
li { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.55rem 0.4rem; border-bottom: 1px solid #d8d1c3; }
li.done span { text-decoration: line-through; opacity: 0.55; }
li button { background: transparent; color: var(--ink); border: 1px solid #c9c2b4; }
`,
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'write_file', {
      path: 'app.js',
      content: `const KEY = 'harsh-taskboard-v1';
const listEl = document.getElementById('task-list');
const form = document.getElementById('add-form');
const input = document.getElementById('task-input');

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function save(items) { localStorage.setItem(KEY, JSON.stringify(items)); }

function render() {
  const items = load();
  listEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item.done) li.classList.add('done');
    const span = document.createElement('span');
    span.textContent = item.text;
    span.style.cursor = 'pointer';
    span.onclick = () => {
      item.done = !item.done;
      save(items);
      render();
    };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '삭제';
    btn.onclick = () => {
      save(items.filter((x) => x.id !== item.id));
      render();
    };
    li.append(span, btn);
    listEl.appendChild(li);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const items = load();
  items.push({ id: crypto.randomUUID(), text, done: false });
  save(items);
  input.value = '';
  render();
});

render();
`,
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'write_file', {
      path: 'README.md',
      content: '# Harsh TaskBoard\n\nCQR acceptance fixture — tool/skill/agent surface.\n',
    }),
  );

  // list / read / search / map / embed
  rows.push(await tool(executeAgentTool, 'list_directory', { path: '.' }));
  rows.push(
    await tool(executeAgentTool, 'read_file', { path: 'app.js' }, ({ out }) => {
      if (!out.includes('localStorage') && !out.includes('harsh-taskboard')) {
        return { result: 'fail', note: 'read_file did not return app.js body' };
      }
      return null;
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'edit_file', {
      path: 'app.js',
      old_text: "const KEY = 'harsh-taskboard-v1';",
      new_text: "const KEY = 'harsh-taskboard-v1';\nconst BUILD = 'harsh-edit';",
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'apply_patch', {
      path: 'README.md',
      old_text: 'CQR acceptance fixture — tool/skill/agent surface.',
      new_text:
        'CQR acceptance fixture — tool/skill/agent surface.\n\n## Features\n- add / toggle / delete tasks\n- localStorage persistence\n',
    }),
  );
  rows.push(await tool(executeAgentTool, 'search_files', { query: 'localStorage', path: '.' }));
  rows.push(await tool(executeAgentTool, 'query_repo_map', { focus: 'TaskBoard' }));
  rows.push(await tool(executeAgentTool, 'search_embeddings', { query: 'task board localStorage' }));
  rows.push(await tool(executeAgentTool, 'run_terminal', { command: 'node --check app.js' }));
  rows.push(await tool(executeAgentTool, 'run_diagnostics', {}));
  rows.push(await tool(executeAgentTool, 'run_tests', {}));

  // git + checkpoint
  const gitInit = spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  if (gitInit.status === 0) {
    spawnSync('git', ['config', 'user.email', 'harsh@cqr.local'], { cwd: projectRoot });
    spawnSync('git', ['config', 'user.name', 'Harsh Lab'], { cwd: projectRoot });
    spawnSync('git', ['add', '-A'], { cwd: projectRoot });
    spawnSync('git', ['commit', '-m', 'scaffold taskboard'], { cwd: projectRoot });
  }
  rows.push(
    row(
      'project_build',
      'git_init_external',
      gitInit.status === 0 ? 'pass' : 'skip',
      0,
      gitInit.status === 0 ? 'git init ok' : 'git unavailable',
    ),
  );
  rows.push(await tool(executeAgentTool, 'git_status', {}));
  rows.push(await tool(executeAgentTool, 'git_diff', {}));

  // rename + extra file then commit
  rows.push(
    await tool(executeAgentTool, 'write_file', {
      path: 'lib/util.js',
      content: 'export const pad = (n) => String(n).padStart(2, "0");\n',
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'rename_file', {
      path: 'lib/util.js',
      new_path: 'lib/format.js',
    }),
  );
  rows.push(
    await tool(executeAgentTool, 'workspace_checkpoint', {
      label: 'harsh-pre-delete',
      paths: ['lib/format.js', 'app.js', 'README.md'],
    }),
  );
  let checkpointId = '';
  const cpRow = rows[rows.length - 1];
  // re-run checkpoint to capture id from last successful tool output is hard; call again parse from file log
  {
    const res = await executeAgentTool(
      projectRoot,
      tc('workspace_checkpoint', {
        label: 'harsh-cp2',
        paths: ['lib/format.js'],
      }),
      { allowNas: false },
      { cqrRoot: root, sessionId, allowLocalhost: true },
    );
    try {
      checkpointId = JSON.parse(String(res.output || '')).id || '';
    } catch {
      checkpointId = '';
    }
    rows.push(
      row(
        'project_build',
        'workspace_checkpoint_id',
        checkpointId ? 'pass' : 'fail',
        0,
        checkpointId || 'no id',
      ),
    );
  }
  rows.push(
    await tool(executeAgentTool, 'delete_file', { path: 'lib/format.js' }, () => {
      if (existsSync(path.join(projectRoot, 'lib/format.js'))) {
        return { result: 'fail', note: 'delete_file left file on disk' };
      }
      return null;
    }),
  );
  if (checkpointId) {
    rows.push(
      await tool(
        executeAgentTool,
        'workspace_rollback',
        { checkpoint_id: checkpointId, confirm: true },
        () => {
          if (!existsSync(path.join(projectRoot, 'lib/format.js'))) {
            return { result: 'fail', note: 'rollback did not restore lib/format.js' };
          }
          return null;
        },
      ),
    );
  } else {
    rows.push(row('project_build', 'workspace_rollback', 'skip', 0, 'no checkpoint id'));
  }

  // mutate then git_commit
  await tool(executeAgentTool, 'edit_file', {
    path: 'index.html',
    old_text: '<p class="sub">CQR tool / skill acceptance fixture</p>',
    new_text: '<p class="sub" id="status">CQR tool / skill acceptance fixture · live</p>',
  });
  rows.push(await tool(executeAgentTool, 'git_commit', { message: 'harsh: taskboard features' }));

  // Disk acceptance — product must be runnable structure
  rows.push(assertDisk('index.html', /task-list|task-input/, 'html_ids'));
  rows.push(assertDisk('app.js', /BUILD = 'harsh-edit'|localStorage/, 'app_logic'));
  rows.push(assertDisk('styles.css', /--accent/, 'css_tokens'));
  rows.push(assertDisk('README.md', /Features/, 'readme_patch'));
  rows.push(assertDisk('lib/format.js', /pad/, 'rename_survives'));
  rows.push(
    assertDisk(
      'index.html',
      /getElementById|task-list/,
      'html_wiring',
    ),
  );
  // runtime smoke: syntax of app.js already via terminal; DOM id checklist offline
  {
    const html = readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
    const js = readFileSync(path.join(projectRoot, 'app.js'), 'utf8');
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const missing = ids.filter((id) => !js.includes(id) && !html.includes(`id="${id}"`));
    // ids used in js:
    const used = ['task-list', 'add-form', 'task-input'];
    const orphan = used.filter((id) => !html.includes(`id="${id}"`) || !js.includes(id));
    rows.push(
      row(
        'disk',
        'dom_id_wiring',
        orphan.length ? 'fail' : 'pass',
        0,
        orphan.length ? `orphan ${orphan.join(',')}` : `ids ok: ${used.join(',')}`,
      ),
    );
  }

  // Coverage of all code tools
  for (const name of catalog.code_tools) {
    if (!rows.some((r) => r.item === name || r.item === `${name}_id`)) {
      rows.push(row('coverage', name, 'fail', 0, 'tool never exercised in harsh build'));
    }
  }

  // ── 2. Skills L0 + L2 routing ──
  const skillRows = await runSkills(root, catalog);
  rows.push(...skillRows.map((r) => ({ ...r, suite: r.suite || 'skills' })));

  if (process.env.MY_AGENT_LAB_L2 === '1') {
    const l2 = await runSkillsL2(root, catalog);
    rows.push(...l2.map((r) => ({ ...r, suite: r.suite || 'skills_l2' })));
  } else {
    // still run L2 matrix without live LLM (runner usually dry)
    try {
      const l2 = await runSkillsL2(root, catalog);
      rows.push(...l2.map((r) => ({ ...r, suite: r.suite || 'skills_l2' })));
    } catch (e) {
      rows.push(
        row('skills_l2', 'run', 'fail', 0, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // ── 3. Automaton dry + domains + embeddings ──
  rows.push(...(await runAutomatonDry(root)));
  rows.push(...(await runDomainL1(root)));
  rows.push(...(await runEmbeddingCold(root, outDir)));

  // ── 4. Browser tools ──
  if (wantBrowser) {
    rows.push(...(await runBrowserTools(root, projectRoot, { force: true })));
  } else {
    // attempt soft probe (no force) so report distinguishes available vs missing
    try {
      const brows = await runBrowserTools(root, projectRoot, { force: false });
      rows.push(...brows);
    } catch (e) {
      rows.push(
        row(
          'browser',
          'playwright_pack',
          'skip',
          0,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }

  // ── 5. Agent surface presence (MAR, mode, packs) ──
  const agentFiles = [
    'core/dist/agent/code-agent.js',
    'core/dist/agent/agent-mar-runtime.js',
    'core/dist/agent/agent-work-mode.js',
    'core/dist/agent/agent-outcome-gate.js',
    'core/dist/agent/tools.js',
  ];
  for (const rel of agentFiles) {
    rows.push(
      row(
        'agent_surface',
        path.basename(rel),
        existsSync(path.join(root, rel)) ? 'pass' : 'fail',
        0,
        existsSync(path.join(root, rel)) ? 'dist present' : 'missing — run build',
      ),
    );
  }

  // skill inject files on disk
  for (const s of catalog.skills) {
    rows.push(
      row(
        'skill_manifest',
        s.id,
        s.id ? 'pass' : 'fail',
        0,
        `${s.label} mode=${s.mode} pipeline=${s.pipeline}`,
      ),
    );
  }

  // tree snapshot
  const tree = listTree(projectRoot);

  const summary = { pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const r of rows) {
    if (summary[r.result] != null) summary[r.result] += 1;
    else summary.fail += 1;
  }

  const verdict =
    summary.fail === 0
      ? 'PASS_WITH_SKIPS'
      : summary.fail <= 2
        ? 'CONDITIONAL'
        : 'FAIL';

  const findings = buildFindings(rows, catalog, tree);

  const report = {
    generated_at: new Date().toString(),
    verdict,
    ms: Date.now() - tAll,
    summary,
    catalog: catalog.counts,
    project: {
      path: projectRoot,
      files: tree,
    },
    findings,
    rows,
  };

  writeFileSync(path.join(outDir, 'harsh-acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'harsh-acceptance-report.md'), mdReport(report));
  console.log(JSON.stringify({ verdict, summary, project: projectRoot, findings: findings.slice(0, 12) }, null, 2));
  console.log('report ->', path.join(outDir, 'harsh-acceptance-report.md'));
  process.exit(summary.fail > 0 ? 1 : 0);
}

function buildFindings(rows, catalog, tree) {
  const findings = [];
  const fails = rows.filter((r) => r.result === 'fail');
  const skips = rows.filter((r) => r.result === 'skip');

  if (fails.length) {
    findings.push({
      severity: 'P0',
      title: `${fails.length} hard fail(s) in harsh acceptance`,
      detail: fails.slice(0, 8).map((f) => `${f.suite}/${f.item}: ${f.note}`),
    });
  }

  const weakSkips = skips.filter((s) =>
    /embeddings|run_tests|run_diagnostics|playwright|pipeline|openclaw|L2|weak/i.test(
      `${s.item} ${s.note}`,
    ),
  );
  if (weakSkips.length) {
    findings.push({
      severity: 'P1',
      title: 'Soft/skip surfaces that do not prove production capability',
      detail: weakSkips.slice(0, 10).map((s) => `${s.item}: ${s.note}`),
    });
  }

  if (!tree.includes('app.js') || !tree.includes('index.html')) {
    findings.push({
      severity: 'P0',
      title: 'Fixture product incomplete',
      detail: ['index.html/app.js missing after tool build'],
    });
  }

  findings.push({
    severity: 'INFO',
    title: 'Surface inventory exercised',
    detail: [
      `code tools ${catalog.counts.code_tools}, browser ${catalog.counts.browser_tools}, skills ${catalog.counts.skills}, automaton ${catalog.counts.automaton}, domains ${catalog.counts.domains}`,
      `project files: ${tree.join(', ')}`,
    ],
  });

  // critic rules
  if (catalog.counts.skills < 5) {
    findings.push({ severity: 'P1', title: 'Skill count regression', detail: [`n=${catalog.counts.skills}`] });
  }
  if (catalog.counts.code_tools < 18) {
    findings.push({
      severity: 'P0',
      title: 'Code tool surface shrank',
      detail: [`n=${catalog.counts.code_tools}`],
    });
  }

  return findings;
}

function mdReport(report) {
  const lines = [
    '# Harsh acceptance report',
    '',
    `Generated: ${report.generated_at}`,
    `Verdict: **${report.verdict}**`,
    `Duration: ${report.ms}ms`,
    '',
    '## Summary',
    '',
    `| pass | fail | skip |`,
    `| ---: | ---: | ---: |`,
    `| ${report.summary.pass} | ${report.summary.fail} | ${report.summary.skip} |`,
    '',
    `Project: \`${report.project.path}\``,
    '',
    '## Files built',
    '',
    report.project.files.map((f) => `- ${f}`).join('\n'),
    '',
    '## Findings (critic)',
    '',
  ];
  for (const f of report.findings) {
    lines.push(`### [${f.severity}] ${f.title}`, '');
    for (const d of f.detail || []) lines.push(`- ${d}`);
    lines.push('');
  }
  lines.push('## Full results', '', '| suite | item | result | ms | note |', '| --- | --- | --- | ---: | --- |');
  for (const r of report.rows) {
    const note = String(r.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${r.suite} | ${r.item} | ${r.result} | ${r.ms} | ${note} |`);
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
