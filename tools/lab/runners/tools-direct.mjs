/**
 * L1: execute each CODE_AGENT tool once on an isolated fixture workspace.
 * Browser tools optional (skip if Playwright unavailable unless MY_AGENT_LAB_BROWSER=1).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

function tc(name, args) {
  return {
    id: `lab_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  };
}

function resultRow(item, level, status, ms, note = '') {
  return { suite: 'tools', item, level, result: status, ms, note: String(note).slice(0, 240) };
}

export async function prepareFixture(labRoot) {
  const fixture = path.join(labRoot, 'fixture');
  if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
  mkdirSync(path.join(fixture, 'src'), { recursive: true });
  mkdirSync(path.join(fixture, 'test'), { recursive: true });
  writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify(
      {
        name: 'my-agent-skill-tool-lab',
        version: '0.0.1',
        private: true,
        type: 'module',
        scripts: {
          check: 'node --check src/hello.js',
          test: 'node --test test/smoke.test.js',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    path.join(fixture, 'test', 'smoke.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('lab fixture', () => assert.equal(1, 1));\n",
    'utf8',
  );
  writeFileSync(
    path.join(fixture, 'src', 'hello.js'),
    "export function hello() {\n  return 'ok';\n}\n",
    'utf8',
  );
  writeFileSync(
    path.join(fixture, 'src', 'app.js'),
    "export const n = 1;\n",
    'utf8',
  );
  writeFileSync(
    path.join(fixture, 'index.html'),
    '<!doctype html><html><body><h1 id="lab">lab</h1><script src="src/app.js"></script></body></html>\n',
    'utf8',
  );
  writeFileSync(path.join(fixture, 'README.md'), '# lab fixture\n', 'utf8');
  writeFileSync(path.join(fixture, '.gitignore'), 'node_modules/\n', 'utf8');

  const git = spawnSync('git', ['init'], { cwd: fixture, encoding: 'utf8' });
  if (git.status === 0) {
    spawnSync('git', ['config', 'user.email', 'lab@example.invalid'], { cwd: fixture });
    spawnSync('git', ['config', 'user.name', 'MY Agent Lab'], { cwd: fixture });
    spawnSync('git', ['add', '-A'], { cwd: fixture });
    spawnSync('git', ['commit', '-m', 'lab init'], { cwd: fixture });
  }
  return fixture;
}

async function runOne(executeAgentTool, fixture, name, args, ctx) {
  const t0 = Date.now();
  try {
    const res = await executeAgentTool(fixture, tc(name, args), { allowNas: false }, ctx);
    const out = String(res.output || '');
    const hardFail = /^ERROR:/m.test(out) || out.includes('ERROR: tool_call_failed');
    let status = hardFail ? 'fail' : 'pass';
    let note = hardFail ? out.slice(0, 200) : res.label || 'ok';
    try {
      const j = JSON.parse(out);
      if (j && (j.skipped === true || j.noop === true || j.status === 'skip')) {
        status = 'skip';
        note = j.message || j.error || 'skipped ≠ pass';
      } else if (j && j.weak === true && j.ok === true) {
        note = `${res.label || 'ok'} (weak)`;
      }
    } catch {
      /* non-JSON tool output */
    }
    return resultRow(name, 1, status, Date.now() - t0, note);
  } catch (e) {
    return resultRow(name, 1, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e));
  }
}

export async function runToolsDirect(root, catalog, opts = {}) {
  const labRoot = path.join(root, 'data', '_skill_tool_lab');
  mkdirSync(labRoot, { recursive: true });
  const fixture = await prepareFixture(labRoot);
  const { executeAgentTool } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
  );

  let playwrightOk = false;
  const sessionId = `lab_${Date.now()}`;
  const ctx = { cqrRoot: root, sessionId, allowLocalhost: true };
  const rows = [];

  // Order: list → read → write → edit → patch → search → map → embeddings → terminal → diag/tests → checkpoint → git → rename/delete last
  const seq = [
    ['list_directory', { path: '.' }],
    ['read_file', { path: 'src/hello.js' }],
    ['write_file', { path: 'src/written.js', content: "export const w = 1;\n" }],
    [
      'edit_file',
      {
        path: 'src/hello.js',
        old_text: "return 'ok';",
        new_text: "return 'ok-lab';",
      },
    ],
    [
      'apply_patch',
      {
        path: 'src/app.js',
        old_text: 'export const n = 1;',
        new_text: 'export const n = 2;',
      },
    ],
    ['search_files', { query: 'hello', path: '.' }],
    ['query_repo_map', { focus: 'hello' }],
    ['search_embeddings', { query: 'hello export' }],
    ['run_terminal', { command: 'node --version' }],
    ['run_diagnostics', {}],
    ['run_tests', {}],
    [
      'workspace_checkpoint',
      { label: 'lab-cp', paths: ['src/hello.js', 'src/app.js', 'src/written.js'] },
    ],
    ['git_status', {}],
    ['git_diff', {}],
    ['git_log', { max: 8 }],
    ['git_history_tree', { max: 12 }],
    ['git_show', { ref: 'HEAD', stat_only: true }],
    ['git_blame', { path: 'src/hello.js', max: 40 }],
    // no remote in fixture: fetch=false or soft JSON ok:false still exercises the plane
    ['git_sync_preview', { fetch: false }],
    ['git_branch', { action: 'list' }],
    ['git_branch', { action: 'create', name: 'lab-feat', confirm: true }],
    ['git_switch', { branch: 'lab-feat', confirm: true, force_dirty: true }],
    ['git_stage', { paths: ['src/hello.js'] }],
    ['git_commit', { message: 'lab mutate', confirm: true, paths: ['src/hello.js'] }],
    ['git_stash', { action: 'list' }],
    // intentional dirty restore
    // (file written just before stage/restore in loop below if needed)
    ['git_restore', { paths: ['src/hello.js'], mode: 'worktree', confirm: true }],
    ['git_fetch', {}],
    // confirm gates only (no remote required for refuse path)
    ['git_pull', { confirm: false }],
    ['git_push', { confirm: false }],
    ['plugin_list', {}],
    ['plugin_scaffold', { id: 'lab_scaffold_echo', purpose: 'echo a demo message', risk: 'read' }],
    [
      'plugin_install',
      {
        template_id: 'demo_echo',
        id: `lab_echo_${Date.now().toString(36).slice(-6)}`,
        confirm: true,
      },
    ],
    // OSS/tool dispatch coverage. Use safe probes or validation paths so L1 never
    // needs network credentials and never mutates outside the isolated fixture.
    [
      'remote_git_inspect',
      { action: 'status', repo: '.my_agent_remote/lab__missing' },
    ],
    ['repomix_pack', { args: ['--definitely-invalid-lab-option'] }],
    ['ast_grep_search', { pattern: '', lang: 'javascript' }],
    ['markitdown_convert', { path: 'missing-lab-document.pdf' }],
    // id filled after install below
    [
      'rename_file',
      { path: 'src/written.js', new_path: 'src/renamed.js' },
    ],
  ];

  let checkpointId = '';
  let installedPluginId = '';
  for (const [name, args] of seq) {
    if (!catalog.code_tools.includes(name)) {
      rows.push(resultRow(name, 1, 'fail', 0, 'missing from catalog'));
      continue;
    }
    // Before restore: make a disposable dirty change so tool does work
    if (name === 'git_restore') {
      try {
        writeFileSync(
          path.join(fixture, 'src', 'hello.js'),
          "export function hello() {\n  return 'dirty-for-restore';\n}\n",
          'utf8',
        );
      } catch {
        /* ignore */
      }
    }
    // Before stash push-style coverage: list already enough; pull/push gates treat ok=false as pass
    if (name === 'workspace_checkpoint') {
      const t0 = Date.now();
      try {
        const res = await executeAgentTool(fixture, tc(name, args), { allowNas: false }, ctx);
        const out = String(res.output || '');
        const hardFail = /^ERROR:/m.test(out);
        rows.push(
          resultRow(
            name,
            1,
            hardFail ? 'fail' : 'pass',
            Date.now() - t0,
            hardFail ? out.slice(0, 200) : res.label || 'ok',
          ),
        );
        if (!hardFail) {
          try {
            checkpointId = JSON.parse(out).id || '';
          } catch {
            checkpointId = '';
          }
        }
      } catch (e) {
        rows.push(
          resultRow(name, 1, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
        );
      }
    } else if (name === 'plugin_install') {
      const t0 = Date.now();
      try {
        const res = await executeAgentTool(fixture, tc(name, args), { allowNas: false }, ctx);
        const out = String(res.output || '');
        const hardFail = /^ERROR:/m.test(out) && !/confirm/i.test(out);
        let okPlugin = !hardFail;
        try {
          const j = JSON.parse(out);
          okPlugin = j.ok !== false;
          if (j.id) installedPluginId = String(j.id);
          else if (args.id) installedPluginId = String(args.id);
        } catch {
          if (args.id) installedPluginId = String(args.id);
        }
        rows.push(
          resultRow(
            name,
            1,
            okPlugin ? 'pass' : 'fail',
            Date.now() - t0,
            okPlugin ? `id=${installedPluginId}` : out.slice(0, 200),
          ),
        );
      } catch (e) {
        rows.push(
          resultRow(name, 1, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
        );
      }
    } else if (name === 'git_pull' || name === 'git_push' || name === 'git_fetch') {
      // Gate / soft remote miss: JSON ok:false without tool crash = pass (plane wired)
      const row = await runOne(executeAgentTool, fixture, name, args, ctx);
      if (row.result === 'fail') {
        const soft =
          /confirm|remote|origin|not found|NO_REMOTE|no remote|upstream|rejected/i.test(row.note)
          || /"ok"\s*:\s*false/.test(row.note);
        if (soft) {
          rows.push({ ...row, result: 'pass', note: `soft: ${row.note}`.slice(0, 240) });
        } else {
          rows.push(row);
        }
      } else {
        rows.push(row);
      }
    } else {
      rows.push(await runOne(executeAgentTool, fixture, name, args, ctx));
    }
  }

  // Switch back to default branch if lab-feat exists (covers return switch)
  const defaultBranch = existsSync(path.join(fixture, '.git'))
    ? (
        spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: fixture,
          encoding: 'utf8',
        }).stdout || ''
      ).trim()
    : '';
  if (defaultBranch && defaultBranch !== 'master' && defaultBranch !== 'main') {
    // currently on lab-feat — switch to master/main for cleanup
    const back = await runOne(
      executeAgentTool,
      fixture,
      'git_switch',
      { branch: 'master', confirm: true, force_dirty: true },
      ctx,
    );
    if (back.result === 'fail') {
      rows.push(
        await runOne(
          executeAgentTool,
          fixture,
          'git_switch',
          { branch: 'main', confirm: true, force_dirty: true },
          ctx,
        ),
      );
    } else {
      rows.push(back);
    }
  }

  // stash push/pop round-trip once
  writeFileSync(path.join(fixture, 'src', 'stash-me.js'), 'export const s = 1;\n', 'utf8');
  rows.push(
    await runOne(executeAgentTool, fixture, 'git_stash', {
      action: 'push',
      message: 'lab-stash',
    }, ctx),
  );
  rows.push(
    await runOne(executeAgentTool, fixture, 'git_stash', {
      action: 'pop',
      confirm: true,
      index: 0,
    }, ctx),
  );

  if (installedPluginId) {
    rows.push(
      await runOne(
        executeAgentTool,
        fixture,
        'plugin_set_enabled',
        { id: installedPluginId, enabled: false, confirm: true },
        ctx,
      ),
    );
    try {
      const { uninstallAgentPlugin } = await import(
        pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'agent-plugin-store.js')).href
      );
      const raw = uninstallAgentPlugin(root, { id: installedPluginId, confirm: true });
      const doc = JSON.parse(raw);
      rows.push(
        resultRow(
          'plugin_uninstall',
          doc.ok ? 0 : 1,
          doc.ok ? 'pass' : 'fail',
          0,
          doc.ok ? `removed=${installedPluginId}` : String(doc.error || raw).slice(0, 200),
        ),
      );
    } catch (e) {
      rows.push(
        resultRow(
          'plugin_uninstall',
          1,
          'fail',
          0,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  } else {
    rows.push(
      resultRow('plugin_set_enabled', 1, 'fail', 0, 'no installed plugin id from plugin_install'),
    );
  }

  rows.push(
    await runOne(
      executeAgentTool,
      fixture,
      'workspace_rollback',
      { checkpoint_id: checkpointId || 'missing', confirm: true },
      ctx,
    ),
  );

  // delete (recreate target if rollback removed)
  if (!existsSync(path.join(fixture, 'src', 'renamed.js'))) {
    writeFileSync(path.join(fixture, 'src', 'todel.js'), 'x\n', 'utf8');
    rows.push(await runOne(executeAgentTool, fixture, 'delete_file', { path: 'src/todel.js' }, ctx));
  } else {
    rows.push(await runOne(executeAgentTool, fixture, 'delete_file', { path: 'src/renamed.js' }, ctx));
  }

  // coverage: every code tool appears (browser handled separately)
  for (const name of catalog.code_tools) {
    if (!rows.some((r) => r.item === name)) {
      rows.push(resultRow(name, 1, 'blocked', 0, 'requires independent state or external input'));
    }
  }

  return { fixture, rows, playwrightOk: false };
}
