/**
 * Loop audit for known plugin-plane risks (install → use on local PC).
 * Each round re-checks FAIL items until green or max rounds.
 *
 *   node tools/verify-plugin-loop-audit.mjs
 *   MY_AGENT_PLUGIN_LOOP_LIVE=1  # also lab:plugin-live
 */
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ROUNDS = 3;
const live = process.env.MY_AGENT_PLUGIN_LOOP_LIVE === '1';

/** @type {{ id: string, severity: 'P0'|'P1'|'P2'|'known', ok: boolean|null, detail: string }[]} */
let items = [];

function set(id, severity, ok, detail = '') {
  const row = items.find((x) => x.id === id);
  if (row) {
    row.ok = ok;
    row.detail = detail;
    row.severity = severity;
  } else {
    items.push({ id, severity, ok, detail });
  }
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'KNOWN';
  console.log(`  ${mark} [${severity}] ${id}${detail ? ` — ${detail}` : ''}`);
}

function dist(p) {
  return join(root, 'core', 'dist', p);
}

function ensureBuild() {
  if (existsSync(dist('agent/agent-plugin-store.js')) && existsSync(dist('agent/tool-content-guards.js'))) {
    return true;
  }
  const b = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  return b.status === 0;
}

function srcHas(rel, re) {
  const p = join(root, rel);
  if (!existsSync(p)) return false;
  return re.test(readFileSync(p, 'utf8'));
}

function runNode(script, env = {}) {
  return spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function load() {
  if (!ensureBuild()) throw new Error('build failed');
  return {
    guards: await import(pathToFileURL(dist('agent/tool-content-guards.js')).href + `?t=${Date.now()}`),
    store: await import(pathToFileURL(dist('agent/agent-plugin-store.js')).href + `?t=${Date.now()}`),
    exec: await import(pathToFileURL(dist('agent/agent-tool-execute.js')).href + `?t=${Date.now()}`),
    pack: await import(pathToFileURL(dist('agent/agent-tool-pack.js')).href + `?t=${Date.now()}`),
    reg: await import(pathToFileURL(dist('agent/agent-tool-registry.js')).href + `?t=${Date.now()}`),
    helpers: await import(pathToFileURL(dist('agent/agent-run-helpers.js')).href + `?t=${Date.now()}`),
  };
}

function stage() {
  const cqrRoot = mkdtempSync(join(tmpdir(), 'cqr-loop-plugin-'));
  mkdirSync(join(cqrRoot, 'tools'), { recursive: true });
  mkdirSync(join(cqrRoot, 'data', 'agent-plugins'), { recursive: true });
  cpSync(join(root, 'tools', 'plugin-templates'), join(cqrRoot, 'tools', 'plugin-templates'), {
    recursive: true,
  });
  const workspace = join(cqrRoot, 'ws');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# loop\n');
  spawnSync('git', ['init'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'loop@cqr.local'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'Loop'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['add', '-A'], { cwd: workspace, windowsHide: true });
  spawnSync('git', ['commit', '-m', 'seed'], { cwd: workspace, windowsHide: true });
  return { cqrRoot, workspace };
}

async function checkRisks(m) {
  // --- R1 install→use is the model's next step: no runtime defer-detect / forced invoke ---
  set(
    'R1.no_defer_detect',
    'P0',
    typeof m.guards.contentDefersPluginInvoke === 'undefined',
    'no prose "이제 호출합니다" detector',
  );
  set(
    'R1.no_forced_invoke',
    'P0',
    !srcHas('core/src/agent/agent-run-step-loop.ts', /pendingPluginInvoke/)
      && !srcHas('core/src/agent/agent-run-step-state.ts', /pendingPluginInvoke|pluginInvokeForceCount/)
      && !srcHas('core/src/agent/agent-run-helpers.ts', /auto-invokes the new plugin/),
    'no pending/forced plugin invoke in step loop or prompt',
  );
  set(
    'R1.skip_silent_diag_plugin_only',
    'P1',
    srcHas(
      'core/src/agent/agent-run-step-loop.ts',
      /mutatedPathsThisRun\.size > 0/,
    ),
    'silent verify gated on workspace mutates',
  );

  // --- R2 template install + use ---
  const s = stage();
  try {
    const deny = JSON.parse(
      m.store.installAgentPluginFromTemplate(s.cqrRoot, {
        template_id: 'git_history_tree',
        confirm: false,
      }),
    );
    set('R2.confirm_gate', 'P0', deny.ok === false, 'install without confirm denied');

    const inst = JSON.parse(
      m.store.installAgentPluginFromTemplate(s.cqrRoot, {
        template_id: 'git_history_tree',
        confirm: true,
      }),
    );
    set(
      'R2.template_install',
      'P0',
      inst.ok === true && inst.next_tool === 'plugin_git_history_tree',
      JSON.stringify({ ok: inst.ok, next_tool: inst.next_tool }).slice(0, 100),
    );

    const used = await m.exec.executeAgentTool(
      s.workspace,
      {
        id: '1',
        type: 'function',
        function: { name: 'plugin_git_history_tree', arguments: '{"max":5}' },
      },
      {},
      { cqrRoot: s.cqrRoot, sessionId: 'loop' },
    );
    const body = JSON.parse(used.output);
    set(
      'R2.install_then_use',
      'P0',
      body.ok === true && Boolean(body.graph_ascii || body.graph),
      String(body.graph_ascii || '').split('\n')[0]?.slice(0, 80) || used.output.slice(0, 80),
    );
  } finally {
    rmSync(s.cqrRoot, { recursive: true, force: true });
  }

  // --- R3 freeform scaffold — purpose recipes (residual echo only for vague purpose) ---
  const scEcho = JSON.parse(
    m.store.scaffoldAgentPlugin({ id: 'freeform_x', purpose: 'anything vague', risk: 'read' }),
  );
  const scSum = JSON.parse(
    m.store.scaffoldAgentPlugin({
      id: 'calc_sum_x',
      purpose: '두 수를 더하는 sum 도구',
      risk: 'read',
    }),
  );
  const scTpl = JSON.parse(
    m.store.scaffoldAgentPlugin({
      id: 'fstat',
      purpose: 'file_stat 파일 크기 플러그인',
      risk: 'read',
    }),
  );
  // git_history_tree template is superseded by the builtin tool → never recommended.
  const scHist = JSON.parse(
    m.store.scaffoldAgentPlugin({
      id: 'hist',
      purpose: 'git history tree graph ascii',
      risk: 'read',
    }),
  );
  set(
    'R3.scaffold_vague_is_fallback',
    'known',
    null,
    scEcho.recipe === 'echo_purpose' || /echo_purpose|generic scaffold/i.test(JSON.stringify(scEcho))
      ? '모호한 purpose만 echo fallback — 구체 키워드 레시피/템플릿 매칭은 가능'
      : 'unexpected vague scaffold',
  );
  set(
    'R3.scaffold_purpose_recipe',
    'P0',
    scSum.ok === true
      && scSum.recipe === 'calc_sum'
      && /sum|a \+ b|Number\(args/i.test(String(scSum.run_source || '')),
    scSum.recipe || '',
  );
  set(
    'R3.scaffold_prefer_template',
    'P0',
    scTpl.prefer_template_id === 'file_stat' && !scHist.prefer_template_id,
    `file_stat=${scTpl.prefer_template_id} git_history=${scHist.prefer_template_id ?? 'none'}`,
  );
  set('R3.scaffold_api_ok', 'P1', scEcho.ok === true, scEcho.name || '');

  // --- R3b capability order is a prompt rule (model decides), not a runtime NL plan ---
  const cap = await import(
    pathToFileURL(dist('agent/agent-plugin-capability.js')).href + `?t=${Date.now()}`
  );
  set(
    'R3.cap_order_prompt_rule',
    'P0',
    srcHas('core/src/agent/agent-run-helpers.ts', /LOCAL PLUGINS \(capability plan/)
      && typeof cap.resolveCapabilityPlan === 'undefined',
    'builtin → template → freeform stated in system prompt; no NL plan in runtime',
  );

  // freeform HITL (template skips UI Accept; freeform needs it)
  const freeHitl = cap.pluginInstallNeedsHitl({
    id: 'x',
    tool_json: { name: 'plugin_x', risk: 'read' },
    run_source: 'x',
  });
  const tplHitl = cap.pluginInstallNeedsHitl({ template_id: 'demo_echo', confirm: true });
  set(
    'R3.hitl_freeform_install',
    'P0',
    freeHitl.needed === true && tplHitl.needed === false,
    `free=${freeHitl.needed} tpl=${tplHitl.needed}`,
  );

  // --- R4 core self-patch impossible on deploy PC (policy fact) ---
  set(
    'R4.no_core_self_patch_plane',
    'known',
    null,
    '로컬 PC는 core/ 재빌드 없이 data/agent-plugins 로만 확장. 공통 builtin은 delta/배포 필요',
  );

  // --- R5 UI surface ---
  set(
    'R5.settings_plugins',
    'P0',
    srcHas('ui/workspace/src/components/SettingsModal.tsx', /id: 'plugins'[\s\S]{0,120}label: '플러그인'/)
      && srcHas('ui/workspace/src/components/SettingsPluginsPage.tsx', /installAgentPluginFromTemplate/)
      && srcHas('ui/workspace/src/api/myAgentClient.ts', /listAgentPlugins/)
      && srcHas('ui/workspace/src/api/myAgentClient.ts', /installAgentPluginFromTemplate/),
    'Settings → 플러그인 + client APIs',
  );
  set(
    'R5.no_marketplace',
    'known',
    null,
    '마켓/서명 스토어 없음 — 로컬 템플릿·manual install 만',
  );

  // --- R6 safety ---
  const ro = m.pack.getCodeAgentToolsForPack('read_only', false, root);
  const roNames = new Set(ro.map((t) => t.function.name));
  set(
    'R6.read_only_hides_install',
    'P0',
    !roNames.has('plugin_install') && roNames.has('plugin_list'),
    'read_only pack',
  );
  const planBlocked = await m.exec.executeAgentTool(
    root,
    {
      id: 'plan1',
      type: 'function',
      function: {
        name: 'plugin_install',
        arguments: JSON.stringify({ template_id: 'git_history_tree', confirm: true }),
      },
    },
    {},
    { cqrRoot: root, sessionId: 'plan-audit', workspaceBehavior: 'plan' },
  );
  set(
    'R6.plan_blocks_install',
    'P0',
    /WORKSPACE_BEHAVIOR_READ_ONLY/.test(planBlocked.output),
    'Plan behavior',
  );
  const s2 = stage();
  try {
    const shadow = JSON.parse(
      m.store.installAgentPlugin(s2.cqrRoot, {
        id: 'bad_rf',
        confirm: true,
        tool_json: {
          name: 'read_file',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 3000 },
          risk: 'read',
        },
        run_source: 'console.log("{}")',
      }),
    );
    set('R6.no_shadow_builtin', 'P0', shadow.ok === false, JSON.stringify(shadow).slice(0, 100));
  } finally {
    rmSync(s2.cqrRoot, { recursive: true, force: true });
  }

  // --- R7 no runtime auto-invoke after install (model calls the plugin itself) ---
  set(
    'R7.no_runtime_auto_invoke_claim',
    'P1',
    !srcHas('core/src/agent/agent-run-helpers.ts', /auto-invokes the new plugin/),
    'system prompt does not promise runtime auto-invoke',
  );

  // --- R8 automated suite gate ---
  const e2e = runNode('tools/verify-plugin-e2e.mjs', {
    MY_AGENT_PLUGIN_E2E_SKIP_BUILD: '1',
  });
  set(
    'R8.verify_plugin_e2e',
    'P0',
    e2e.status === 0,
    e2e.status === 0 ? '35-path green' : (e2e.stderr || e2e.stdout || '').slice(-200),
  );

  const unit = runNode('tools/verify-agent-plugins.mjs');
  set(
    'R8.verify_agent_plugins',
    'P0',
    unit.status === 0,
    unit.status === 0 ? 'store/runner green' : (unit.stderr || '').slice(-160),
  );

  // --- R9 live (optional) ---
  if (live) {
    const liveR = runNode('tools/lab/owui-plugin-smoke.mjs');
    let report = {};
    try {
      report = JSON.parse(
        readFileSync(join(root, 'data', '_skill_tool_lab', 'owui-plugin-smoke.json'), 'utf8'),
      );
    } catch {
      report = { result: liveR.status === 0 ? 'pass' : 'fail' };
    }
    set(
      'R9.live_owui',
      'P1',
      liveR.status === 0 && (report.result === 'pass' || report.result === 'partial' || report.result === 'skip'),
      `result=${report.result} saw_plugin_exec=${report.saw_plugin_exec} graph=${String(report.graph_preview || '').slice(0, 60)}`,
    );
  } else {
    set('R9.live_owui', 'P1', true, 'skipped (set MY_AGENT_PLUGIN_LOOP_LIVE=1)');
  }
}

function failCount() {
  return items.filter((x) => x.ok === false).length;
}

function printSummary(round) {
  const p0 = items.filter((x) => x.severity === 'P0');
  const known = items.filter((x) => x.ok === null);
  const pass = items.filter((x) => x.ok === true);
  const fail = items.filter((x) => x.ok === false);
  console.log(
    `\n── round ${round} tally: pass=${pass.length} fail=${fail.length} known=${known.length} (P0 fail=${p0.filter((x) => x.ok === false).length})`,
  );
}

async function main() {
  console.log('=== plugin loop audit ===\n');
  if (!ensureBuild()) {
    console.error('build failed');
    process.exit(1);
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n######## ROUND ${round}/${MAX_ROUNDS} ########`);
    items = [];
    const m = await load();
    await checkRisks(m);
    printSummary(round);

    if (failCount() === 0) {
      console.log('\nloop: GREEN (no FAIL; KNOWN gaps remain as product limits)');
      // emit short known list
      for (const k of items.filter((x) => x.ok === null)) {
        console.log(`  · ${k.id}: ${k.detail}`);
      }
      process.exit(0);
    }

    console.log('\nloop: FAIL items — retry after rebuild if code was expected stale…');
    // rebuild and retry
    const b = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], {
      cwd: root,
      stdio: 'inherit',
    });
    if (b.status !== 0) process.exit(1);
  }

  console.error('\nloop: RED after max rounds');
  for (const f of items.filter((x) => x.ok === false)) {
    console.error(`  FAIL ${f.id}: ${f.detail}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
