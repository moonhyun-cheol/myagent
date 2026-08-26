#!/usr/bin/env node
/** Fix missing index.html DOM ids for 발주추적 (MY Agent live). */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MY_AGENT_ROOT = root;
process.env.MY_AGENT_CODE_AUTOPILOT = '1';

const WORKSPACE = process.env.MY_AGENT_PROBE_WORKSPACE
  || 'C:\\Users\\Temp\\Desktop\\업무\\발주추적';
const MODEL =
  process.env.MY_AGENT_PROBE_MODEL
  || 'open_webui_openrouter_integration.anthropic.claude-opus-4.8';
const OUT = path.join(root, 'data', '_probe_order_tracker', 'wire-fix-summary.json');
mkdirSync(path.dirname(OUT), { recursive: true });

const USER_CMD = [
  '버그 수정만. index.html에 app.js가 찾는 DOM이 빠져 있다.',
  '필수 id: notice, summary, restock-product, restock-qty, btn-restock',
  'summary는 class="grid summary", notice는 안내 영역(class mut 가능).',
  '입고 UI는 주문 등록 섹션 바로 아래 row로 배치.',
  'read_file로 index.html과 app.js 확인 후 edit_file/apply_patch로 index.html만 수정.',
  'styles.css의 .summary/.kpi 재사용. npm 금지. 짧게 보고.',
].join('\n');

function missingIds() {
  const app = readFileSync(path.join(WORKSPACE, 'app.js'), 'utf8');
  const html = readFileSync(path.join(WORKSPACE, 'index.html'), 'utf8');
  const idsInHtml = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
  const getIds = [...app.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  return [...new Set(getIds)].filter(
    (id) => !idsInHtml.includes(id) && !app.includes(`id="${id}"`) && !app.includes(`id='${id}'`),
  );
}

async function main() {
  const before = missingIds();
  console.log('missing before:', before);

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
  const resolved = store.resolveProvider('custom');
  if (!resolved) {
    console.error('FAIL: custom provider missing');
    process.exit(2);
  }
  const key = clientToolProtocolCacheKey('custom', resolved.baseUrl, MODEL);
  rememberClientToolProtocol(key, 'wire-fix');

  const t0 = Date.now();
  let answer = '';
  let result = null;
  let error = null;
  try {
    result = await runCodeAgent({
      workspaceRoot: WORKSPACE,
      userMessage: USER_CMD,
      systemPrompt: 'Fix HTML wiring only. Mutate index.html. No false 완료.',
      workspaceContext:
        'SPA order tracker. app.js already has KPI/restock; index.html missing ids: '
        + before.join(', '),
      history: [],
      providerId: 'custom',
      modelId: MODEL,
      providerStore: store,
      nasWriteConsent: false,
      cqrRoot: root,
      sessionId: 'probe-order-tracker-wire',
      playwrightHeadless: true,
      autopilot: true,
      forceToolPack: 'web_dev',
      onToolApproval: async (req) => {
        console.log('  [auto-approve]', req.summary);
        return true;
      },
      onStatus: (s) => console.log(' ', String(s).slice(0, 180)),
      onAnswer: (t) => {
        answer = t;
      },
    });
    answer = result?.content || answer;
  } catch (e) {
    error = e;
  } finally {
    clearClientToolProtocol(key);
  }

  const after = missingIds();
  const summary = {
    ok: !error && after.length === 0 && existsSync(path.join(WORKSPACE, 'index.html')),
    ms: Date.now() - t0,
    steps: result?.steps ?? null,
    mutated: result?.mutatedPaths ?? [],
    before,
    after,
    error: error ? String(error.message || error).slice(0, 400) : null,
    answer: String(answer).slice(0, 1200),
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    ok: summary.ok,
    ms: summary.ms,
    steps: summary.steps,
    mutated: summary.mutated,
    before: summary.before,
    after: summary.after,
    error: summary.error,
  }, null, 2));
  if (summary.answer) {
    console.log('--- answer ---');
    console.log(summary.answer);
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
