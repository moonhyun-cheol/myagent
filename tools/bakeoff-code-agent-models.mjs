#!/usr/bin/env node
/**
 * Live model bake-off for code-agent default selection.
 * Same user command × multiple Open WebUI models → score mutate/split quality → print winner.
 *
 * Usage: node tools/bakeoff-code-agent-models.mjs
 * Env: MY_AGENT_BAKEOFF_MODELS=id1,id2 (optional override)
 *      MY_AGENT_BAKEOFF_APPLY=1 (also write defaults + vault model_id)
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MY_AGENT_ROOT = root;

const OUT_DIR = path.join(root, 'data', '_model_bakeoff');
const APPLY = process.env.MY_AGENT_BAKEOFF_APPLY === '1';

const USER_CMD = [
  'tools.ts에서 CODE_AGENT_TOOLS 정의를 agent-tool-definitions.ts로 분리해.',
  'tools.ts는 re-export façade만 남겨.',
  '반드시 write_file 또는 apply_patch로 디스크에 반영하고, query_repo_map으로 구조 확인 후 run_diagnostics까지 돌려.',
  '부분만 했으면 부분 반영이라고 말하고, 없으면 완료라고 하지 마.',
].join(' ');

const DEFAULT_CANDIDATES = [
  'open_webui_openrouter_integration.openai.gpt-5.6-terra-pro',
  'open_webui_openrouter_integration.openai.gpt-5.5-pro',
  'open_webui_openrouter_integration.openai.gpt-5.6-sol-pro',
  'open_webui_openrouter_integration.openai.gpt-5.3-codex',
  'open_webui_openrouter_integration.anthropic.claude-opus-4.8',
  'open_webui_openrouter_integration.moonshotai.kimi-k2.7-code',
  'open_webui_openrouter_integration.qwen.qwen3.7-max',
];

function shortModel(id) {
  return String(id).replace(/^open_webui_openrouter_integration\./, '');
}

function ensureBuild() {
  if (existsSync(path.join(root, 'core/dist/agent/code-agent.js'))) return;
  const r = spawnSync(process.execPath, [path.join(root, 'tools/build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function seedFixture(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'core/src/agent'), { recursive: true });
  writeFileSync(
    path.join(dir, 'core/src/agent/tools.ts'),
    [
      'export interface AgentToolDefinition { type: "function"; function: { name: string } }',
      'export const CODE_AGENT_TOOLS: AgentToolDefinition[] = [',
      '  { type: "function", function: { name: "read_file" } },',
      '  { type: "function", function: { name: "write_file" } },',
      '];',
      'export function normalizeToolName(n: string) { return n; }',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'bakeoff-fixture', private: true, type: 'module' }, null, 2),
  );
}

function scoreRun({ fixture, answer, statuses, ms, error }) {
  const defsPath = path.join(fixture, 'core/src/agent/agent-tool-definitions.ts');
  const toolsPath = path.join(fixture, 'core/src/agent/tools.ts');
  const hasDefs = existsSync(defsPath);
  const toolsBody = existsSync(toolsPath) ? readFileSync(toolsPath, 'utf8') : '';
  const isFacade =
    /export\s*\{[^}]*CODE_AGENT_TOOLS[^}]*\}\s*from\s*['"].*agent-tool-definitions/.test(toolsBody)
    || (/from\s*['"].*agent-tool-definitions/.test(toolsBody)
      && !/CODE_AGENT_TOOLS\s*[:=]\s*\[/.test(toolsBody));
  const statusBlob = statuses.join('\n');
  const usedRetrieval = /query_repo_map|search_embeddings|search_files/i.test(statusBlob);
  const usedMutate = /write_file|edit_file|apply_patch/i.test(statusBlob);
  const usedDiag = /run_diagnostics|diagnostics/i.test(statusBlob);
  const claimsDone = /(?:완료했|반영했|수정했|분리했)/i.test(answer || '');
  const claimsPartial = /부분\s*반영|미완|다음\s*단계/i.test(answer || '');
  const honest =
    (hasDefs && isFacade)
    || (claimsPartial && !hasDefs)
    || (!claimsDone && !hasDefs);

  let score = 0;
  const detail = [];
  if (error) {
    detail.push(`error:${String(error).slice(0, 80)}`);
    return { score: -100, hasDefs, isFacade, usedRetrieval, usedMutate, usedDiag, honest, ms, detail, answer: answer || '' };
  }
  if (hasDefs) { score += 40; detail.push('+defs'); }
  if (isFacade) { score += 25; detail.push('+facade'); }
  if (usedRetrieval) { score += 10; detail.push('+retrieval'); }
  if (usedMutate) { score += 15; detail.push('+mutate'); }
  if (usedDiag) { score += 5; detail.push('+diag'); }
  if (honest) { score += 10; detail.push('+honest'); }
  else { score -= 20; detail.push('-false_complete'); }
  if (ms > 180_000) { score -= 5; detail.push('-slow'); }
  return { score, hasDefs, isFacade, usedRetrieval, usedMutate, usedDiag, honest, ms, detail, answer: (answer || '').slice(0, 500) };
}

function listAvailableModels(ids) {
  const livePath = path.join(root, 'data/owui-models-live.json');
  if (!existsSync(livePath)) return ids;
  try {
    const j = JSON.parse(readFileSync(livePath, 'utf8'));
    const rows = Array.isArray(j) ? j : (j.data || j.models || []);
    const set = new Set(rows.map((r) => (typeof r === 'string' ? r : r.id || r.name)).filter(Boolean));
    return ids.filter((id) => set.has(id));
  } catch {
    return ids;
  }
}

async function main() {
  ensureBuild();
  mkdirSync(OUT_DIR, { recursive: true });

  const { ProviderStore } = await import(
    pathToFileURL(path.join(root, 'core/dist/providers/provider-store.js')).href
  );
  const { runCodeAgent } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/code-agent.js')).href
  );
  const {
    clientToolProtocolCacheKey,
    rememberClientToolProtocol,
    clearClientToolProtocol,
  } = await import(
    pathToFileURL(path.join(root, 'core/dist/providers/openai-compatible.js')).href
  );

  const store = new ProviderStore(path.join(root, 'data/vault/provider-keys.json'), root);
  const resolvedCustom = store.resolveProvider('custom');
  if (!resolvedCustom) {
    console.error('custom provider not configured');
    process.exit(1);
  }

  const envList = process.env.MY_AGENT_BAKEOFF_MODELS?.split(',').map((s) => s.trim()).filter(Boolean);
  let candidates = listAvailableModels(envList?.length ? envList : DEFAULT_CANDIDATES);
  if (!candidates.length) candidates = DEFAULT_CANDIDATES.slice(0, 4);
  // Cap to keep runtime reasonable
  candidates = candidates.slice(0, Number(process.env.MY_AGENT_BAKEOFF_LIMIT || 6));
  const perModelMs = Number(process.env.MY_AGENT_BAKEOFF_TIMEOUT_MS || 180_000);
  // OWUI native tools often hang; force TEXT TOOL_CALL for fair bake-off unless overridden.
  const forceClient =
    process.env.MY_AGENT_BAKEOFF_FORCE_CLIENT !== '0';

  console.log('Bake-off command:\n', USER_CMD, '\n');
  console.log('Candidates:', candidates.map(shortModel).join(', '));
  console.log(`Timeout/model: ${perModelMs}ms  forceClientToolProtocol=${forceClient}`);

  const results = [];

  for (const modelId of candidates) {
    const slug = shortModel(modelId).replace(/[^\w.-]+/g, '_');
    const fixture = path.join(OUT_DIR, `ws_${slug}`);
    seedFixture(fixture);
    const statuses = [];
    const t0 = Date.now();
    let answer = '';
    let error = null;
    const protocolKey = clientToolProtocolCacheKey('custom', resolvedCustom.baseUrl, modelId);
    if (forceClient) {
      rememberClientToolProtocol(protocolKey, 'API tools returned no tool_calls');
    } else {
      clearClientToolProtocol(protocolKey);
    }
    console.log(`\n=== ${shortModel(modelId)} ===`);
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), perModelMs);
      try {
        const agent = await runCodeAgent({
          workspaceRoot: fixture,
          userMessage: USER_CMD,
          systemPrompt: 'You are the MY Agent code agent. Use tools. Prefer apply_patch/write_file.',
          workspaceContext: 'Fixture workspace for model bake-off. Only core/src/agent/tools.ts exists initially.',
          history: [],
          providerId: 'custom',
          modelId,
          providerStore: store,
          nasWriteConsent: false,
          cqrRoot: root,
          sessionId: `bakeoff-${slug}`,
          playwrightHeadless: true,
          playwrightAllowLocalhost: false,
          signal: ac.signal,
          onStatus: (s) => {
            statuses.push(s);
            if (/Tool:|작업 모드|retrieval|ERROR|diagnostics|write_file|apply_patch|query_repo|TEXT/i.test(s)) {
              console.log(' ', s.slice(0, 140));
            }
          },
          onAnswer: (t) => {
            answer = t;
          },
        });
        answer = agent.content || answer;
      } finally {
        clearTimeout(timer);
        clearClientToolProtocol(protocolKey);
      }
    } catch (e) {
      error = e?.message || String(e);
      if (acAborted(error) || /aborted|AbortError/i.test(error)) {
        error = `timeout ${perModelMs}ms`;
      }
      console.log('  ERROR', error.slice(0, 200));
      clearClientToolProtocol(protocolKey);
    }
    const ms = Date.now() - t0;
    const scored = scoreRun({ fixture, answer, statuses, ms, error });
    const row = { modelId, short: shortModel(modelId), ...scored };
    results.push(row);
    console.log(
      `  score=${scored.score} defs=${scored.hasDefs} facade=${scored.isFacade} retrieval=${scored.usedRetrieval} mutate=${scored.usedMutate} ${ms}ms`,
      scored.detail.join(' '),
    );
    writeFileSync(
      path.join(OUT_DIR, `result_${slug}.json`),
      JSON.stringify({ ...row, statuses: statuses.slice(-40) }, null, 2),
    );
  }

  results.sort((a, b) => b.score - a.score || a.ms - b.ms);
  // Prefer models that finished with positive score; on all-timeout, pick least-bad.
  let winner = results.find((r) => r.score > 0) || null;
  if (!winner) {
    winner = results[0] || null;
  }

  const { collectPerfEnv } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-perf-metrics.js')).href
  );
  let baseUrlHost;
  try {
    baseUrlHost = new URL(resolvedCustom.baseUrl).host;
  } catch {
    baseUrlHost = undefined;
  }
  const summary = {
    at: new Date().toISOString(),
    command: USER_CMD,
    forceClient,
    protocol: forceClient ? 'client' : 'api',
    wall_ms: results.reduce((a, r) => a + (r.ms || 0), 0),
    env: collectPerfEnv({
      modelId: winner?.modelId,
      baseUrlHost,
      protocol: forceClient ? 'client' : 'api',
    }),
    winner: winner?.modelId ?? null,
    ranking: results.map((r) => ({
      model: r.short,
      score: r.score,
      hasDefs: r.hasDefs,
      isFacade: r.isFacade,
      wall_ms: r.ms,
      ms: r.ms,
      protocol: forceClient ? 'client' : 'api',
      detail: r.detail,
    })),
  };
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n=== RANKING ===');
  for (const r of results) {
    console.log(`${String(r.score).padStart(4)}  ${r.short}  (${r.ms}ms)  ${r.detail.join(' ')}`);
  }
  console.log('\nWinner:', winner?.short || '(none)');

  if (APPLY && winner?.modelId && (winner.score > 0 || results.every((r) => r.score <= 0))) {
    // If all failed agent loop, still set default to fastest/least-bad coding candidate for product use,
    // but only when score>0 OR user forced apply with MY_AGENT_BAKEOFF_APPLY_WEAK=1
    if (winner.score > 0 || process.env.MY_AGENT_BAKEOFF_APPLY_WEAK === '1') {
      applyDefaultModel(store, winner.modelId);
      console.log('Applied as default:', winner.short);
    } else {
      console.log('No positive-score winner — defaults unchanged (set MY_AGENT_BAKEOFF_APPLY_WEAK=1 to force).');
    }
  } else if (!APPLY) {
    console.log('\n(Dry run) Re-run with MY_AGENT_BAKEOFF_APPLY=1 to write defaults.');
  } else {
    console.log('\nNo winner — defaults unchanged.');
  }
}

function applyDefaultModel(store, modelId) {
  const suffix = shortModel(modelId);
  // deploy-defaults
  const deployPath = path.join(root, 'core/config/defaults/deploy-defaults.json');
  const deploy = JSON.parse(readFileSync(deployPath, 'utf8'));
  deploy.openwebui_default_model = modelId;
  writeFileSync(deployPath, `${JSON.stringify(deploy, null, 2)}\n`);

  // providers catalog custom default
  const providersPath = path.join(root, 'core/config/defaults/providers.json');
  const providers = JSON.parse(readFileSync(providersPath, 'utf8'));
  for (const p of providers.providers || []) {
    if (p.id === 'custom') p.default_model = modelId;
  }
  writeFileSync(providersPath, `${JSON.stringify(providers, null, 2)}\n`);

  // curate suffix
  const curatePath = path.join(root, 'core/config/defaults/openwebui-model-curate.json');
  const curate = JSON.parse(readFileSync(curatePath, 'utf8'));
  const prev = curate.default_model_suffix;
  curate.default_model_suffix = suffix;
  if (prev && prev !== suffix) {
    curate.default_model_suffix_fallbacks = [
      prev,
      ...(curate.default_model_suffix_fallbacks || []).filter((x) => x !== suffix && x !== prev),
    ].slice(0, 6);
  }
  writeFileSync(curatePath, `${JSON.stringify(curate, null, 2)}\n`);

  // vault model_id for custom (keep existing key)
  const secret = store.getSecret('custom');
  if (secret?.api_key) {
    store.saveKey('custom', secret.api_key, {
      base_url: secret.base_url,
      model_id: modelId,
    });
  }
}

await main();

function acAborted(msg) {
  return /aborted|AbortError|The operation was aborted/i.test(String(msg || ''));
}
