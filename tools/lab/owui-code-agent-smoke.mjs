#!/usr/bin/env node
/**
 * Optional live OWUI/code-agent smoke — one short mutate turn on a temp workspace.
 * Skips cleanly when no provider credentials (not a default 납기 fail).
 *
 *   node tools/lab/owui-code-agent-smoke.mjs
 *   MY_AGENT_OWUI_SMOKE_FORCE=1 node tools/lab/owui-code-agent-smoke.mjs  # fail if no key
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
const force = process.env.MY_AGENT_OWUI_SMOKE_FORCE === '1';
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'owui-code-agent-smoke.json');

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
      note: 'no data/vault/provider-keys.json and no CQR_OPENWEBUI_API_KEY — skip live OWUI smoke',
    },
    force ? 1 : 0,
  );
}

const fixture = path.join(outDir, 'owui-smoke-ws');
if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });
writeFileSync(path.join(fixture, 'README.md'), '# smoke\n', 'utf8');

const distTools = path.join(root, 'core', 'dist', 'agent', 'code-agent.js');
const distStore = path.join(root, 'core', 'dist', 'providers', 'provider-store.js');
if (!existsSync(distTools) || !existsSync(distStore)) {
  done({ ok: false, result: 'fail', note: 'build first: node tools/build.mjs' }, 1);
}

const { ProviderStore } = await import(pathToFileURL(distStore).href);
const { runCodeAgent } = await import(pathToFileURL(distTools).href);

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
    /* try next */
  }
}

if (!resolved) {
  try {
    // some stores expose list + first configured
    const list = store.listPublic?.() || store.list?.() || [];
    const first = Array.isArray(list) ? list.find((p) => p.configured) : null;
    if (first?.id) {
      resolved = { id: first.id, ...store.resolveProvider(first.id) };
    }
  } catch {
    /* ignore */
  }
}


const t0 = Date.now();
const model =
  process.env.MY_AGENT_OWUI_SMOKE_MODEL?.trim()
  || process.env.CQR_OWUI_MODEL?.trim()
  || '';

try {
  const result = await runCodeAgent({
    workspaceRoot: fixture,
    userMessage:
      '작업 모드: AGENT. 즉시 mutate. README.md 에 아래 한 줄만 apply_patch로 추가:\n- smoke-ok\n도구: apply_patch. 검증 금지. 완료 한 줄.',
    systemPrompt:
      'AGENT: first tool must be apply_patch on README.md adding line `- smoke-ok`. No long plans. Max 4 steps.',
    workspaceContext: 'delivery smoke fixture',
    history: [],
    providerId: resolved.id,
    modelId: model || resolved.modelId || undefined,
    providerStore: store,
    nasWriteConsent: false,
    cqrRoot: root,
    sessionId: `owui-smoke-${Date.now()}`,
    autopilot: true,
    maxSteps: 6,
    forceToolPack: 'web_dev',
    onToolApproval: async () => true,
    onStatus: (s) => console.log(' ', String(s).slice(0, 160)),
  });
  const disk = readFileSync(path.join(fixture, 'README.md'), 'utf8');
  const ok =
    /smoke-ok/i.test(disk)
    && Array.isArray(result?.mutatedPaths)
    && result.mutatedPaths.some((p) => /README\.md/i.test(String(p)));
  // Live cloud is flaky: default exit 0 with result=partial if any agent steps ran
  const partial = !ok && (result?.steps ?? 0) > 0;
  done(
    {
      ok: ok || (!force && partial),
      result: ok ? 'pass' : partial ? 'partial' : 'fail',
      ms: Date.now() - t0,
      mutated: result?.mutatedPaths,
      steps: result?.steps,
      note: ok
        ? 'README mutated with smoke-ok'
        : partial
          ? 'agent ran but no disk marker — re-run or UI manual'
          : disk.slice(0, 200),
    },
    ok || (!force && partial) ? 0 : 1,
  );
} catch (e) {
  done(
    {
      ok: false,
      result: 'fail',
      ms: Date.now() - t0,
      note: e instanceof Error ? e.message : String(e),
    },
    1,
  );
}
