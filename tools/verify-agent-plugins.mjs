/**
 * Verify local agent-plugins plane + templates + install path (loop-friendly).
 */
import { mkdtempSync, rmSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;

function fail(msg) {
  console.error('FAIL:', msg);
  fails += 1;
}

function ok(msg) {
  console.log('OK:', msg);
}

async function main() {
  const distStore = join(root, 'core', 'dist', 'agent', 'agent-plugin-store.js');
  if (!existsSync(distStore)) {
    const build = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], {
      cwd: root,
      stdio: 'inherit',
    });
    if (build.status !== 0) {
      console.error('build failed');
      process.exit(1);
    }
  }

  const storeMod = await import(pathToFileURL(distStore).href);
  const runnerMod = await import(
    pathToFileURL(join(root, 'core', 'dist', 'agent', 'agent-plugin-runner.js')).href
  );
  const regMod = await import(
    pathToFileURL(join(root, 'core', 'dist', 'agent', 'agent-tool-registry.js')).href
  );
  const execMod = await import(
    pathToFileURL(join(root, 'core', 'dist', 'agent', 'agent-tool-execute.js')).href
  );

  const {
    scaffoldAgentPlugin,
    installAgentPlugin,
    installAgentPluginFromTemplate,
    formatPluginListJson,
    listEnabledPluginToolDefinitions,
    listPluginTemplates,
    invalidateAgentPluginCache,
    setAgentPluginEnabled,
    getAgentPluginByToolName,
  } = storeMod;
  const { runAgentPlugin } = runnerMod;
  const { getCodeAgentTools } = regMod;
  const { executeAgentTool } = execMod;

  // Stage 1: isolated cqr root with templates copied from repo
  const cqrRoot = mkdtempSync(join(tmpdir(), 'cqr-plugins-'));
  const workspace = cqrRoot;
  try {
    mkdirSync(join(cqrRoot, 'tools'), { recursive: true });
    cpSync(join(root, 'tools', 'plugin-templates'), join(cqrRoot, 'tools', 'plugin-templates'), {
      recursive: true,
    });

    // Loop rounds until all assertions pass (max 2 rebuild+retry if import stale)
    for (let round = 1; round <= 2; round++) {
      fails = 0;
      console.log(`\n=== verify round ${round} ===`);

      const nConfirm = JSON.parse(
        installAgentPlugin(cqrRoot, {
          id: 'x',
          confirm: false,
          tool_json: '{}',
          run_source: '1',
        }),
      );
      if (nConfirm.ok !== false) fail('install without confirm');
      else ok('install requires confirm');

      const reserved = JSON.parse(
        installAgentPlugin(cqrRoot, {
          id: 'shadow',
          confirm: true,
          tool_json: JSON.stringify({
            name: 'read_file',
            description: 'x',
            parameters: { type: 'object', properties: {} },
            runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 10_000 },
            risk: 'read',
          }),
          run_source: 'console.log(1)',
        }),
      );
      if (reserved.ok !== false) fail('reserved name install');
      else ok('reserved name denied');

      const templates = listPluginTemplates(cqrRoot);
      const allTemplates = listPluginTemplates(cqrRoot, { forUi: false });
      if (templates.length !== 1 || templates[0]?.id !== 'file_stat') fail(`unexpected UI templates: ${templates.map((t) => t.id).join(',')}`);
      else if (allTemplates.length < 7) fail(`all templates expected ≥7 got ${allTemplates.length}`);
      else ok(`UI templates hidden; all templates ${allTemplates.map((t) => t.id).join(',')}`);

      // history template install
      const hist = JSON.parse(
        installAgentPluginFromTemplate(cqrRoot, {
          template_id: 'git_history_tree',
          confirm: true,
        }),
      );
      if (!hist.ok) fail(`hist template: ${JSON.stringify(hist)}`);
      else ok('git_history_tree template install');

      const fromTpl = JSON.parse(
        installAgentPluginFromTemplate(cqrRoot, {
          template_id: 'demo_echo',
          confirm: true,
        }),
      );
      if (!fromTpl.ok) fail(`from template: ${JSON.stringify(fromTpl)}`);
      else ok('install from demo_echo template');

      const toolPath = join(cqrRoot, 'data', 'agent-plugins', 'demo_echo', 'run.mjs');
      if (!existsSync(toolPath)) fail('template files missing');
      else ok('template files on disk');

      const names = getCodeAgentTools(cqrRoot).map((t) => t.function.name);
      if (!names.includes('plugin_demo_echo')) fail('registry missing plugin_demo_echo');
      else ok('registry has plugin_demo_echo');

      const rec = getAgentPluginByToolName(cqrRoot, 'plugin_demo_echo');
      const out = runAgentPlugin(cqrRoot, workspace, rec, { message: 'hello-plugin' }, {});
      if (!out.includes('hello-plugin')) fail(`runner: ${out}`);
      else ok('runner invoke');

      const execRes = await executeAgentTool(
        workspace,
        {
          id: 't1',
          type: 'function',
          function: {
            name: 'plugin_demo_echo',
            arguments: JSON.stringify({ message: 'via-execute' }),
          },
        },
        {},
        { cqrRoot, sessionId: 'verify' },
      );
      if (!String(execRes.output).includes('via-execute')) fail(`execute: ${execRes.output}`);
      else ok('executeAgentTool');

      // vcs template install (may run on non-git root)
      const vcsInst = JSON.parse(
        installAgentPluginFromTemplate(cqrRoot, {
          template_id: 'vcs_tree_brief',
          confirm: true,
        }),
      );
      if (!vcsInst.ok) fail(`vcs template: ${JSON.stringify(vcsInst)}`);
      else ok('vcs_tree_brief installed');

      const vcsRec = getAgentPluginByToolName(cqrRoot, 'plugin_vcs_tree_brief');
      const vcsOut = runAgentPlugin(cqrRoot, root, vcsRec, {}, {});
      // when workspace is CQR repo via force root param - we pass product root as workspace for git
      if (!vcsOut.includes('plugin_vcs_tree_brief') && !vcsOut.includes('not a git')) {
        fail(`vcs brief unexpected: ${vcsOut.slice(0, 200)}`);
      } else ok('vcs_tree_brief invoke');

      // write risk gate
      const sc = JSON.parse(scaffoldAgentPlugin({ id: 'writey', risk: 'write', purpose: 'w' }));
      sc.tool_json.risk = 'write';
      sc.tool_json.name = 'plugin_writey';
      installAgentPlugin(cqrRoot, {
        id: 'writey',
        confirm: true,
        tool_json: sc.tool_json,
        run_source: sc.run_source,
      });
      const wRec = getAgentPluginByToolName(cqrRoot, 'plugin_writey');
      const denied = JSON.parse(runAgentPlugin(cqrRoot, workspace, wRec, {}, { confirm: false }));
      if (denied.ok !== false) fail('write risk no confirm');
      else ok('write risk confirm gate');

      const dis = JSON.parse(
        setAgentPluginEnabled(cqrRoot, { id: 'demo_echo', enabled: false, confirm: true }),
      );
      if (!dis.ok) fail(`disable ${JSON.stringify(dis)}`);
      invalidateAgentPluginCache(cqrRoot);
      if (getAgentPluginByToolName(cqrRoot, 'plugin_demo_echo')) fail('still enabled');
      else ok('set_enabled');

      // meta tools in list
      if (!names.includes('plugin_list') || !names.includes('plugin_install')) {
        fail('meta tools missing');
      } else ok('meta tools present');

      if (fails === 0) {
        console.log('\nverify-agent-plugins: OK (all rounds green)');
        return;
      }
      console.error(`round ${round} failures=${fails}; rebuilding…`);
      const b = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], {
        cwd: root,
        stdio: 'inherit',
      });
      if (b.status !== 0) process.exit(1);
      // re-import won't clear ESM cache easily — use rebuild for next exit path
    }
    process.exit(1);
  } finally {
    try {
      rmSync(cqrRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
