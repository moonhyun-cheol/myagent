#!/usr/bin/env node
/**
 * Market-research pipeline wiring: output location, exit/stdout JSON parsing,
 * failure-kind messages, no stale-report reuse, and chat-fallback only when the
 * pipeline genuinely cannot run. Uses a fake process (no real Python).
 */
import assert from 'node:assert/strict';
import path from 'node:path';

const mod = await import('../core/dist/skills/market-pipeline-runner.js');
const {
  runMarketPipeline,
  interpretMarketPipelineResult,
  parsePipelineResultJson,
  resolveMarketStateDir,
} = mod;

const STATE_DIR = path.join('C:', 'Users', 'tester', 'AppData', 'Local', 'MYAgent', 'organization', 'market_research');
process.env.CQR_MARKET_STATE_DIR = STATE_DIR;

const FAKE_ORG_ROOT = path.join('C:', 'org', 'modules', 'organization');

function readyCapability(overrides = {}) {
  return {
    available: true,
    status: 'ready',
    message_ko: 'ok',
    org_root: FAKE_ORG_ROOT,
    script: null,
    pipeline_entry: path.join(FAKE_ORG_ROOT, 'pipelines', 'market_research.py'),
    pipeline_venv: path.join('C:', 'venv', 'python.exe'),
    python: path.join('C:', 'venv', 'python.exe'),
    ...overrides,
  };
}

const json = (obj) => `log line before\n${JSON.stringify(obj, null, 2)}\nMD=whatever`;

// --- parser: last market_research object from noisy multi-line stdout ---
{
  const parsed = parsePipelineResultJson(
    'starting...\n{\n  "noise": 1\n}\n' + json({ ok: false, pipeline: 'market_research', status: 'missing_deps', missing: ['chromadb'] }),
  );
  assert.equal(parsed.status, 'missing_deps');
  assert.equal(parsePipelineResultJson('no json here'), null);
}

// --- Case 1: missing_deps → visible failure, NOT fallback ---
{
  const r = runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: '2027 FW slacks',
    capabilityOverride: readyCapability(),
    spawnOverride: () => ({
      status: 1,
      stdout: json({ ok: false, pipeline: 'market_research', phase: 'research', status: 'missing_deps', missing: ['langgraph', 'chromadb'] }),
      stderr: '',
    }),
    readReportOverride: () => null,
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, false, 'case1 not ok');
  assert.equal(r.status, 'missing_deps');
  assert.equal(r.used_fallback_chat, false, 'case1 must not fall back to chat');
  assert.match(r.error, /키트/);
  assert.match(r.error, /langgraph, chromadb/);
}

// --- Case 2: missing_api_key → key guidance ---
{
  const r = runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'feasibility',
    brief: 'brief',
    capabilityOverride: readyCapability(),
    spawnOverride: () => ({
      status: 1,
      stdout: json({ ok: false, pipeline: 'market_research', phase: 'feasibility', status: 'missing_api_key', provider: 'openai', missing: ['OPENAI_API_KEY'] }),
      stderr: '',
    }),
    readReportOverride: () => null,
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'missing_api_key');
  assert.equal(r.used_fallback_chat, false);
  assert.match(r.error, /OPENAI_API_KEY/);
  assert.match(r.error, /LLM 연결/);
}

// --- Case 3: entry claims ok but only a STALE report exists → not returned as new ---
{
  const r = interpretMarketPipelineResult({
    phase: 'research',
    capability: readyCapability(),
    outputDir: path.join(STATE_DIR, 'output', 'sess-abc'),
    proc: { status: 0, stdout: json({ ok: true, pipeline: 'market_research', phase: 'research', session_id: 'sess' }), stderr: '' },
    report: { markdown: '# OLD REPORT', mtimeMs: 500_000 }, // older than start
    startedAtMs: 1_000_000,
  });
  assert.equal(r.ok, false, 'stale report must not count as success');
  assert.equal(r.status, 'pipeline_failed');
  assert.equal(r.markdown, undefined, 'must not return the old markdown');
}

// --- Case 4: successful run → report under state dir (outside module), ok:true ---
{
  let capturedDir = null;
  const r = runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: '2027 FW slacks Amazon US',
    sessionId: 'sess42',
    capabilityOverride: readyCapability(),
    spawnOverride: (ctx) => {
      capturedDir = ctx.outputDir;
      return {
        status: 0,
        stdout: json({ ok: true, pipeline: 'market_research', phase: 'research', session_id: 'sess42', markdown_path: path.join(ctx.outputDir, 'research_report.md') }),
        stderr: '',
      };
    },
    readReportOverride: () => ({ markdown: '# Market Research\nfresh', mtimeMs: 2_000_000 }),
    nowOverride: 1_000_000,
  });
  assert.equal(r.ok, true, 'case4 ok');
  assert.equal(r.status, 'ok');
  assert.match(r.markdown, /Market Research/);
  assert.ok(r.output_dir.startsWith(STATE_DIR), 'output under state dir');
  assert.ok(r.output_dir.includes(`${path.sep}output${path.sep}`), 'under output/');
  assert.ok(!r.output_dir.includes(`modules${path.sep}organization`), 'NOT inside the module folder');
  assert.equal(capturedDir, r.output_dir, 'spawn got the same dir passed via --output-dir');
  assert.ok(resolveMarketStateDir().startsWith(STATE_DIR.slice(0, 3)));
}

// --- Case 5: no org module → fall back to chat, with a reason line ---
{
  const r = runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: 'anything',
    capabilityOverride: {
      available: false,
      status: 'no_org_module',
      message_ko: '조직 모듈이 설치되지 않았습니다. 모듈 업데이트 후 다시 시도하세요.',
      org_root: null,
      script: null,
      pipeline_entry: null,
      pipeline_venv: null,
      python: null,
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'no_org_module');
  assert.equal(r.used_fallback_chat, true, 'genuine no-module falls back to chat');
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'fallback carries a reason line');
}

// --- Extra: no python at all → visible guidance, not fallback ---
{
  const r = runMarketPipeline({
    cqrRoot: 'C:/app',
    phase: 'research',
    brief: 'anything',
    capabilityOverride: readyCapability({ status: 'no_python', python: null, pipeline_venv: null }),
  });
  assert.equal(r.status, 'no_python');
  assert.equal(r.used_fallback_chat, false);
  assert.match(r.error, /venv|pipeline-venv/);
}

console.log('verify-market-pipeline: ok');
