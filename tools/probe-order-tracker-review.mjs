#!/usr/bin/env node
/**
 * Live review+fix probe for 발주추적 workspace via MY Agent code agent.
 * Usage: node tools/probe-order-tracker-review.mjs
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MY_AGENT_ROOT = root;
process.env.MY_AGENT_CODE_AUTOPILOT = process.env.MY_AGENT_CODE_AUTOPILOT || '1';

const WORKSPACE = process.env.MY_AGENT_PROBE_WORKSPACE
  || 'C:\\Users\\Temp\\Desktop\\업무\\발주추적';
const OUT_DIR = path.join(root, 'data', '_probe_order_tracker');
const OUT_LOG = path.join(OUT_DIR, 'review-log.jsonl');
const TIMEOUT_MS = Number(process.env.MY_AGENT_PROBE_TIMEOUT_MS || 900_000);
const MODEL =
  process.env.MY_AGENT_PROBE_MODEL
  || 'open_webui_openrouter_integration.anthropic.claude-opus-4.8';

const USER_CMD = [
  '기존 발주추적 웹앱을 리뷰하고 버그·누락을 고친 뒤 검증해라. npm 의존성 추가 금지.',
  '',
  '반드시 확인할 오류/개선 (발견되면 apply_patch/edit_file로 수정):',
  '1) todayStr() UTC(toISOString) → 한국 로컬 날짜로 수정',
  '2) 주문 삭제 후 인덱스/정렬 안전성',
  '3) 재고 초과 주문 방지 + 입고(재고 증가) UI',
  '4) 오늘 주문량·잔여재고 요약 KPI (styles.css .summary/.kpi 활용)',
  '5) seed 로드 실패/빈 products 시 사용자에게 보이는 안내',
  '6) PR 코드 TXP805,TXP900,TXS803,TXP110,TSP202 / 제품 3종 유지',
  '',
  '절차: list_directory → read_file(app.js,index.html,styles.css,seed) → 수정 → run_terminal confirm=true 로 node --check app.js',
  '완료 시: 고친 목록 + 남은 리스크를 짧게. 거짓 완료 금지.',
].join('\n');

function ensureBuild() {
  if (existsSync(path.join(root, 'core/dist/agent/code-agent.js'))) return;
  const r = spawnSync(process.execPath, [path.join(root, 'tools/build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function listTree(dir, max = 80) {
  const out = [];
  const walk = (d, prefix = '') => {
    if (out.length >= max) return;
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) break;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(path.join(d, e.name), rel);
      } else {
        out.push(`${rel} (${statSync(path.join(d, e.name)).size}b)`);
      }
    }
  };
  walk(dir);
  return out;
}

function staticChecks() {
  const app = readFileSync(path.join(WORKSPACE, 'app.js'), 'utf8');
  const html = readFileSync(path.join(WORKSPACE, 'index.html'), 'utf8');
  const seed = JSON.parse(readFileSync(path.join(WORKSPACE, 'data/seed.json'), 'utf8'));
  const syn = spawnSync(process.execPath, ['--check', path.join(WORKSPACE, 'app.js')], {
    encoding: 'utf8',
  });
  return {
    syntaxOk: syn.status === 0,
    syntaxErr: (syn.stderr || syn.stdout || '').slice(0, 300),
    localDate: /getFullYear|toLocaleDateString|Asia\/Seoul|padStart\(2/.test(app)
      && !/toISOString\(\)\.slice\(0,\s*10\)/.test(app),
    hasInbound: /입고|inbound|stock\s*\+|btn-.*stock|addStock/i.test(app + html),
    hasKpi: /summary|kpi|오늘/.test(app + html),
    stockGuard: /재고|초과|remain|잔여/.test(app) && /alert|return/.test(app),
    products: (seed.products || []).map((p) => p.name),
    pr: (seed.prCodes || []).map((p) => p.code),
  };
}

async function main() {
  ensureBuild();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_LOG, '');

  const before = staticChecks();
  console.log('before:', JSON.stringify(before, null, 2));

  const { ProviderStore } = await import(
    pathToFileURL(path.join(root, 'core/dist/providers/provider-store.js')).href
  );
  const { runCodeAgent } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/code-agent.js')).href
  );
  const { inferEarlyExitReason } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-perf-metrics.js')).href
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
    console.error('FAIL: custom provider not configured');
    process.exit(2);
  }

  let answer = '';
  const t0 = Date.now();
  const protocolKey = clientToolProtocolCacheKey('custom', resolvedCustom.baseUrl, MODEL);
  if (process.env.MY_AGENT_PROBE_FORCE_CLIENT !== '0') {
    rememberClientToolProtocol(protocolKey, 'probe-order-tracker-review force client');
  }

  console.log(`workspace: ${WORKSPACE}`);
  console.log(`model: ${MODEL}`);
  console.log('--- review agent start ---');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let result = null;
  let error = null;
  try {
    result = await runCodeAgent({
      workspaceRoot: WORKSPACE,
      userMessage: USER_CMD,
      systemPrompt:
        'You are MY Agent code agent in review+fix mode. Read first, then mutate. Korean summary. No false 완료.',
      workspaceContext:
        'Existing order/PR tracker SPA (index.html, app.js, styles.css, data/seed.json). Review and fix bugs.',
      history: [],
      providerId: 'custom',
      modelId: MODEL,
      providerStore: store,
      nasWriteConsent: false,
      cqrRoot: root,
      sessionId: 'probe-order-tracker-review',
      playwrightHeadless: true,
      playwrightAllowLocalhost: false,
      autopilot: true,
      forceToolPack: 'web_dev',
      signal: ac.signal,
      onToolApproval: async (req) => {
        console.log(`  [auto-approve] ${req.summary}`);
        return true;
      },
      onStatus: (s) => {
        const line = String(s).slice(0, 200);
        console.log(' ', line);
        writeFileSync(OUT_LOG, `${JSON.stringify({ t: Date.now() - t0, s: line })}\n`, { flag: 'a' });
      },
      onAnswer: (t) => {
        answer = t;
      },
    });
    answer = result?.content || answer;
  } catch (e) {
    error = e;
  } finally {
    clearTimeout(timer);
    clearClientToolProtocol(protocolKey);
  }

  const after = staticChecks();
  const summary = {
    ok: !error && after.syntaxOk && after.localDate && after.hasInbound && after.hasKpi,
    ms: Date.now() - t0,
    steps: result?.steps ?? null,
    mutatedPaths: result?.mutatedPaths ?? [],
    early_exit_reason: inferEarlyExitReason({
      content: String(answer || ''),
      mutatedCount: (result?.mutatedPaths ?? []).length,
      aborted: Boolean(error && /abort/i.test(String(error))),
    }),
    before,
    after,
    error: error ? String(error?.message || error).slice(0, 400) : null,
    answerPreview: String(answer || '').slice(0, 1500),
    tree: listTree(WORKSPACE),
  };
  writeFileSync(path.join(OUT_DIR, 'review-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('--- review agent end ---');
  console.log(JSON.stringify({
    ok: summary.ok,
    ms: summary.ms,
    steps: summary.steps,
    mutated: summary.mutatedPaths,
    after: {
      syntaxOk: after.syntaxOk,
      localDate: after.localDate,
      hasInbound: after.hasInbound,
      hasKpi: after.hasKpi,
      stockGuard: after.stockGuard,
      products: after.products,
      pr: after.pr,
    },
    error: summary.error,
  }, null, 2));
  if (summary.answerPreview) {
    console.log('--- answer ---');
    console.log(summary.answerPreview);
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
