#!/usr/bin/env node
/**
 * Live probe: MY Agent code agent builds 발주추적 app in a real workspace.
 * Usage: node tools/probe-order-tracker-agent.mjs
 * Env: MY_AGENT_PROBE_MODEL, MY_AGENT_PROBE_TIMEOUT_MS (default 900000)
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MY_AGENT_ROOT = root;
process.env.MY_AGENT_CODE_AUTOPILOT = process.env.MY_AGENT_CODE_AUTOPILOT || '1';

const WORKSPACE = process.env.MY_AGENT_PROBE_WORKSPACE
  || 'C:\\Users\\Temp\\Desktop\\업무\\발주추적';
const OUT_LOG = path.join(root, 'data', '_probe_order_tracker', 'run-log.jsonl');
const TIMEOUT_MS = Number(process.env.MY_AGENT_PROBE_TIMEOUT_MS || 900_000);
const MODEL =
  process.env.MY_AGENT_PROBE_MODEL
  || 'open_webui_openrouter_integration.anthropic.claude-opus-4.8';

const RESUME = process.env.MY_AGENT_PROBE_RESUME === '1'
  || existsSync(path.join(WORKSPACE, 'styles.css'));

const USER_CMD = RESUME
  ? [
      '이어서. 워크스페이스에 data/seed.json·styles.css는 이미 있음.',
      '아직 없는 index.html, app.js, README.md를 write_file로 생성해라.',
      '먼저 list_directory path="." 한 뒤 바로 세 파일을 써라. run_terminal은 confirm=true 로 node --check app.js 만.',
      '제품: 나일론컴포트, 어센트팬츠, CN냉감팬츠 — 일간 주문·재고·누적.',
      'PR: TXP805, TXP900, TXS803, TXP110, TSP202 — 상태/메모/날짜.',
      'localStorage 영속, 한국어 UI, CSV 내보내기. npm 의존성 금지.',
    ].join('\n')
  : [
      '빈 폴더에 발주 추적 웹앱을 처음부터 만들어라. 외부 npm 의존성 없이 로컬에서 바로 열리게.',
      '',
      '제품(일간 주문량·남은 재고·누적 주문 추적): 나일론컴포트, 어센트팬츠, CN냉감팬츠',
      'PR 코드 추적: TXP805, TXP900, TXS803, TXP110, TSP202 (상태/메모/날짜)',
      '',
      '필수 파일:',
      '- index.html (UI 진입)',
      '- app.js (로직; localStorage 영속)',
      '- styles.css',
      '- README.md (실행 방법: index.html 더블클릭 또는 npx serve)',
      '- data/seed.json (초기 시드 데이터)',
      '',
      '기능: 일별 주문 입력, 재고 차감/입고, PR 상태 보드, 오늘/기간 요약, CSV보내기.',
      '한국어 UI. 새 파일 쓰기 전 list_directory "." 선행. run_terminal은 confirm=true + node --check 만.',
      '완료 시 생성 파일 목록과 사용법을 짧게 보고.',
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
        const sz = statSync(path.join(d, e.name)).size;
        out.push(`${rel} (${sz}b)`);
      }
    }
  };
  walk(dir);
  return out;
}

async function main() {
  ensureBuild();
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(path.dirname(OUT_LOG), { recursive: true });

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
    console.error('FAIL: custom provider not configured (OWUI gateway)');
    process.exit(2);
  }

  const statuses = [];
  let answer = '';
  const t0 = Date.now();
  const protocolKey = clientToolProtocolCacheKey('custom', resolvedCustom.baseUrl, MODEL);
  // Prefer client TOOL_CALL for coding reliability unless probe mode already set.
  if (process.env.MY_AGENT_PROBE_FORCE_CLIENT !== '0') {
    rememberClientToolProtocol(protocolKey, 'probe-order-tracker force client protocol');
  }

  console.log(`workspace: ${WORKSPACE}`);
  console.log(`model: ${MODEL}`);
  console.log(`timeout: ${TIMEOUT_MS}ms`);
  console.log(`resume: ${RESUME}`);
  console.log('--- agent start ---');
  writeFileSync(OUT_LOG, '');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let result = null;
  let error = null;
  try {
    result = await runCodeAgent({
      workspaceRoot: WORKSPACE,
      userMessage: USER_CMD,
      systemPrompt:
        'You are the MY Agent code agent. Prefer write_file. Korean UI. No invented 완료. After list_directory, write missing files in the same turn.',
      workspaceContext: RESUME
        ? 'Partial workspace: data/seed.json and styles.css exist. Missing: index.html, app.js, README.md. Continue.'
        : 'Empty project folder for order/PR tracking web app. Create all files under workspace root.',
      history: [],
      providerId: 'custom',
      modelId: MODEL,
      providerStore: store,
      nasWriteConsent: false,
      cqrRoot: root,
      sessionId: 'probe-order-tracker',
      playwrightHeadless: true,
      playwrightAllowLocalhost: false,
      autopilot: true,
      forceToolPack: 'web_dev',
      signal: ac.signal,
      // Headless: no chat UI — auto-approve HITL (run_terminal / large write).
      onToolApproval: async (req) => {
        console.log(`  [auto-approve] ${req.summary}`);
        return true;
      },
      onStatus: (s) => {
        statuses.push(s);
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

  const ms = Date.now() - t0;
  const tree = listTree(WORKSPACE);
  const must = ['index.html', 'app.js', 'styles.css', 'README.md'];
  const present = must.filter((f) => existsSync(path.join(WORKSPACE, f)));
  const missing = must.filter((f) => !existsSync(path.join(WORKSPACE, f)));
  const summary = {
    ok: !error && missing.length === 0,
    ms,
    steps: result?.steps ?? null,
    model: result?.model || MODEL,
    mutatedPaths: result?.mutatedPaths ?? [],
    early_exit_reason: inferEarlyExitReason({
      content: String(answer || ''),
      mutatedCount: (result?.mutatedPaths ?? []).length,
      aborted: Boolean(error && /abort/i.test(String(error))),
    }),
    present,
    missing,
    tree,
    error: error ? String(error?.message || error).slice(0, 400) : null,
    answerPreview: String(answer || '').slice(0, 1200),
  };
  writeFileSync(
    path.join(root, 'data', '_probe_order_tracker', 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
  console.log('--- agent end ---');
  console.log(JSON.stringify({
    ok: summary.ok,
    ms: summary.ms,
    steps: summary.steps,
    present: summary.present,
    missing: summary.missing,
    error: summary.error,
  }, null, 2));
  console.log('tree:');
  for (const row of tree.slice(0, 40)) console.log(' ', row);
  if (summary.answerPreview) {
    console.log('--- answer preview ---');
    console.log(summary.answerPreview);
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
