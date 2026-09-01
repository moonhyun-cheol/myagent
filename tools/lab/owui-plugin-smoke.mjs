#!/usr/bin/env node
/**
 * Optional live OWUI (or configured cloud) smoke — plugin self-add path.
 * Skips cleanly when no credentials (not a default 납기 fail).
 *
 *   node tools/lab/owui-plugin-smoke.mjs
 *   MY_AGENT_PLUGIN_LIVE_FORCE=1 node tools/lab/owui-plugin-smoke.mjs  # fail if no key
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  mkdtempSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
const force =
  process.env.MY_AGENT_PLUGIN_LIVE_FORCE === '1'
  || process.env.MY_AGENT_OWUI_SMOKE_FORCE === '1';
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'owui-plugin-smoke.json');

function done(payload, code) {
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

const vault = path.join(root, 'data', 'vault', 'provider-keys.json');
if (!existsSync(vault) && !process.env.CQR_OPENWEBUI_API_KEY?.trim()) {
  done(
    {
      ok: !force,
      result: force ? 'fail' : 'skip',
      note: 'no provider vault / CQR_OPENWEBUI_API_KEY — skip live plugin smoke',
    },
    force ? 1 : 0,
  );
}

const distTools = path.join(root, 'core', 'dist', 'agent', 'code-agent.js');
const distStore = path.join(root, 'core', 'dist', 'providers', 'provider-store.js');
const distPlugin = path.join(root, 'core', 'dist', 'agent', 'agent-plugin-store.js');
if (!existsSync(distTools) || !existsSync(distStore)) {
  done({ ok: false, result: 'fail', note: 'build first: node tools/build.mjs' }, 1);
}

const cqrRoot = mkdtempSync(path.join(tmpdir(), 'cqr-plugin-live-'));
const workspace = path.join(cqrRoot, 'workspace');
mkdirSync(workspace, { recursive: true });
mkdirSync(path.join(cqrRoot, 'data', 'agent-plugins'), { recursive: true });
mkdirSync(path.join(cqrRoot, 'tools'), { recursive: true });
cpSync(path.join(root, 'tools', 'plugin-templates'), path.join(cqrRoot, 'tools', 'plugin-templates'), {
  recursive: true,
});
writeFileSync(path.join(workspace, 'README.md'), '# plugin-live-smoke\n', 'utf8');
spawnSync('git', ['init'], { cwd: workspace, windowsHide: true });
spawnSync('git', ['config', 'user.email', 'live@cqr.local'], { cwd: workspace, windowsHide: true });
spawnSync('git', ['config', 'user.name', 'Live'], { cwd: workspace, windowsHide: true });
spawnSync('git', ['add', '-A'], { cwd: workspace, windowsHide: true });
spawnSync('git', ['commit', '-m', 'seed'], { cwd: workspace, windowsHide: true });

const { ProviderStore } = await import(pathToFileURL(distStore).href);
const { runCodeAgent } = await import(pathToFileURL(distTools).href);
const { listAgentPlugins, getAgentPluginByToolName } = await import(
  pathToFileURL(distPlugin).href
);

const store = new ProviderStore(path.join(root, 'data', 'vault', 'provider-keys.json'), root);
const prefer = process.env.MY_AGENT_OWUI_SMOKE_PROVIDER?.trim();
const idOrder = prefer
  ? [prefer, 'custom', 'openwebui', 'open_webui', 'ollama']
  : ['custom', 'openwebui', 'open_webui', 'ollama'];
const tried = new Set();
let resolved = null;
for (const id of idOrder) {
  if (tried.has(id)) continue;
  tried.add(id);
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
  try {
    const list = store.listPublic?.() || [];
    const first = Array.isArray(list) ? list.find((p) => p.configured) : null;
    if (first?.id) resolved = { id: first.id, ...store.resolveProvider(first.id) };
  } catch {
    /* ignore */
  }
}
if (!resolved) {
  rmSync(cqrRoot, { recursive: true, force: true });
  done(
    {
      ok: !force,
      result: force ? 'fail' : 'skip',
      note: 'no configured provider for live plugin smoke',
    },
    force ? 1 : 0,
  );
}

const model =
  process.env.MY_AGENT_OWUI_SMOKE_MODEL?.trim()
  || process.env.CQR_OWUI_MODEL?.trim()
  || '';

const t0 = Date.now();
const statuses = [];
try {
  const result = await runCodeAgent({
    workspaceRoot: workspace,
    cqrRoot,
    userMessage: [
      '작업 모드: AGENT.',
      '이 PC에 로컬 플러그인으로 git 히스토리 트리를 추가해.',
      '반드시 도구: plugin_install confirm=true template_id=git_history_tree',
      '그다음 plugin_git_history_tree 호출 (max=5).',
      'builtin git_history_tree 쓰지 마. 채팅만 하지 마.',
      '끝나면 한 줄 요약.',
    ].join(' '),
    systemPrompt:
      'Code agent: first tools only. plugin_install template_id=git_history_tree confirm=true, then plugin_git_history_tree. Max 8 steps.',
    history: [],
    providerId: resolved.id,
    modelId: model || resolved.modelId || undefined,
    providerStore: store,
    nasWriteConsent: false,
    sessionId: `plugin-live-${Date.now()}`,
    autopilot: true,
    maxSteps: 10,
    forceToolPack: 'web_dev',
    mutationsOverride: true,
    onToolApproval: async () => true,
    onStatus: (s) => {
      const line = String(s).slice(0, 200);
      statuses.push(line);
      console.log(' ', line);
    },
  });

  const plugins = listAgentPlugins(cqrRoot);
  const onDisk = existsSync(
    path.join(cqrRoot, 'data', 'agent-plugins', 'git_history_tree', 'tool.json'),
  );
  const rec = getAgentPluginByToolName(cqrRoot, 'plugin_git_history_tree');
  const statusBlob = statuses.join('\n');
  const sawInstall =
    /plugin_install|Plugin catalog refreshed|git_history_tree/i.test(statusBlob)
    || onDisk;
  const sawUseInStatus = /plugin_git_history_tree/i.test(statusBlob);

  // Runner path evidence: if install landed, plugin must be invokable even if LLM stopped early.
  let runnerUseOk = false;
  let graphPreview = '';
  if (rec) {
    try {
      const { executeAgentTool } = await import(
        pathToFileURL(path.join(root, 'core', 'dist', 'agent', 'agent-tool-execute.js')).href
      );
      const used = await executeAgentTool(
        workspace,
        {
          id: 'post',
          type: 'function',
          function: { name: 'plugin_git_history_tree', arguments: '{"max":5}' },
        },
        {},
        { cqrRoot, sessionId: 'plugin-live-post' },
      );
      const body = JSON.parse(used.output);
      runnerUseOk = body.ok === true && Boolean(body.graph_ascii || body.graph);
      graphPreview = String(body.graph_ascii || body.graph || '').split('\n')[0] || '';
    } catch (e) {
      runnerUseOk = false;
      graphPreview = e instanceof Error ? e.message : String(e);
    }
  }

  const llmUsed = sawUseInStatus || /auto after install|Plugin install 후|Plugin 미호출/i.test(statusBlob);
  // Product path: install on disk + runner can execute graph (UI/agent can use after install)
  const productOk =
    onDisk && Boolean(rec) && sawInstall && runnerUseOk && (result?.steps ?? 0) > 0;
  // Full live pass: model itself also invoked the plugin tool
  const fullLlm = productOk && llmUsed;
  const partial = !fullLlm && productOk;

  rmSync(cqrRoot, { recursive: true, force: true });
  const inRunPluginExec =
    /실행 · plugin_git|auto after install|빈 응답 \+ pending plugin|plugin_git_history_tree/i.test(
      statusBlob,
    );
  done(
    {
      ok: fullLlm || partial,
      result: fullLlm ? 'pass' : partial ? 'partial' : 'fail',
      providerId: resolved.id,
      steps: result?.steps ?? 0,
      on_disk: onDisk,
      plugin_count: plugins.length,
      saw_install: sawInstall,
      llm_used_tool: llmUsed,
      runner_use_ok: runnerUseOk,
      saw_plugin_exec: inRunPluginExec,
      graph_preview: graphPreview.slice(0, 120),
      wall_ms: Date.now() - t0,
      content_preview: String(result?.content || '').slice(0, 240),
      note: fullLlm
        ? inRunPluginExec
          ? 'live install + in-run plugin exec (+summary)'
          : 'live install + pending resolve status; post-run runner graph OK'
        : partial
          ? 'live install OK; LLM skipped use — post-run runner graph OK'
          : (result?.steps ?? 0) > 0
            ? 'agent ran; install/use incomplete'
            : 'no install evidence',
    },
    fullLlm || partial ? 0 : 1,
  );
} catch (e) {
  try {
    rmSync(cqrRoot, { recursive: true, force: true });
  } catch {
    /* */
  }
  done(
    {
      ok: false,
      result: 'fail',
      error: e instanceof Error ? e.message : String(e),
      wall_ms: Date.now() - t0,
    },
    1,
  );
}
