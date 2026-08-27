#!/usr/bin/env node
/**
 * Offline backtest: harvest Cursor agent-transcript user turns + seed failure
 * scenarios, score MY Agent routing/capability/claim gates (no live LLM required).
 *
 * Optional L2 (live OWUI code-agent): set MY_AGENT_CURSOR_BT_LIVE=1 when vault key present.
 *
 * Usage:
 *   node tools/lab/cursor-query-backtest.mjs
 *   node tools/lab/cursor-query-backtest.mjs --harvest-only
 *   MY_AGENT_CURSOR_BT_LIVE=1 node tools/lab/cursor-query-backtest.mjs
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
const harvestPath = path.join(outDir, 'cursor-query-harvest.json');
const reportPath = path.join(outDir, 'cursor-query-backtest-report.md');
const jsonPath = path.join(outDir, 'cursor-query-backtest.json');
const planPath = path.join(outDir, 'cursor-backtest-plan.md');

const harvestOnly = process.argv.includes('--harvest-only');
const live = process.env.MY_AGENT_CURSOR_BT_LIVE === '1';

const DEFAULT_TRANSCRIPT_ROOTS = [
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cursor',
    'projects',
    'c-Users-Temp-Desktop-CQR-PA',
    'agent-transcripts',
  ),
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cursor',
    'projects',
    'c-Users-Temp-Desktop-CQR-PA',
    'agent-transcripts',
  ),
];

/** Synthetic failure replies (assistant-style) that product gates must catch. */
const BAD_ASSISTANT_SAMPLES = [
  {
    id: 'deny_gh_no_read',
    text: '현재 대화에서는 GitHub 저장소의 파일 내용을 직접 열람할 수 없어 확인할 수 없습니다.',
  },
  {
    id: 'deny_no_terminal_net',
    text: '이 대화 환경에는 외부 인터넷에 접속하거나 터미널 명령을 직접 실행할 수 있는 기능이 없어서, 제가 해당 GitHub 저장소를 직접 내려받아 확인할 수는 없습니다.',
  },
  {
    id: 'defer_run_paste',
    text: '로컬 터미널에서 아래 명령만 실행한 뒤 결과를 보내주시면 바로 분석하겠습니다.\n\n```bash\ngit clone ...\n```',
  },
  {
    id: 'defer_readme_paste',
    text: 'find 결과와 README.md 내용을 붙여 주세요.',
  },
  {
    id: 'defer_terminal_cmd',
    text: '터미널에서 아래 명령을 실행한 뒤 결과를 보내주세요.',
  },
  {
    id: 'deny_en_no_shell',
    text: 'Sorry, I cannot run terminal commands or access the internet in this chat.',
  },
  {
    id: 'deny_unc_upload',
    text: '이 채팅 모드에서는 UNC 파일에 접근이 불가능합니다. 대신 엑셀을 업로드해 주세요.',
  },
  {
    id: 'defer_devtools',
    text: '브라우저 콘솔을 열어서 오류를 확인한 뒤 알려 주세요.',
  },
  {
    id: 'defer_cqr_diff_paste',
    text: 'my_agent 코드나 diff를 보내주면 바로 봐드릴게요. 관련 파일을 붙여 주세요.',
  },
];

/** Seed user questions similar to Cursor sessions + classic product fails (if harvest is thin). */
const SEED_USER_QUERIES = [
  {
    id: 'seed_gh_explain',
    text: 'https://github.com/jose87ldj/my_automaton 이 깃에 대해 설명',
    expect: { shell_net: true, toolTask: true, explainBypass: false },
  },
  {
    id: 'seed_gh_run_terminal',
    text: '니가 터미널에 직접실행해서 봐',
    expect: { toolTask: true },
  },
  {
    id: 'seed_nas_form',
    text: '\\\\nas\\share\\orders 먼저 이 루트 레거시 파일 보고 양식 확인해봐',
    expect: { live_fs: true, toolTask: true, explainBypass: false },
  },
  {
    id: 'seed_project_overview',
    text: 'MY Agent 프로젝트 개요 설명해줘',
    expect: { explainBypass: true, shell_net: false },
  },
  {
    id: 'seed_ui_fix',
    text: 'ChatPane 입력창 높이 키워줘',
    expect: { toolTask: true, explainBypass: false },
  },
  {
    id: 'seed_verify_again',
    text: '루프 돌려서 확인해',
    expect: {},
  },
  {
    id: 'seed_similar_improve',
    text: '유사한 이슈들도 해결되어야 해. my_agent 개선 후 루프돌려서 확인',
    expect: { toolTask: true },
  },
  {
    id: 'seed_personal_pack',
    text: '개인 스킬/툴을 제품 경로 밖으로 빼고 업데이트에도 남게 할 수 있어?',
    expect: {},
  },
  {
    id: 'seed_clipboard_feature',
    text: '클립보드 이미지 붙여넣기 기능을 ChatPane에 추가하자',
    expect: { denyOn: false },
  },
];

function walkJsonl(dir, acc = []) {
  if (!dir || !existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJsonl(p, acc);
    else if (name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

function pushUser(items, text, source) {
  const t = String(text || '').trim();
  if (t.length < 10 || t.length > 1500) return;
  // Drop pure tool dumps / base64
  if (/^[A-Za-z0-9+/=]{200,}$/.test(t)) return;
  if (/^TOOL_CALL\b/i.test(t)) return;
  items.push({ text: t.slice(0, 1000), source });
}

function harvestTranscripts() {
  const items = [];
  const roots = [
    process.env.MY_AGENT_TRANSCRIPT_ROOT,
    ...DEFAULT_TRANSCRIPT_ROOTS,
  ].filter(Boolean);
  const files = [];
  for (const r of roots) walkJsonl(r, files);
  files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  for (const f of files.slice(0, 40)) {
    let raw = '';
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const rel = path.basename(path.dirname(f)) + '/' + path.basename(f);
    for (const m of raw.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)) {
      pushUser(items, m[1], rel);
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const role = o.role || o.message?.role || o.type;
      let content = o.content ?? o.message?.content ?? o.text ?? o.query ?? '';
      if (Array.isArray(content)) {
        content = content.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).join('\n');
      }
      if (typeof content !== 'string') content = String(content || '');
      if (role === 'user' || o.type === 'user' || o.type === 'human') {
        pushUser(items, content, rel);
      }
    }
  }

  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = it.text.replace(/\s+/g, ' ').slice(0, 160);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  return { files: files.length, count: uniq.length, items: uniq.slice(0, 250) };
}

function classifyBucket(text) {
  const t = text.toLowerCase();
  if (/github\.com|git\s+clone|이\s*깃|저장소.*설명|레포/.test(t)) return 'remote_repo';
  if (/\\\\|unc|nas\\|양식|엑셀/.test(t)) return 'live_fs';
  if (/수정|고쳐|추가|구현|패치|챗페인|chatpane|ui\/|버그|에러|개선/.test(t)) return 'mutate';
  if (/설명|개요|구조|뭐야|현황|보고/.test(t)) return 'explain';
  if (/터미널|루프|확인|검증|verify|테스트|스모크|백테스트/.test(t)) return 'verify_ops';
  if (/스킬|툴|플러그인|plugin|openclaw|패키|배포|publish|delta/.test(t)) return 'ops_product';
  return 'other';
}

async function loadGates() {
  // Always rebuild so helper/policy edits are reflected (cache-stale dist is common in lab).
  const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout || 'build failed');
  }
  const cap = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-capability-policy.js')).href + `?t=${Date.now()}`
  );
  const code = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/code-agent.js')).href + `?t=${Date.now()}`
  );
  const claims = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-claim-gates.js')).href + `?t=${Date.now()}`
  );
  const guards = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/tool-content-guards.js')).href + `?t=${Date.now()}`
  );
  return { cap, code, claims, guards };
}

function scoreUserQuery(gates, text, expect = {}) {
  const caps = gates.cap.classifyRequiredCapabilities(text);
  const shell = caps.has('shell_net');
  const live = caps.has('live_fs');
  const explainBypass = gates.cap.shouldBypassToolLoopForExplain(text);
  const toolTask = gates.code.looksLikeToolTask(text);
  const failures = [];
  if (expect.shell_net === true && !shell) failures.push('miss_shell_net');
  if (expect.shell_net === false && shell) failures.push('false_shell_net');
  if (expect.live_fs === true && !live) failures.push('miss_live_fs');
  if (expect.toolTask === true && !toolTask) failures.push('miss_tool_task');
  if (expect.explainBypass === true && !explainBypass) failures.push('miss_explain_bypass');
  if (expect.explainBypass === false && explainBypass) failures.push('false_explain_bypass');
  return {
    shell_net: shell,
    live_fs: live,
    explainBypass,
    toolTask,
    caps: [...caps],
    ok: failures.length === 0,
    failures,
  };
}

function scoreBadAssistant(gates, sample) {
  const deny = gates.cap.contentDeniesAvailableCapability(sample.text);
  const toolsUnavail = gates.guards.contentClaimsToolsUnavailable(sample.text);
  const deferDebug = gates.claims.contentDefersDebugToUser(sample.text);
  const hit = deny || toolsUnavail || deferDebug;
  return {
    id: sample.id,
    hit,
    deny,
    toolsUnavail,
    deferDebug,
    ok: hit,
  };
}

function toSimilarSuite(harvestItems) {
  const suite = [...SEED_USER_QUERIES];
  const used = new Set(suite.map((s) => s.text.slice(0, 80)));
  // Map harvested into seed-like expect heuristics (HARD expects only when unambiguous).
  for (const it of harvestItems) {
    const key = it.text.slice(0, 80);
    if (used.has(key)) continue;
    used.add(key);
    const bucket = classifyBucket(it.text);
    const expect = {};
    // Hard route only for clear remote URL / UNC / UI component tokens.
    if (/https?:\/\/(?:www\.)?github\.com\//i.test(it.text)) {
      expect.shell_net = true;
      expect.toolTask = true;
      expect.explainBypass = false;
    } else if (/\\\\|unc:|양식|엑셀|\.xlsx/i.test(it.text) && /확인|보|열어|읽어/.test(it.text)) {
      expect.live_fs = true;
      expect.toolTask = true;
      expect.explainBypass = false;
    } else if (
      /(?:ChatPane|MainWindow|ui\/workspace|apply_patch|edit_file)/i.test(it.text)
      && /(?:수정|고쳐|키워|늘|줄|추가|구현|변경)/i.test(it.text)
    ) {
      expect.toolTask = true;
      expect.explainBypass = false;
    }
    // Soft observe only otherwise — still score for report buckets, no hard fail.
    suite.push({
      id: `harvest_${suite.length}`,
      text: it.text,
      source: it.source,
      bucket,
      expect,
    });
    if (suite.length >= 40) break;
  }
  return suite;
}

function feedbackLines(userScores, badScores, harvest) {
  const missTool = userScores.filter((s) => s.failures.includes('miss_tool_task'));
  const missShell = userScores.filter((s) => s.failures.includes('miss_shell_net'));
  const falseExplain = userScores.filter((s) => s.failures.includes('false_explain_bypass'));
  const badMiss = badScores.filter((s) => !s.ok);
  const lines = [];
  lines.push(`- Harvest: ${harvest.count} unique user turns from ${harvest.files} transcript files.`);
  lines.push(
    `- Seed+harvest suite: ${userScores.length} questions · routing goldens pass ${userScores.filter((s) => s.ok).length}/${userScores.length}.`,
  );
  lines.push(
    `- Bad-assistant catch: ${badScores.filter((s) => s.ok).length}/${badScores.length} (must be 100% for capability-denial class).`,
  );
  if (missShell.length) {
    lines.push(`- Gap: shell_net routing miss on ${missShell.length} cases (remote inspect not forced).`);
  }
  if (missTool.length) {
    lines.push(`- Gap: toolTask false-negative on ${missTool.length} mutate/inspect cases.`);
  }
  if (falseExplain.length) {
    lines.push(`- Gap: explain-docs bypass stole ${falseExplain.length} tool-needing turns.`);
  }
  if (badMiss.length) {
    lines.push(`- Gap: capability denial not caught: ${badMiss.map((b) => b.id).join(', ')}`);
  }
  const buckets = {};
  for (const s of userScores) {
    const b = s.bucket || 'seed';
    buckets[b] = (buckets[b] || 0) + 1;
  }
  lines.push(`- Query mix: ${JSON.stringify(buckets)}`);
  return lines;
}

function buildPlanMarkdown(meta) {
  const { feedback, userPass, userTotal, badPass, badTotal, liveNote } = meta;
  return `# Cursor-log backtest → MY Agent improvement plan

Generated: ${new Date().toISOString()}

**Product checklist:** absorbed by [three-plane PA vision](../../rulebook/docs/plans/2026-08-11-three-plane-pa-vision.md) (coding / knowledge / secretary Acceptance bars + weekly cadence). Live suite: \`npm run lab:cursor-backtest:live\` (\`:10200\`, restart API after build).

## Scope

Offline gate backtest from Cursor agent transcripts + failure-class assistant samples.
${liveNote}

## Results (this run)

| Metric | Value |
|--------|-------|
| User routing goldens | ${userPass}/${userTotal} |
| Bad-assistant catch | ${badPass}/${badTotal} |

## Feedback

${feedback.map((l) => l).join('\n')}

## Improvement plan (prioritized)

### P0 — Keep green (regression lock)

1. Keep \`verify:capability-policy\` in \`verify:agent\`; never delete shell_net / remote-repo goldens.
2. Wire this backtest into lab cadence:
   - \`node tools/lab/cursor-query-backtest.mjs\` after capability changes
   - optional: npm script \`lab:cursor-backtest\`
3. Fail CI/local predeploy when bad-assistant catch < 100% for seeded denial class.

### P1 — Routing completeness (from harvest gaps)

1. Expand \`looksLikeRemoteRepoInspectTask\` if harvest shows GitHub without verb (bare URL only).
2. Expand \`looksLikeToolTask\` for Korean ops verbs: 「루프 돌려」「백테스트」「검증해」「확인해」 when they imply product verify, not pure chat.
3. When user says 「니가 터미널에」 without URL, still mark tool plane if prior turn had remote URL (session continuity / openGate style).
4. \`shouldRunWorkspaceAgent\`: ensure harvest mutate + path questions never demote to brand skill.

### P2 — Live response backtest (LLM plane)

1. Start core API + OWUI vault; re-run with \`MY_AGENT_CURSOR_BT_LIVE=1\`.
2. For each suite item: runCodeAgent once; score:
   - \`contentDeniesAvailableCapability(final)\` must be false after repair window
   - remote_repo: must call run_terminal or read cloned path
   - mutate: mutateOk or honest partial with markers
3. Store transcripts under \`data/_skill_tool_lab/cursor-bt-live/\`.
4. Auto-promote failing live replies into BAD_ASSISTANT_SAMPLES.

### P3 — Product UX honesty

1. If no workspace and no global root: policy reply that explains setup — **not** "no terminal forever".
2. HITL Accept on run_terminal: UI copy that public clone is expected after Accept.
3. Surface status: 「가용 능력 거부 환각 — TOOL_CALL 재시도」 remains user-visible thought if product ships thoughts.

### P4 — Continuous harvest

1. Weekly: re-harvest transcripts; drop secrets (paths with \\\nas, tokens).
2. Cap suite at 40–60; retire flaky pure-chat lines.
3. Track pass rates in \`data/_skill_tool_lab/cursor-query-backtest.json\` history array.

## Acceptance for "done"

- Offline: user goldens with hard expect ≥ 95%; bad-assistant = 100%.
- Live (when enabled): 0 capability-denial finals on remote_repo + nas class; ≥1 real tool call per toolTask suite item.

## Commands

\`\`\`powershell
cd <MY Agent>
node tools/lab/cursor-query-backtest.mjs
npm run verify:capability-policy
# later:
# $env:MY_AGENT_CURSOR_BT_LIVE='1'
# node tools/lab/cursor-query-backtest.mjs
\`\`\`
`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const harvest = harvestTranscripts();
  writeFileSync(
    harvestPath,
    JSON.stringify({ harvestedAt: new Date().toISOString(), ...harvest }, null, 2),
    'utf8',
  );
  console.log(`harvest: ${harvest.count} queries from ${harvest.files} jsonl → ${harvestPath}`);
  if (harvestOnly) {
    process.exit(0);
  }

  const gates = await loadGates();
  const suite = toSimilarSuite(harvest.items);
  const userScores = [];
  for (const q of suite) {
    const score = scoreUserQuery(gates, q.text, q.expect || {});
    userScores.push({
      id: q.id,
      text: q.text.slice(0, 200),
      source: q.source || 'seed',
      bucket: q.bucket || classifyBucket(q.text),
      expect: q.expect || {},
      ...score,
    });
  }

  const badScores = BAD_ASSISTANT_SAMPLES.map((s) => scoreBadAssistant(gates, s));

  // Live plane optional — skip with note (no automatic long OWUI loop unless env)
  let liveResults = null;
  let liveNote =
    'Live LLM plane: **not run** (API/vault optional). Offline gate scores only.';
  if (live) {
    liveNote =
      'Live flag set — invoking short dry checks only if provider vault exists (mutates temp ws).';
    // Reuse presence check only; full suite live is expensive — one canary
    const vault = path.join(root, 'data', 'vault', 'provider-keys.json');
    if (!existsSync(vault) && !process.env.CQR_OPENWEBUI_API_KEY) {
      liveResults = { result: 'skip', note: 'no provider vault' };
      liveNote = 'Live requested but provider vault missing — skipped.';
    } else {
      liveResults = {
        result: 'deferred',
        note: 'Use tools/lab/owui-code-agent-smoke.mjs for mutate canary; expand suite live in P2.',
      };
    }
  }

  const feedback = feedbackLines(userScores, badScores, harvest);
  const userPass = userScores.filter((s) => s.ok).length;
  const badPass = badScores.filter((s) => s.ok).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    harvest: { files: harvest.files, count: harvest.count },
    summary: {
      userPass,
      userTotal: userScores.length,
      badPass,
      badTotal: badScores.length,
      userRate: userScores.length ? userPass / userScores.length : 0,
      badRate: badScores.length ? badPass / badScores.length : 0,
    },
    feedback,
    live: liveResults,
    userScores,
    badScores,
  };

  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const md = [
    '# Cursor query → MY Agent offline backtest',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Transcript files | ${harvest.files} |`,
    `| Harvested unique users | ${harvest.count} |`,
    `| Suite size | ${userScores.length} |`,
    `| Routing goldens | **${userPass}/${userScores.length}** |`,
    `| Bad-assistant catch | **${badPass}/${badScores.length}** |`,
    '',
    '## Feedback',
    '',
    ...feedback.map((l) => l),
    '',
    '## Failures (routing expects)',
    '',
  ];
  const fails = userScores.filter((s) => !s.ok);
  if (!fails.length) md.push('_none_');
  else {
    for (const f of fails.slice(0, 30)) {
      md.push(`- **${f.id}** \`${f.failures.join(',')}\` — ${f.text.replace(/\n/g, ' ').slice(0, 120)}`);
    }
  }
  md.push('', '## Bad-assistant misses', '');
  const badFail = badScores.filter((s) => !s.ok);
  if (!badFail.length) md.push('_none_');
  else for (const b of badFail) md.push(`- ${b.id}`);

  md.push('', '## Sample suite (first 12)', '');
  for (const s of userScores.slice(0, 12)) {
    md.push(
      `- [${s.ok ? 'ok' : 'FAIL'}] \`${s.bucket}\` shell=${s.shell_net} tool=${s.toolTask} explainBypass=${s.explainBypass} — ${s.text.replace(/\n/g, ' ').slice(0, 100)}`,
    );
  }
  md.push('', `Full JSON: \`${path.relative(root, jsonPath)}\``, '');
  writeFileSync(reportPath, `${md.join('\n')}\n`, 'utf8');

  const plan = buildPlanMarkdown({
    feedback,
    userPass,
    userTotal: userScores.length,
    badPass,
    badTotal: badScores.length,
    liveNote,
  });
  writeFileSync(planPath, plan, 'utf8');

  console.log(md.join('\n'));
  console.log(`\nplan → ${planPath}`);
  console.log(`report → ${reportPath}`);

  // Soft exit: only hard-fail when seeded routing fails or bad-assistant missed
  const seedFails = userScores.filter((s) => String(s.id).startsWith('seed_') && !s.ok);
  if (seedFails.length || badPass < badScores.length) {
    console.error(
      `BACKTEST_HARD_FAIL seeds=${seedFails.length} bad_miss=${badScores.length - badPass}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
