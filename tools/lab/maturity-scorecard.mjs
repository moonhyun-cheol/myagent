#!/usr/bin/env node
/**
 * COLD maturity scorecard — no history gaming, no file presence = free points.
 *
 * Five dimensions (product intent, hard ceiling without live = listed):
 *   three_plane   (L0-capable high, min live not required)  offline max 100
 *   harness_l0    offline only max 100
 *   l1_hardbars   REQUIRES ledger of real live runs (auto-appended only when --live)
 *   cursor_feel   offline max 45; live quality up to +55; only last REAL cursor json
 *   daily_loop    scripts + last daily-smoke with REAL live rows (no "(history)")
 *
 *   node tools/lab/maturity-scorecard.mjs              # cold re-score (no LLM)
 *   node tools/lab/maturity-scorecard.mjs --policy=honest-v1  # anti-wiring freshness model
 *   node tools/lab/maturity-scorecard.mjs --live --repeats=2  # burns LLM; appends ledger
 *
 * Strict rules:
 * - Does NOT auto-load hand-written history. Only ledger written by --live runs.
 * - Single lucky live full-green capped at 88 until 2 consecutive full greens in ledger.
 * - Includes FAIL runs already in ledger (last N=6).
 * - Empty model reply / coding_abandon never “hard pass”.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });
const LEDGER = path.join(outDir, 'maturity-live-ledger.jsonl');

const live = process.argv.includes('--live') || process.env.MY_AGENT_MATURITY_LIVE === '1';
const coldOnly = process.argv.includes('--cold') || !live;
/** cold-v3 (default) | honest-v1 — anti score-wiring / stricter freshness */
const scoringPolicyId = (
  process.argv.find((a) => a.startsWith('--policy='))?.split('=')[1]
  || process.env.MY_AGENT_SCORE_POLICY
  || 'cold-v3'
).trim();
const HONEST = scoringPolicyId === 'honest-v1';
const CURSOR_FRESH_H = HONEST ? 12 : 24;
const DAILY_FRESH_H = HONEST ? 18 : 36;
const LEDGER_FRESH_H = HONEST ? 18 : Infinity;
const repeats = Math.max(
  1,
  Number(
    process.argv.find((a) => a.startsWith('--repeats='))?.split('=')[1]
      || process.env.MY_AGENT_LIVE_REPEATS
      || 1, // default 1 — double live burns budget; consecutive needs separate invocations
  ),
);
const target = Number(process.env.MY_AGENT_DIM_TARGET || 95);
const base = (
  process.env.MY_AGENT_API_BASE || process.env.CQR_E2E_BASE_URL || 'http://127.0.0.1:10210'
).replace(/\/$/, '');
const LEDGER_WINDOW = 6;

function runNode(rel, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, rel), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 30 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function readJson(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function fileHas(rel, needle) {
  const p = path.join(root, rel);
  if (!existsSync(p)) return false;
  return readFileSync(p, 'utf8').includes(needle);
}

function hasFile(rel) {
  return existsSync(path.join(root, rel));
}

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendLedger(entry) {
  writeFileSync(LEDGER, `${JSON.stringify(entry)}\n`, { flag: 'a' });
}

function ageHours(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3_600_000;
}

/** Reject empty / policy abandon / soft weak as full hard pass. */
function hardenCursorSummary(cl) {
  if (!cl?.results?.length) {
    return { hardPass: 0, total: 0, barsOk: false, qualityPass: 0, emptyN: 0, abandonN: 0 };
  }
  let hardPass = 0;
  let qualityPass = 0;
  let emptyN = 0;
  let abandonN = 0;
  for (const r of cl.results) {
    const text = String(r.contentPreview || '');
    const empty =
      !text.trim()
      || /모델이\s*빈\s*응답|empty\s+response|같은\s*요청을\s*다시\s*보내/i.test(text);
    const abandon = /파일\s*수정\s*도구가\s*실행되지|edit_file을\s*호출하지/i.test(text);
    if (empty) emptyN += 1;
    if (abandon) abandonN += 1;
    const fails = Array.isArray(r.failures) ? r.failures : [];
    const onlyWeak = fails.length === 1 && fails[0] === 'weak_tool_ground';
    const hard =
      r.hardOk === true
      && !empty
      && !abandon
      && !fails.includes('capability_denial')
      && !fails.includes('coding_abandon_on_non_coding_plane')
      && !fails.includes('user_paste_ask')
      && !fails.includes('user_deferral')
      && !fails.includes('ui_target_map_dump')
      && !fails.includes('status_review_dump')
      && !fails.includes('browser_novel')
      && !fails.includes('supervisor_block')
      && !fails.includes('inspect_incomplete')
      && !fails.includes('shell_incomplete')
      && !fails.includes('empty_or_infra')
      && !fails.includes('http_error')
      && !fails.includes('no_mutate_evidence')
      && !(onlyWeak && empty);
    if (hard) hardPass += 1;
    if (hard && !onlyWeak) qualityPass += 1;
  }
  const total = cl.results.length;
  // Plane bars: all knowledge/coding/secretary without abandon template
  const planeOf = Object.fromEntries(
    (cl.results || []).map((r) => [r.id, r]),
  );
  // use summary barsOk only if hardPass===total and emptyN===0
  const barsOk = hardPass === total && emptyN === 0 && abandonN === 0;
  return { hardPass, total, barsOk, qualityPass, emptyN, abandonN };
}

const PLANE_MATRIX = [
  { id: 'gh_no_edit', msg: 'https://github.com/jose87ldj/my_automaton 설명. 코드 수정 금지.', mode: 'web_dev', plane: 'knowledge', force: false },
  { id: 'chatpane_h', msg: 'ChatPane 입력창 높이 키워줘', mode: 'web_dev', plane: 'coding', force: true },
  { id: 'market', msg: '시장조사해줘. 결과 정리해.', mode: 'deep_research', plane: 'knowledge', force: false },
  { id: 'concept', msg: '컨셉 잡아서 정리', mode: 'chat', plane: 'knowledge', force: false },
  { id: 'docx_ro', msg: 'C:\\GoodApp\\x.docx 읽고 핵심만. 수정 금지.', mode: 'chat', plane: 'knowledge', force: false },
  { id: 'nn_leave', msg: 'ㄴㄴ 그냥 둬. MY Agent 어때', mode: 'chat', plane: 'secretary', force: false },
  { id: 'oo_deploy', msg: 'ㅇㅇ 한번 돌리고, 배포파일 생성', mode: 'chat', plane: 'secretary', force: false },
  { id: 'oo_short', msg: 'ㅇㅇ 전부 다 보고.. 쉽고 짧고, 구구절절 설명하지 말고 직관적으로', mode: 'chat', plane: 'secretary', force: false },
  { id: 'verify_status', msg: '실제로 파일 수정된 거야? 반영된 거야?', mode: 'chat', plane: 'secretary', force: false },
  { id: 'explain_only', msg: '이 구조 잘 돼 있어? 설명만.', mode: 'chat', plane: 'knowledge', force: false },
  { id: 'hitl_q', msg: 'run_terminal Accept 뜨면 내가 눌러야 해? 짧고. 붙여넣기 시키지 마.', mode: 'web_dev', plane: 'secretary', force: false },
  { id: 'gg_go', msg: '금액 생각하지말고 ㄱㄱ', mode: 'chat', plane: 'secretary', force: false },
  { id: 'overview', msg: 'MY Agent 프로젝트 개요 설명해줘', mode: 'chat', plane: 'knowledge', force: false },
  { id: 'clone_inspect', msg: '공개 저장소 https://github.com/foo/bar 한 줄 목적만. 수정 금지.', mode: 'web_dev', plane: 'knowledge', force: false },
  { id: 'ui_mutate_tsx', msg: 'ui/workspace/src/components/ChatPane.tsx 높이 수정해', mode: 'web_dev', plane: 'coding', force: true },
  { id: 'sandbox', msg: '센드박스만 보고 실배포 이슈 정리', mode: 'chat', plane: 'secretary', force: false },
  { id: 'plan_first', msg: '개선 계획만 먼저. 코드 수정하지 마.', mode: 'chat', plane: 'knowledge', force: false },
  { id: 'folder_ro', msg: 'C:\\Users\\Temp\\Desktop\\bowling 이 폴더를 봐봐. 수정 금지.', mode: 'chat', plane: 'knowledge', force: false },
  { id: 'hitl_wd', msg: '이 채팅 터미널 Accept가 필수야?', mode: 'web_dev', plane: 'secretary', force: false },
];

async function loadSurface() {
  return import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-surface-plane.js')).href + `?t=${Date.now()}`
  );
}
async function loadTerm() {
  return import(
    pathToFileURL(path.join(root, 'core/dist/agent/run-terminal.js')).href + `?t=${Date.now()}`
  );
}

async function scoreThreePlane(surface) {
  let pass = 0;
  const misses = [];
  for (const row of PLANE_MATRIX) {
    const r = surface.classifySurfacePlane({
      message: row.msg,
      mode: row.mode,
      explicitMode: row.mode === 'web_dev' ? 'web_dev' : row.mode?.startsWith('cqr_') ? row.mode : null,
      mutatePrimary: false,
    });
    const force = surface.surfaceAllowsIdeEditForce(r.plane);
    if (r.plane === row.plane && force === row.force) pass += 1;
    else misses.push(`${row.id}: got ${r.plane}/f=${force}`);
  }
  const matrixRate = pass / PLANE_MATRIX.length;
  const wire =
    (fileHas('core/src/agent/agent-run-loop.ts', 'formatSurfacePlaneSystemNote') ? 1 : 0)
    + (fileHas('core/src/agent/agent-surface-plane.ts', 'SURFACE PLANE: secretary') ? 1 : 0)
    + (fileHas('core/src/agent/agent-surface-plane.ts', 'SURFACE PLANE: knowledge') ? 1 : 0)
    + (fileHas('core/src/agent/agent-run-step-loop.ts', 'surfaceAllowsIdeEditForce') ? 1 : 0)
    + (fileHas('core/src/agent/agent-run-step-loop.ts', 'formatSurfaceExhaustMessage(state.surfacePlane')
      || fileHas('core/src/agent/agent-run-step-loop.ts', 'formatSurfaceExhaustMessage(state.surfacePlane ||')
      ? 1
      : 0);
  const wireRate = wire / 5;
  const vCap = runNode('tools/verify-capability-policy.mjs');
  const vTd = runNode('tools/verify-turn-decision.mjs');
  const offlineChain = runNode('tools/lab/pattern-chain-backtest.mjs');
  const rem = offlineChain.out.match(/patterns\s+(\d+)\/(\d+)/i);
  const patternRate = rem ? Number(rem[1]) / Number(rem[2]) : 0;
  const goldenRate = ((vCap.ok ? 1 : 0) + (vTd.ok ? 1 : 0)) / 2;

  // Cap: pure offline can be 100 only if matrix+wiring+goldens green (ok)
  const score = Math.round(
    matrixRate * 50 + wireRate * 20 + patternRate * 15 + goldenRate * 15,
  );
  return {
    score: Math.min(100, score),
    details: {
      matrixPass: `${pass}/${PLANE_MATRIX.length}`,
      misses: misses.slice(0, 6),
      wire: `${wire}/5`,
      patternRate,
      goldenRate,
    },
  };
}

function scoreHarnessL0() {
  const steps = [
    ['capability', 'tools/verify-capability-policy.mjs'],
    ['turn', 'tools/verify-turn-decision.mjs'],
    ['work_mode', 'tools/verify-work-mode-loop.mjs'],
    ['terminal_sanitize', 'tools/verify-run-terminal-sanitize.mjs'],
    ['harness_goldens', 'tools/verify-harness-goldens.mjs'],
    ['lab_live_http', 'tools/lab/verify-lab-live-http.mjs'],
    ['pattern_chain', 'tools/lab/pattern-chain-backtest.mjs'],
    ['cursor_offline', 'tools/lab/cursor-query-backtest.mjs'],
  ];
  const rows = [];
  let okN = 0;
  for (const [id, rel] of steps) {
    const r = runNode(rel);
    rows.push({ id, ok: r.ok });
    if (r.ok) okN += 1;
  }
  // No free depth bonus to 100 — rate*95 + tiny catalog bonus max 5 only if all green
  const rate = okN / steps.length;
  const mine = readJson('data/_skill_tool_lab/user-pattern-mine.json');
  const cat = Number(mine?.catalogCount || mine?.curated || 0);
  const depth = rate === 1 && cat >= 140 ? 5 : 0;
  const score = Math.min(100, Math.round(rate * 95 + depth));
  return { score, details: { rows, okN, total: steps.length, catalog: cat } };
}

function liveRunsFromLedger() {
  return readLedger().slice(-LEDGER_WINDOW);
}

function scoreL1(liveRuns) {
  const notes = [];
  if (!liveRuns.length) {
    // Snapshot last disk live only counts as *one* run, freshness-capped, and is capped.
    const cl = readJson('data/_skill_tool_lab/cursor-query-live-backtest.json');
    const ch = readJson('data/_skill_tool_lab/pattern-chain-live.json')
      || readJson('data/_skill_tool_lab/pattern-chain-backtest.json');
    const hard = hardenCursorSummary(cl);
    const live = ch?.live || [];
    const fresh =
      ageHours(cl?.generatedAt) <= CURSOR_FRESH_H
      && ageHours(ch?.generatedAt || cl?.generatedAt) <= CURSOR_FRESH_H;
    if (!cl?.results?.length) {
      return {
        score: 0,
        details: { liveRuns: [], fullGreens: 0, note: 'no live evidence (run --live)', notes },
      };
    }
    if (!fresh) notes.push('disk live snapshot older than 24h — discounted');
    const run = {
      at: cl.generatedAt,
      cursorHard: hard.hardPass,
      cursorTotal: hard.total,
      barsOk: hard.barsOk && fresh,
      chainPass: live.filter((x) => x.ok).length,
      chainTotal: live.length,
      emptyN: hard.emptyN,
      abandonN: hard.abandonN,
      source: 'disk_snapshot',
    };
    liveRuns = [run];
  }

  let sum = 0;
  let full = 0;
  let consecutiveFull = 0;
  let streak = 0;
  for (const r of liveRuns) {
    const cRate = r.cursorTotal ? r.cursorHard / r.cursorTotal : 0;
    const kRate = r.chainTotal ? r.chainPass / r.chainTotal : 0;
    // No free +15 for barsOk if empty/abandon present
    const penal = (r.emptyN || 0) * 3 + (r.abandonN || 0) * 4;
    const runScore = Math.max(0, cRate * 60 + kRate * 40 - penal);
    sum += runScore;
    // full green / consecutive only counts real ledger (--live append), never disk_snapshot
    const ledgerEligible = r.source !== 'disk_snapshot';
    const isFull =
      ledgerEligible
      && r.barsOk
      && r.chainTotal > 0
      && r.chainPass === r.chainTotal
      && cRate === 1
      && !(r.emptyN > 0)
      && !(r.abandonN > 0);
    if (isFull) {
      full += 1;
      streak += 1;
      consecutiveFull = Math.max(consecutiveFull, streak);
    } else if (ledgerEligible) {
      streak = 0;
    }
    // disk_snapshot does not break ledger streak (isolated soft credit only)
  }
  if (liveRuns.every((r) => r.source === 'disk_snapshot')) {
    notes.push('disk_snapshot_only — consecutiveFull forced 0 (not ledger)');
    consecutiveFull = 0;
    full = 0;
  }
  let ledgerStale = false;
  if (HONEST && Number.isFinite(LEDGER_FRESH_H)) {
    const newestMs = liveRuns.reduce((m, r) => {
      const t = Date.parse(r.at || '');
      return Number.isFinite(t) ? Math.max(m, t) : m;
    }, 0);
    const newestAge = newestMs ? (Date.now() - newestMs) / 3_600_000 : Infinity;
    if (newestAge > LEDGER_FRESH_H) {
      ledgerStale = true;
      notes.push(`ledger_stale>${LEDGER_FRESH_H}h — consecutiveFull forced 0`);
      consecutiveFull = 0;
    }
  }
  const avg = sum / liveRuns.length;
  // Stability only after consecutive full greens in ledger order
  let stab = 0;
  if (consecutiveFull >= 2) stab = 12;
  else if (consecutiveFull === 1) stab = 4;

  let score = Math.round(Math.min(100, avg * 0.85 + stab));
  // Hard caps — anti-illusion (cold-v3): single green / disk snapshot never looks like “100”
  if (liveRuns.length < 2) score = Math.min(score, 78);
  if (liveRuns.every((r) => r.source === 'disk_snapshot')) score = Math.min(score, 75);
  if (consecutiveFull < 2) score = Math.min(score, 85);
  if (consecutiveFull < 3) score = Math.min(score, 94); // 100 only after 3 consecutive fulls
  if (liveRuns.some((r) => (r.emptyN || 0) > 0 || (r.abandonN || 0) > 0)) {
    score = Math.min(score, 80);
    notes.push('empty_or_abandon_in_window');
  }
  if (ledgerStale) score = Math.min(score, 70);

  return {
    score,
    details: {
      liveRuns,
      fullGreens: full,
      consecutiveFull,
      avg: Math.round(avg),
      notes,
    },
  };
}

async function scoreCursorFeel(term, l1Details) {
  const notes = [];
  // Offline path: structural max 40; +5 only via behavioral verify (honest) or fileHas (cold-v3)
  let offline = 0;
  const strip = term.sanitizeShellCommandForPolicy(
    'Remove-Item -Recurse -Force .my_agent_remote/a; git clone --depth 1 https://github.com/x/y .my_agent_remote/x__y',
  );
  if (strip.stripped?.length && !/Remove-Item/i.test(strip.command)) offline += 10;
  else notes.push('clone_strip');
  if (fileHas('tools/lab/lab-workspace-bind.mjs', 'bindWorkspaceForPlane')) offline += 8;
  else notes.push('ws_bind');
  if (fileHas('core/src/agent/agent-capability-policy.ts', 'contentReportsHonestHitlAccept')) offline += 8;
  else notes.push('hitl');
  if (fileHas('core/src/agent/agent-run-loop.ts', 'formatSurfacePlaneSystemNote')) offline += 7;
  else notes.push('plane_note');
  if (fileHas('core/src/agent/agent-surface-plane.ts', 'FORBIDDEN with clone')) offline += 7;
  else notes.push('clone_note');
  if (HONEST) {
    // No free points for symbol presence — require harness golden that exercises compress/budgets
    const harness = runNode('tools/verify-harness-policy.mjs');
    if (harness.ok) offline += 5;
    else notes.push('context_budget_behavior_fail');
  } else if (
    hasFile('core/config/defaults/model-context-limits.json')
    && fileHas('core/src/agent/agent-run-helpers.ts', 'truncateToolResultForLlm')
    && fileHas('core/src/agent/agent-run-helpers.ts', 'resolveContextBudgets')
  ) {
    offline += 5;
  } else {
    notes.push('context_budget');
  }

  // Live quality max 50 from last REAL cursor json (harden)
  const cl = readJson('data/_skill_tool_lab/cursor-query-live-backtest.json');
  let livePts = 0;
  const fresh = ageHours(cl?.generatedAt) <= CURSOR_FRESH_H;
  if (!cl?.results?.length || !fresh) {
    notes.push(cl?.results?.length ? 'live_stale' : 'no_live');
  } else {
    const hard = hardenCursorSummary(cl);
    const rate = hard.total ? hard.hardPass / hard.total : 0;
    livePts = Math.round(rate * 35);
    // path quality
    const mut = cl.results.find((r) => r.id === 'workspace_tiny_mutate');
    const gh = cl.results.find((r) => r.id === 'gh_explain');
    const hitl = cl.results.find((r) => r.id === 'secretary_hitl');
    if (
      mut?.hardOk
      && /live-bt-ok|mutate:\s*1|mutated:\s*README/i.test(mut.contentPreview || '')
      && !/빈\s*응답/i.test(mut.contentPreview || '')
    ) livePts += 8;
    else notes.push('mutate_path');
    if (gh?.hardOk && !/안전\s*정책|빈\s*응답/i.test(gh.contentPreview || '')) livePts += 4;
    else notes.push('gh_path');
    if (
      hitl?.hardOk
      && !/edit_file을\s*호출하지/i.test(hitl.contentPreview || '')
      && /Accept|눌러|승인/i.test(hitl.contentPreview || '')
      && !/타이틀바|MainWindow\.xaml|ChatPane/i.test(hitl.contentPreview || '')
    ) livePts += 3;
    else notes.push('hitl_path');
    livePts = Math.min(50, livePts);
    if (hard.emptyN || hard.abandonN) {
      livePts = Math.max(0, livePts - hard.emptyN * 5 - hard.abandonN * 6);
      notes.push(`empty=${hard.emptyN} abandon=${hard.abandonN}`);
    }
  }

  // Consecutive full L1 doesn't inflate feel past evidence
  let score = Math.min(100, offline + livePts);
  // Product cold cap: without clean live, never above 70
  if (!fresh || notes.includes('no_live') || notes.includes('live_stale')) {
    score = Math.min(score, 70);
  }
  // Without ledger consecutive full, hard cap (anti-illusion)
  if ((l1Details?.consecutiveFull || 0) < 2) score = Math.min(score, 82);
  if ((l1Details?.consecutiveFull || 0) < 3) score = Math.min(score, 92);
  if ((l1Details?.notes || []).some((n) => /empty|abandon/i.test(String(n)))) {
    score = Math.min(score, 78);
  }

  return {
    score,
    details: { offlinePts: offline, livePts, notes, maxOffline: 45, maxLive: 50 },
  };
}

function scoreDailyLoop(l1Details) {
  const notes = [];
  // Script existence only max 25 (was 70+)
  let score = 0;
  if (hasFile('tools/lab/daily-smoke.mjs')) score += 8;
  if (hasFile('tools/lab/maturity-scorecard.mjs')) score += 6;
  if (hasFile('tools/lab/improve-loop.mjs')) score += 6;
  if (fileHas('package.json', 'lab:maturity')) score += 5;

  const daily = readJson('data/_skill_tool_lab/daily-smoke-report.json');
  if (!daily) {
    notes.push('no_daily_report');
  } else {
    if (daily.offlineOk) score += 20;
    else notes.push('offline_fail');

    const rows = daily.rows || [];
    const historyRow = rows.some((r) => /history/i.test(String(r.label || '')));
    if (historyRow) {
      notes.push('daily_report_has_history_rows — ignored for live credit');
    }
    const realLive =
      daily.offlineOnly !== true
      && !historyRow
      && !/SKIP|down|offline-only|history/i.test(String(daily.liveNote || ''))
      && rows.some((r) => /live/i.test(String(r.label || '')) && !/history/i.test(String(r.label || '')));
    if (realLive && daily.liveOk) score += 35;
    else if (realLive && !daily.liveOk) {
      score += 10;
      notes.push('daily_live_ran_but_failed');
    } else {
      notes.push('no_real_daily_live');
      score += 5; // token-sparing offline-only path still partial
    }

    if (ageHours(daily.finishedAt || daily.generatedAt) > DAILY_FRESH_H) {
      notes.push('daily_report_stale');
      score = Math.min(score, score - 10);
      if (HONEST) {
        // honest-v1: stale daily cannot count as real live credit
        notes.push('no_real_daily_live');
        score = Math.min(score, 62);
      }
    }
  }

  // Ledger consecutive only if ledger exists from real --live
  const cons = l1Details?.consecutiveFull || 0;
  if (cons >= 2) score += 15;
  else if (cons === 1) score += 5;

  score = Math.max(0, Math.min(100, score));
  // Without real daily live, hard cap (stricter cold-v3)
  if (notes.includes('no_real_daily_live') || notes.includes('daily_report_has_history_rows')) {
    score = Math.min(score, 62);
  }
  // 100 daily only with cons≥3 + real live green
  if (cons < 3 || notes.includes('no_real_daily_live')) {
    score = Math.min(score, 94);
  }
  return { score, details: { notes, consecutiveFull: cons } };
}

async function runLiveOnce() {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json())
    .catch(() => null);
  if (!health?.ok) throw new Error(`API not up @ ${base}`);

  runNode('tools/lab/cursor-query-live-backtest.mjs', [], { MY_AGENT_API_BASE: base });
  const cl = readJson('data/_skill_tool_lab/cursor-query-live-backtest.json');
  const hard = hardenCursorSummary(cl);

  runNode('tools/lab/pattern-chain-backtest.mjs', ['--live'], {
    MY_AGENT_API_BASE: base,
    MY_AGENT_PATTERN_LIVE_CHAINS:
      process.env.MY_AGENT_PATTERN_LIVE_CHAINS
      || 'C_local_docs,C_continue_deploy,C_repo_inspect',
  });
  const ch = readJson('data/_skill_tool_lab/pattern-chain-live.json')
    || readJson('data/_skill_tool_lab/pattern-chain-backtest.json');
  const live = ch?.live || [];

  return {
    at: new Date().toISOString(),
    source: 'live_spawn',
    cursorHard: hard.hardPass,
    cursorTotal: hard.total,
    barsOk: hard.barsOk,
    chainPass: live.filter((x) => x.ok).length,
    chainTotal: live.length,
    emptyN: hard.emptyN,
    abandonN: hard.abandonN,
    qualityPass: hard.qualityPass,
    api_version: health.version,
  };
}

async function main() {
  if (!existsSync(path.join(root, 'core/dist/agent/agent-surface-plane.js'))) {
    runNode('tools/build.mjs');
  }
  const surface = await loadSurface();
  const term = await loadTerm();

  const liveRuns = [];
  if (live) {
    for (let i = 0; i < repeats; i++) {
      console.log(`\n### LIVE ${i + 1}/${repeats} (LLM spend)`);
      try {
        const r = await runLiveOnce();
        appendLedger(r);
        console.log(
          `  cursor ${r.cursorHard}/${r.cursorTotal} empty=${r.emptyN} abandon=${r.abandonN} bars=${r.barsOk} chains ${r.chainPass}/${r.chainTotal}`,
        );
      } catch (e) {
        const fail = {
          at: new Date().toISOString(),
          source: 'live_spawn',
          cursorHard: 0,
          cursorTotal: 0,
          barsOk: false,
          chainPass: 0,
          chainTotal: 0,
          emptyN: 0,
          abandonN: 0,
          error: e instanceof Error ? e.message : String(e),
        };
        appendLedger(fail);
        console.log(`  FAIL ${fail.error}`);
      }
    }
    // Score from ledger window (includes sessions) so consecutiveFull is honest.
    liveRuns.push(...liveRunsFromLedger());
  } else {
    const ledger = liveRunsFromLedger();
    if (ledger.length) {
      liveRuns.push(...ledger);
      console.log(`### cold score using ledger n=${ledger.length} (no new LLM)`);
    } else {
      console.log('### cold score — no ledger; disk snapshot capped (no --live)');
    }
  }

  const three = await scoreThreePlane(surface);
  const l0 = scoreHarnessL0();
  const l1 = scoreL1(liveRuns);
  const feel = await scoreCursorFeel(term, l1.details);
  const daily = scoreDailyLoop(l1.details);

  const scores = {
    three_plane: three.score,
    harness_l0: l0.score,
    l1_hardbars: l1.score,
    cursor_feel: feel.score,
    daily_loop: daily.score,
  };
  const minScore = Math.min(...Object.values(scores));
  const cons = l1.details?.consecutiveFull || 0;
  const dailyNotes = daily.details?.notes || [];
  const hasRealDaily = !dailyNotes.some((n) =>
    /no_real_daily_live|history/i.test(String(n)),
  );
  const emptyInWindow = (l1.details?.notes || []).some((n) => /empty|abandon/i.test(String(n)))
    || (l1.details?.liveRuns || []).some((r) => (r.emptyN || 0) > 0 || (r.abandonN || 0) > 0);

  // Dim scores can show offline 100, but allPass / mean refuse illusion
  let allPass =
    Object.values(scores).every((s) => s >= target)
    && cons >= 3
    && hasRealDaily
    && !emptyInWindow;

  // Cold product mean (honest headline — not marketed as completion)
  let productMean = Math.round(
    scores.three_plane * 0.2
      + scores.harness_l0 * 0.15
      + scores.l1_hardbars * 0.25
      + scores.cursor_feel * 0.25
      + scores.daily_loop * 0.15,
  );
  // Anti-illusion mean caps (even if offline dims are 100)
  if (cons < 2) productMean = Math.min(productMean, 86);
  else if (cons < 3) productMean = Math.min(productMean, 91);
  if (!hasRealDaily) productMean = Math.min(productMean, 82);
  if (emptyInWindow) productMean = Math.min(productMean, 84);
  if (minScore < target) {
    // headline never looks “basically done” while any dim is BELOW
    productMean = Math.min(productMean, Math.round((productMean + minScore) / 2));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scoringPolicy: HONEST ? 'honest-v1-anti-wiring' : 'cold-v3-anti-illusion',
    coldOnly: !live,
    live,
    target,
    allPass,
    minScore,
    productMean,
    gates: {
      consecutiveFull: cons,
      hasRealDaily,
      emptyInWindow,
      cursorFreshHours: CURSOR_FRESH_H,
      dailyFreshHours: DAILY_FRESH_H,
      ledgerFreshHours: Number.isFinite(LEDGER_FRESH_H) ? LEDGER_FRESH_H : null,
      allPassRequires: HONEST
        ? 'all dims≥target + consecutiveFull≥3 + real daily ≤18h + cursor ≤12h + ledger ≤18h + harness-verify for compress pts'
        : 'all dims≥target + consecutiveFull≥3 + real daily live + no empty/abandon',
    },
    disclaimer: HONEST
      ? 'honest-v1: refuses score-wiring. Compress feel pts require verify-harness-policy (not fileHas). Stale ledger/daily/cursor evidence discounted. NOT Cursor-complete.'
      : 'productMean is evidence-weighted harness maturity, NOT “Cursor-complete product”. cold-v3: no history gaming; allPass needs 3 consecutive full live + real daily; empty/abandon block; offline dim 100 ≠ product 100.',
    scores,
    dims: {
      three_plane: three,
      harness_l0: l0,
      l1_hardbars: l1,
      cursor_feel: feel,
      daily_loop: daily,
    },
  };
  const outJson = HONEST ? 'maturity-scorecard-honest-v1.json' : 'maturity-scorecard.json';
  const outMd = HONEST ? 'maturity-scorecard-honest-v1.md' : 'maturity-scorecard.md';
  writeFileSync(path.join(outDir, outJson), `${JSON.stringify(report, null, 2)}\n`);

  const md = [
    HONEST
      ? '# Maturity scorecard (HONEST v1 · anti-wiring)'
      : '# Maturity scorecard (COLD v3 · anti-illusion)',
    '',
    `Generated: ${report.generatedAt}`,
    `Policy: **${report.scoringPolicy}** · liveRuns=${liveRuns.length} · target≥${target}`,
    '',
    `**productMean: ${productMean}** · min(dim): **${minScore}** · all≥${target}: **${allPass}**`,
    '',
    `Gates: consecutiveFull=${cons} · realDaily=${hasRealDaily} · emptyInWindow=${emptyInWindow}`,
    '',
    `> ${report.disclaimer}`,
    '',
    '| Dimension | Score | vs 95 |',
    '|-----------|------:|:-----:|',
    ...Object.entries(scores).map(
      ([k, s]) => `| ${k} | **${s}** | ${s >= target ? 'ok' : 'BELOW'} |`,
    ),
    '',
    '## Details',
    '',
    '### three_plane',
    '```json',
    JSON.stringify(three.details, null, 2),
    '```',
    '',
    '### harness_l0',
    '```json',
    JSON.stringify(l0.details, null, 2),
    '```',
    '',
    '### l1_hardbars',
    '```json',
    JSON.stringify(l1.details, null, 2),
    '```',
    '',
    '### cursor_feel',
    '```json',
    JSON.stringify(feel.details, null, 2),
    '```',
    '',
    '### daily_loop',
    '```json',
    JSON.stringify(daily.details, null, 2),
    '```',
    '',
  ].join('\n');
  writeFileSync(path.join(outDir, outMd), md, 'utf8');
  console.log(md);
  console.log(
    `\n=== ${HONEST ? 'HONEST-v1' : 'COLD-v3'} MATURITY mean=${productMean} min=${minScore} allPass=${allPass} ===`,
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
