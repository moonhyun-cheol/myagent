#!/usr/bin/env node
/**
 * Agent-only rebuild of Desktop CQR_AllSkill_Demo (no tools gap-fill).
 * Fixes path: OWUI probe timeout must apply (see agent-llm-step timeoutMs plumb).
 *
 *   MY_AGENT_CODE_OWUI_PROTOCOL=text node tools/lab/agent-only-desktop.mjs   # skip probe
 *   MY_AGENT_CODE_OWUI_PROTOCOL=probe node tools/lab/agent-only-desktop.mjs  # 25s probe then TEXT
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.MY_AGENT_ROOT = process.env.MY_AGENT_ROOT || root;
// Code agent: prefer TEXT for this greenfield if not set — override with probe to test 25s cap
if (!process.env.MY_AGENT_CODE_OWUI_PROTOCOL) {
  process.env.MY_AGENT_CODE_OWUI_PROTOCOL = 'text';
}
process.env.MY_AGENT_CODE_AUTOPILOT = process.env.MY_AGENT_CODE_AUTOPILOT || '1';

const workspace =
  process.env.MY_AGENT_DEMO_WS?.trim()
  || path.join(process.env.USERPROFILE || '', 'Desktop', 'CQR_AllSkill_Demo');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'agent-only-desktop-report.json');

function wipeExceptSeed() {
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  for (const name of readdirSync(workspace)) {
    if (name === 'SEED.md' || name === '.git') continue;
    const p = path.join(workspace, name);
    rmSync(p, { recursive: true, force: true });
  }
  writeFileSync(
    path.join(workspace, 'SEED.md'),
    `# CQR All-Skill Demo — agent-only rebuild seed

AGENT must implement all of:
- public/index.html (ids: brand, hero-title, cta-primary, task-input, add-btn, task-list, concept-note)
- public/styles.css, public/app.js (localStorage cqr-allskill-v1)
- docs/concept-brief.md, docs/market-snapshot.md
- prompts/lookbook.md
- src/lib.js version(), test/smoke.test.js, package.json, README.md
`,
    'utf8',
  );
}

function filesOf(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesOf(full, base, acc);
    else acc.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return acc;
}

const required = [
  'public/index.html',
  'public/app.js',
  'public/styles.css',
  'docs/concept-brief.md',
  'docs/market-snapshot.md',
  'prompts/lookbook.md',
  'src/lib.js',
  'README.md',
];

wipeExceptSeed();

const { ProviderStore } = await import(
  pathToFileURL(path.join(root, 'core/dist/providers/provider-store.js')).href
);
const { runCodeAgent } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/code-agent.js')).href
);
const { resolveCodeOwuiProtocolMode, loadHarnessPolicy } = await import(
  pathToFileURL(path.join(root, 'core/dist/providers/harness-policy.js')).href
);

const store = new ProviderStore(path.join(root, 'data', 'vault', 'provider-keys.json'), root);
const prefer = process.env.MY_AGENT_OWUI_SMOKE_PROVIDER || 'custom';
let resolved = null;
for (const id of [prefer, 'custom', 'openwebui', 'open_webui', 'ollama']) {
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
  writeFileSync(reportPath, JSON.stringify({ ok: false, note: 'no provider' }, null, 2));
  console.error('no provider');
  process.exit(1);
}

const protocol = resolveCodeOwuiProtocolMode();
const harness = loadHarnessPolicy();
console.log(
  JSON.stringify(
    {
      workspace,
      provider: resolved.id,
      model: resolved.modelId,
      codeOwuiProtocol: protocol,
      probeTimeoutMs: harness.owuiProbeTimeoutMs,
    },
    null,
    2,
  ),
);

// Multi-turn until disk complete (agent-only; no tools gap-fill).
const maxTurns = Number(process.env.MY_AGENT_DEMO_AGENT_TURNS || 6);
let lastResult = null;
const allMutated = new Set();
const allStatuses = [];
const t0 = Date.now();

const baseUser = `작업 모드: AGENT. Autopilot.
SEED.md 유지. 아래를 ALL write_file 로 생성하기 전에는 완료 금지:

1 public/index.html ids: brand, hero-title, cta-primary, task-input, add-btn, task-list, concept-note
2 public/styles.css
3 public/app.js localStorage cqr-allskill-v1
4 docs/concept-brief.md
5 docs/market-snapshot.md
6 prompts/lookbook.md
7 src/lib.js export function version(){return '0.1.0'}
8 package.json + test/smoke.test.js
9 README.md

한 턴에 여러 write_file TOOL_CALL 연속 가능. 「나머지 계속」이라 쓰고 멈추지 말 것.
Exit gate: missing 0 must hold before any 완료 report.`;

for (let turn = 1; turn <= maxTurns; turn++) {
  const missingBefore = required.filter((f) => !existsSync(path.join(workspace, f)));
  if (missingBefore.length === 0 && turn > 1) break;

  const userMessage =
    turn === 1
      ? baseUser + '\nFirst tool: write_file public/index.html'
      : `이어서 AGENT. Still MISSING (must write now):\n${missingBefore.map((m) => `- ${m}`).join('\n')}\nNo plan. TOOL_CALL write_file only until all exist.`;

  console.log(`\n=== agent turn ${turn}/${maxTurns} missing=${missingBefore.length} ===`);
  try {
    lastResult = await runCodeAgent({
      workspaceRoot: workspace,
      userMessage,
      systemPrompt:
        'MY Agent code agent. Mutate every missing path. Do not stop mid-list with prose. Max 16 steps this turn.',
      workspaceContext: `agent-only desktop demo ${workspace}`,
      history: [],
      providerId: resolved.id,
      modelId: resolved.modelId || undefined,
      providerStore: store,
      nasWriteConsent: false,
      cqrRoot: root,
      sessionId: `agent_only_demo_${Date.now()}_t${turn}`,
      autopilot: true,
      maxSteps: 16,
      forceToolPack: 'web_dev',
      onToolApproval: async () => true,
      onStatus: (s) => {
        const line = String(s).slice(0, 200);
        allStatuses.push(`t${turn}:${line}`);
        console.log(' ', line);
      },
    });
  } catch (e) {
    lastResult = {
      content: e instanceof Error ? e.message : String(e),
      steps: 0,
      mutatedPaths: [],
    };
    allStatuses.push(`t${turn}:throw: ${lastResult.content}`);
  }
  for (const p of lastResult?.mutatedPaths || []) allMutated.add(p);
  const miss = required.filter((f) => !existsSync(path.join(workspace, f)));
  console.log(`turn ${turn} done steps=${lastResult?.steps} mutated=${(lastResult?.mutatedPaths||[]).join(',')} stillMissing=${miss.length}`);
  if (miss.length === 0) break;
}

const files = filesOf(workspace);
const missing = required.filter((f) => !existsSync(path.join(workspace, f)));
const hasApp =
  existsSync(path.join(workspace, 'public/app.js'))
  && /cqr-allskill-v1/.test(readFileSync(path.join(workspace, 'public/app.js'), 'utf8'));
const hasBrand =
  existsSync(path.join(workspace, 'public/index.html'))
  && /id="brand"/.test(readFileSync(path.join(workspace, 'public/index.html'), 'utf8'));
const mutated = [...allMutated];
const ok = missing.length === 0 && hasApp && hasBrand && mutated.length > 0;

const report = {
  ok,
  ms: Date.now() - t0,
  protocol,
  probeTimeoutMs: harness.owuiProbeTimeoutMs,
  provider: resolved.id,
  steps: lastResult?.steps,
  turns: maxTurns,
  mutated,
  missing,
  files,
  statuses: allStatuses.slice(0, 120),
  content: String(lastResult?.content || '').slice(0, 500),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok, ms: report.ms, mutated, missing, steps: report.steps, report: reportPath }, null, 2));
process.exit(ok ? 0 : 1);
