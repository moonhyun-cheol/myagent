/**
 * Continuous multi-addon / multi-program plugin loop.
 * Install+invoke every ship template + hand-written addons across many rounds.
 *
 *   node tools/verify-plugin-addons-loop.mjs
 *   MY_AGENT_PLUGIN_LOOP_ROUNDS=5
 *   MY_AGENT_PLUGIN_LOOP_LIVE=1
 */
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  cpSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = Math.min(
  Math.max(Number(process.env.MY_AGENT_PLUGIN_LOOP_ROUNDS) || 5, 1),
  20,
);
const liveEvery = process.env.MY_AGENT_PLUGIN_LOOP_LIVE === '1';
const t0 = Date.now();

/** @type {{ round: number, id: string, ok: boolean|null, detail: string }[]} */
const log = [];
let fails = 0;

function record(round, id, ok, detail = '') {
  log.push({ round, id, ok, detail });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'KNOWN';
  console.log(`  ${mark} r${round} ${id}${detail ? ` — ${detail}` : ''}`);
  if (ok === false) fails += 1;
}

function dist(p) {
  return join(root, 'core', 'dist', p);
}

function ensureBuild() {
  if (existsSync(dist('agent/agent-plugin-store.js'))) return true;
  return (
    spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], {
      cwd: root,
      stdio: 'inherit',
    }).status === 0
  );
}

async function loadStore() {
  ensureBuild();
  const ts = `?t=${Date.now()}`;
  return {
    store: await import(pathToFileURL(dist('agent/agent-plugin-store.js')).href + ts),
    exec: await import(pathToFileURL(dist('agent/agent-tool-execute.js')).href + ts),
    runner: await import(pathToFileURL(dist('agent/agent-plugin-runner.js')).href + ts),
    reg: await import(pathToFileURL(dist('agent/agent-tool-registry.js')).href + ts),
  };
}

function stage() {
  const cqrRoot = mkdtempSync(join(tmpdir(), 'cqr-addons-'));
  mkdirSync(join(cqrRoot, 'tools'), { recursive: true });
  mkdirSync(join(cqrRoot, 'data', 'agent-plugins'), { recursive: true });
  cpSync(join(root, 'tools', 'plugin-templates'), join(cqrRoot, 'tools', 'plugin-templates'), {
    recursive: true,
  });
  const workspace = join(cqrRoot, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# addon-loop\n', 'utf8');
  writeFileSync(
    join(workspace, 'sample.json'),
    JSON.stringify({ name: 'addon-loop', version: 1, features: ['a', 'b'] }, null, 2),
    'utf8',
  );
  writeFileSync(join(workspace, 'app.js'), 'export const n=1;\n', 'utf8');
  spawnSync('git', ['init'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'addons@cqr.local'], {
    cwd: workspace,
    windowsHide: true,
  });
  spawnSync('git', ['config', 'user.name', 'Addons'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['add', '-A'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['commit', '-m', 'seed'], { cwd: workspace, windowsHide: true });
  return { cqrRoot, workspace };
}

/** Shipped templates → expected tool name + invoke args + ok predicate */
const TEMPLATE_MATRIX = [
  {
    id: 'demo_echo',
    tool: 'plugin_demo_echo',
    args: { message: 'matrix-echo' },
    check: (o) => o.ok === true && o.message === 'matrix-echo',
  },
  {
    id: 'git_history_tree',
    tool: 'plugin_git_history_tree',
    args: { max: 5 },
    check: (o) => o.ok === true && Boolean(o.graph_ascii),
  },
  {
    id: 'vcs_tree_brief',
    tool: 'plugin_vcs_tree_brief',
    args: {},
    check: (o) =>
      Boolean(o && o.ok === true && (o.branch || o.head || o.dirty != null)),
  },
  {
    id: 'workspace_ls',
    tool: 'plugin_workspace_ls',
    args: { path: '.', max: 20 },
    check: (o) => o.ok === true && Array.isArray(o.entries) && o.entries.length > 0,
  },
  {
    id: 'env_probe',
    tool: 'plugin_env_probe',
    args: {},
    check: (o) => o.ok === true && /^v\d/.test(String(o.node || '')),
  },
  {
    id: 'file_stat',
    tool: 'plugin_file_stat',
    args: { path: 'README.md' },
    check: (o) => o.ok === true && o.is_file === true && typeof o.size === 'number',
  },
  {
    id: 'json_read',
    tool: 'plugin_json_read',
    args: { path: 'sample.json' },
    check: (o) => o.ok === true && Array.isArray(o.top_keys) && o.top_keys.includes('name'),
  },
];

const CUSTOM_ADDONS = [
  {
    id: 'calc_sum',
    name: 'plugin_calc_sum',
    risk: 'read',
    args: { a: 2, b: 40 },
    run_source: `import { readFileSync } from 'node:fs';
let args={};
try{const d=JSON.parse(readFileSync(0,'utf8')||'{}');args=d.arguments||d;}catch{}
const a=Number(args.a||0), b=Number(args.b||0);
console.log(JSON.stringify({ok:true,plugin:'plugin_calc_sum',sum:a+b}));
`,
    check: (o) => o.ok === true && o.sum === 42,
  },
  {
    id: 'text_upper',
    name: 'plugin_text_upper',
    risk: 'read',
    args: { text: 'addon' },
    run_source: `import { readFileSync } from 'node:fs';
let args={};
try{const d=JSON.parse(readFileSync(0,'utf8')||'{}');args=d.arguments||d;}catch{}
const t=String(args.text||'');
console.log(JSON.stringify({ok:true,plugin:'plugin_text_upper',out:t.toUpperCase()}));
`,
    check: (o) => o.ok === true && o.out === 'ADDON',
  },
  {
    id: 'list_md',
    name: 'plugin_list_md',
    risk: 'read',
    args: {},
    run_source: `import { readdirSync } from 'node:fs';
import path from 'node:path';
const root=process.env.CQR_WORKSPACE_ROOT||process.cwd();
const names=readdirSync(root).filter(n=>n.endsWith('.md'));
console.log(JSON.stringify({ok:true,plugin:'plugin_list_md',md:names}));
`,
    check: (o) => o.ok === true && Array.isArray(o.md) && o.md.includes('README.md'),
  },
];

async function invoke(exec, workspace, cqrRoot, tool, args) {
  const res = await exec.executeAgentTool(
    workspace,
    {
      id: `x-${tool}`,
      type: 'function',
      function: { name: tool, arguments: JSON.stringify(args || {}) },
    },
    {},
    { cqrRoot, sessionId: 'addons-loop' },
  );
  try {
    return JSON.parse(res.output);
  } catch {
    return { ok: false, error: 'non-json', raw: String(res.output).slice(0, 200) };
  }
}

async function roundMatrix(round, m) {
  const { store, exec, reg } = m;
  const s = stage();
  try {
    const catalog = store.listPluginTemplates(s.cqrRoot);
    const ids = new Set(catalog.map((t) => t.id));
    record(
      round,
      'catalog.template_count',
      catalog.length >= TEMPLATE_MATRIX.length,
      `count=${catalog.length} need≥${TEMPLATE_MATRIX.length}`,
    );
    for (const t of TEMPLATE_MATRIX) {
      record(round, `catalog.has_${t.id}`, ids.has(t.id), t.id);
    }

    const installedNames = [];
    for (const t of TEMPLATE_MATRIX) {
      const inst = JSON.parse(
        store.installAgentPluginFromTemplate(s.cqrRoot, {
          template_id: t.id,
          confirm: true,
        }),
      );
      record(round, `install.${t.id}`, inst.ok === true, inst.error || inst.name || '');
      if (!inst.ok) continue;

      const body = await invoke(exec, s.workspace, s.cqrRoot, t.tool, t.args);
      const ok = t.check(body);
      record(
        round,
        `use.${t.id}`,
        ok,
        ok ? 'invoke ok' : JSON.stringify(body).slice(0, 120),
      );
      installedNames.push(t.tool);
    }

    // registry coexistence — re-list after all installs (disk truth)
    const meta = new Set([
      'plugin_list',
      'plugin_scaffold',
      'plugin_install',
      'plugin_set_enabled',
    ]);
    store.invalidateAgentPluginCache?.(s.cqrRoot);
    const tools = reg
      .getCodeAgentTools(s.cqrRoot)
      .map((x) => x.function.name)
      .filter((n) => n.startsWith('plugin_') && !meta.has(n));
    const diskNames = store
      .listAgentPlugins(s.cqrRoot, { useCache: false })
      .filter((p) => p.enabled)
      .map((p) => p.manifest.name);
    for (const name of installedNames) {
      record(
        round,
        `registry.${name}`,
        tools.includes(name) || diskNames.includes(name),
        name,
      );
    }

    // Custom hand-written "programs"
    for (const c of CUSTOM_ADDONS) {
      const inst = JSON.parse(
        store.installAgentPlugin(s.cqrRoot, {
          id: c.id,
          confirm: true,
          tool_json: {
            name: c.name,
            description: c.id,
            parameters: { type: 'object', properties: {} },
            runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 10000 },
            risk: c.risk,
          },
          run_source: c.run_source,
          created_by: 'agent',
        }),
      );
      record(round, `custom.install.${c.id}`, inst.ok === true, inst.error || c.name);
      if (!inst.ok) continue;
      const body = await invoke(exec, s.workspace, s.cqrRoot, c.name, c.args);
      record(
        round,
        `custom.use.${c.id}`,
        c.check(body),
        c.check(body) ? 'ok' : JSON.stringify(body).slice(0, 100),
      );
    }

    // Write-risk: install + confirm gate + confirm=true run
    const writeSrc = `console.log(JSON.stringify({ok:true,plugin:'plugin_risky_touch',touched:true}))`;
    const wInst = JSON.parse(
      store.installAgentPlugin(s.cqrRoot, {
        id: 'risky_touch',
        confirm: true,
        tool_json: {
          name: 'plugin_risky_touch',
          description: 'write risk',
          parameters: { type: 'object', properties: {} },
          runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 5000 },
          risk: 'write',
        },
        run_source: writeSrc,
      }),
    );
    record(round, 'safety.write_install', wInst.ok === true);
    if (wInst.ok) {
      const deny = await invoke(exec, s.workspace, s.cqrRoot, 'plugin_risky_touch', {});
      // executeAgentTool passes args.confirm only if provided
      const denyRec = store.getAgentPluginByToolName(s.cqrRoot, 'plugin_risky_touch');
      const denyOut = JSON.parse(
        m.runner.runAgentPlugin(s.cqrRoot, s.workspace, denyRec, {}, { confirm: false }),
      );
      record(round, 'safety.write_needs_confirm', denyOut.ok === false);
      const allowOut = JSON.parse(
        m.runner.runAgentPlugin(s.cqrRoot, s.workspace, denyRec, {}, { confirm: true }),
      );
      record(round, 'safety.write_with_confirm', allowOut.ok === true && allowOut.touched === true);
    }

    // Toggle off disables invoke by name (registry + get)
    const dis = JSON.parse(
      store.setAgentPluginEnabled(s.cqrRoot, {
        id: 'demo_echo',
        enabled: false,
        confirm: true,
      }),
    );
    store.invalidateAgentPluginCache?.(s.cqrRoot);
    record(round, 'toggle.disable', dis.ok === true);
    const still = store.getAgentPluginByToolName(s.cqrRoot, 'plugin_demo_echo');
    record(round, 'toggle.gone_from_enabled', !still, still ? 'still listed' : 'removed');

    // PowerShell path (Windows only)
    if (process.platform === 'win32') {
      const psSrc = [
        '$raw = [Console]::In.ReadToEnd()',
        'Write-Output (@{ ok = $true; plugin = "plugin_ps_hello"; platform = "win32" } | ConvertTo-Json -Compress)',
      ].join('\r\n');
      const psInst = JSON.parse(
        store.installAgentPlugin(s.cqrRoot, {
          id: 'ps_hello',
          confirm: true,
          tool_json: {
            name: 'plugin_ps_hello',
            description: 'powershell hello',
            parameters: { type: 'object', properties: {} },
            runner: { kind: 'powershell', entry: 'run.ps1', timeout_ms: 20000 },
            risk: 'read',
          },
          run_source: psSrc,
        }),
      );
      record(round, 'ps.install', psInst.ok === true, psInst.error || '');
      if (psInst.ok) {
        const body = await invoke(exec, s.workspace, s.cqrRoot, 'plugin_ps_hello', {});
        record(
          round,
          'ps.use',
          body.ok === true || String(body.plugin || '').includes('ps_hello'),
          JSON.stringify(body).slice(0, 120),
        );
      }
    } else {
      record(round, 'ps.skip', true, 'non-windows');
    }

    // Escapes / sandbox: path escape should fail for workspace_ls style plugin when re-enabled
    // re-enable file_stat path escape
    const esc = await invoke(exec, s.workspace, s.cqrRoot, 'plugin_file_stat', {
      path: '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
    });
    record(
      round,
      'sandbox.path_escape_denied',
      esc.ok === false,
      JSON.stringify(esc).slice(0, 100),
    );
  } finally {
    rmSync(s.cqrRoot, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`=== plugin addons continuous loop · ${ROUNDS} rounds ===\n`);
  if (!ensureBuild()) {
    console.error('build failed');
    process.exit(1);
  }
  const m = await loadStore();

  for (let r = 1; r <= ROUNDS; r++) {
    console.log(`\n######## ROUND ${r}/${ROUNDS} ########`);
    await roundMatrix(r, m);

    // optional live once mid-loop
    if (liveEvery && r === ROUNDS) {
      console.log('\n-- live OWUI end-cap --');
      const live = spawnSync(process.execPath, [join(root, 'tools', 'lab', 'owui-plugin-smoke.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
      });
      let report = {};
      try {
        report = JSON.parse(
          readFileSync(join(root, 'data', '_skill_tool_lab', 'owui-plugin-smoke.json'), 'utf8'),
        );
      } catch {
        report = { result: live.status === 0 ? 'pass' : 'fail' };
      }
      record(
        r,
        'live.owui_endcap',
        live.status === 0 && ['pass', 'partial', 'skip'].includes(report.result),
        `result=${report.result} exec=${report.saw_plugin_exec}`,
      );
    }
  }

  const pass = log.filter((x) => x.ok === true).length;
  const fail = log.filter((x) => x.ok === false).length;
  const known = log.filter((x) => x.ok === null).length;
  console.log(
    `\n=== SUMMARY rounds=${ROUNDS} pass=${pass} fail=${fail} known=${known} wall_ms=${Date.now() - t0} ===`,
  );

  // Stability: each template must PASS use in every round
  for (const t of TEMPLATE_MATRIX) {
    const uses = log.filter((x) => x.id === `use.${t.id}`);
    const allOk = uses.length === ROUNDS && uses.every((x) => x.ok === true);
    if (!allOk) {
      console.error(`STABILITY FAIL: use.${t.id} not green all rounds (${uses.filter((x) => x.ok).length}/${ROUNDS})`);
      fails += 1;
    } else {
      console.log(`STABILITY OK  use.${t.id} ${ROUNDS}/${ROUNDS}`);
    }
  }

  if (fails > 0) {
    console.error(`verify-plugin-addons-loop: FAIL (${fails})`);
    process.exit(1);
  }
  console.log('verify-plugin-addons-loop: OK (all addons stable across rounds)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
