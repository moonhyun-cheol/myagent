/**
 * Simulation: user asks MY Agent to add/use git history tree — tool plane only
 * (same APIs the code agent would call: plugin_* + git_history_tree).
 */
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => join(productRoot, 'core', 'dist', 'agent', name);

function step(title) {
  console.log(`\n── ${title}`);
}
function fail(msg) {
  console.error('SIM FAIL:', msg);
  process.exit(1);
}
function ok(msg) {
  console.log('  ✓', msg);
}

async function load() {
  if (!existsSync(dist('agent-plugin-store.js'))) {
    const b = spawnSync(process.execPath, [join(productRoot, 'tools', 'build.mjs')], {
      cwd: productRoot,
      stdio: 'inherit',
    });
    if (b.status !== 0) fail('build');
  }
  return {
    store: await import(pathToFileURL(dist('agent-plugin-store.js')).href),
    exec: await import(pathToFileURL(dist('agent-tool-execute.js')).href),
    reg: await import(pathToFileURL(dist('agent-tool-registry.js')).href),
    rt: await import(pathToFileURL(dist('run-terminal.js')).href),
  };
}

async function main() {
  const { store, exec, reg, rt } = await load();
  const {
    formatPluginListJson,
    scaffoldAgentPlugin,
    installAgentPlugin,
    installAgentPluginFromTemplate,
    getAgentPluginByToolName,
  } = store;
  const { executeAgentTool } = exec;
  const { getCodeAgentTools } = reg;

  console.log('=== USER (simulated) ===');
  console.log('"git 히스토리 트리를 보고 싶어. 이 기능을 추가해 줘."');

  // B: builtin if product has it
  step('B) Builtin git_history_tree (if already in this version)');
  const hasBuiltin = getCodeAgentTools(productRoot)
    .map((t) => t.function.name)
    .includes('git_history_tree');
  console.log('  catalog has git_history_tree?', hasBuiltin);
  if (hasBuiltin) {
    const doc = JSON.parse(rt.gitHistoryTree(productRoot, { max: 10 }));
    if (!doc.ok || !doc.graph_ascii) fail(JSON.stringify(doc).slice(0, 200));
    ok(`builtin ok commits=${doc.commit_count} head=${doc.head}`);
    console.log('  ', String(doc.graph_ascii).split(/\n/)[0]);
  }

  // A: self-add via plugin (employee PC with no delta)
  step('A) Self-add path: plugin_list → scaffold/hand-write → install confirm → use');
  const cqrRoot = mkdtempSync(join(tmpdir(), 'cqr-sim-hist-'));
  try {
    mkdirSync(join(cqrRoot, 'tools'), { recursive: true });
    cpSync(
      join(productRoot, 'tools', 'plugin-templates'),
      join(cqrRoot, 'tools', 'plugin-templates'),
      { recursive: true },
    );

    const list1 = JSON.parse(formatPluginListJson(cqrRoot));
    if (list1.count !== 0) fail('fresh plugins not empty');
    ok('plugin_list empty');

    const scaffold = JSON.parse(
      scaffoldAgentPlugin({
        id: 'git_hist_tree',
        purpose: 'git history graph',
        risk: 'read',
      }),
    );
    if (!scaffold.ok) fail(JSON.stringify(scaffold));
    ok(`scaffold name=${scaffold.name} (default body is echo — must replace for real graph)`);

    const run_source = `import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root = process.env.CQR_WORKSPACE_ROOT || process.cwd();
if (!existsSync(path.join(root, '.git'))) {
  console.log(JSON.stringify({ ok: false, error: 'not a git repo' }));
  process.exit(0);
}
const g = spawnSync('git', ['log', '--graph', '--oneline', '--decorate', '--max-count=15'], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
console.log(JSON.stringify({
  ok: g.status === 0,
  plugin: 'plugin_git_hist_tree',
  graph_ascii: (g.stdout || g.stderr || '').trim(),
}, null, 2));
`;
    const inst = JSON.parse(
      installAgentPlugin(cqrRoot, {
        id: 'git_hist_tree',
        confirm: true,
        tool_json: {
          name: 'plugin_git_hist_tree',
          description: 'history graph',
          parameters: { type: 'object', properties: {} },
          runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 30000 },
          risk: 'read',
        },
        run_source,
        created_by: 'agent',
      }),
    );
    if (!inst.ok) fail(JSON.stringify(inst));
    ok('plugin_install confirm');

    const res = await executeAgentTool(
      productRoot,
      {
        id: '1',
        type: 'function',
        function: { name: 'plugin_git_hist_tree', arguments: '{}' },
      },
      {},
      { cqrRoot, sessionId: 'sim' },
    );
    const body = JSON.parse(res.output);
    if (!body.ok || !body.graph_ascii) fail(res.output.slice(0, 300));
    ok('installed plugin used on real workspace');
    console.log('  ', body.graph_ascii.split(/\n/)[0]);
  } finally {
    rmSync(cqrRoot, { recursive: true, force: true });
  }

  // A2: template only (best self-add)
  step('A2) Better self-add: template_id=git_history_tree (no hand-written script)');
  const cqr2 = mkdtempSync(join(tmpdir(), 'cqr-sim-hist-tpl-'));
  try {
    mkdirSync(join(cqr2, 'tools'), { recursive: true });
    cpSync(
      join(productRoot, 'tools', 'plugin-templates'),
      join(cqr2, 'tools', 'plugin-templates'),
      { recursive: true },
    );
    if (!existsSync(join(cqr2, 'tools', 'plugin-templates', 'git_history_tree', 'tool.json'))) {
      fail('template missing from product');
    }
    const fromTpl = JSON.parse(
      installAgentPluginFromTemplate(cqr2, {
        template_id: 'git_history_tree',
        confirm: true,
      }),
    );
    if (!fromTpl.ok) fail(JSON.stringify(fromTpl));
    ok('template install');
    const r2 = await executeAgentTool(
      productRoot,
      {
        id: '2',
        type: 'function',
        function: { name: 'plugin_git_history_tree', arguments: '{"max":10}' },
      },
      {},
      { cqrRoot: cqr2, sessionId: 'sim-tpl' },
    );
    const b2 = JSON.parse(r2.output);
    if (!b2.ok || !b2.graph_ascii) fail(r2.output.slice(0, 300));
    ok('template plugin used — PA can add+use without inventing code');
    console.log('  ', String(b2.graph_ascii).split(/\n/)[0]);
  } finally {
    rmSync(cqr2, { recursive: true, force: true });
  }

  step('Verdict');
  console.log(`
  User: "기능 추가 + 히스토리 트리 보고 싶어"
  ├─ If version already has git_history_tree → call builtin (works now).
  └─ Else (gap after deploy) →
       plugin_list → plugin_install confirm template_id=git_history_tree
       → plugin_git_history_tree  → WORKS (simulated).

  Cannot self-patch core on slim PC without delta.
  Scaffold echo alone ≠ feature; template_id path is the reliable self-add.
  Full live LLM loop not simulated (tool plane is).
`);
  console.log('SIM OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
