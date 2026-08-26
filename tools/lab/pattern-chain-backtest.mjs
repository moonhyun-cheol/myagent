#!/usr/bin/env node
/**
 * Offline (≥50 patterns + multi-turn chains) + optional live chain smoke.
 *
 *   node tools/lab/pattern-chain-backtest.mjs
 *   node tools/lab/pattern-chain-backtest.mjs --live
 *   $env:MY_AGENT_API_BASE='http://127.0.0.1:10200'
 *
 * Offline scores presentation-plane + capability helpers.
 * Live runs CHAINS against /chat/stream (HITL auto-approve) — cost-aware.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PATTERNS, CHAINS, resolveStep } from './user-pattern-catalog.mjs';
import { bindWorkspaceForPlane } from './lab-workspace-bind.mjs';
import { withInfraRetry, isInfraFetchError, waitForApi, sleep } from './lab-live-http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
const toySrc = path.join(root, 'tools', 'lab', 'fixtures', 'toy-workbench');
const toyDst = path.join(root, 'data', '_toy_workbench');
mkdirSync(outDir, { recursive: true });

const live = process.argv.includes('--live') || process.env.MY_AGENT_PATTERN_LIVE === '1';
const base = (
  process.env.MY_AGENT_API_BASE || process.env.CQR_E2E_BASE_URL || 'http://127.0.0.1:10200'
).replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.MY_AGENT_LIVE_BT_TIMEOUT_MS || 300_000);

function ensureToy() {
  mkdirSync(path.dirname(toyDst), { recursive: true });
  cpSync(toySrc, toyDst, { recursive: true });
  return toyDst;
}

async function loadGates() {
  const need = path.join(root, 'core/dist/agent/agent-surface-plane.js');
  if (!existsSync(need)) {
    const b = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    if (b.status !== 0) throw new Error(b.stderr || b.stdout || 'build failed');
  }
  const t = Date.now();
  const plane = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-surface-plane.js')).href + `?t=${t}`
  );
  const cap = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-capability-policy.js')).href + `?t=${t}`
  );
  const helpers = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-run-helpers.js')).href + `?t=${t}`
  );
  const claims = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-claim-gates.js')).href + `?t=${t}`
  );
  const guards = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/tool-content-guards.js')).href + `?t=${t}`
  );
  return { plane, cap, helpers, claims, guards };
}

function scorePattern(gates, p) {
  const failures = [];
  const message = p.text;
  // Avoid web_dev default pulling secretary/knowledge into coding via web_dev_default.
  const mode =
    p.mode
    || (p.plane === 'coding' ? 'web_dev' : 'chat');
  const priorCoding = p.priorCoding === true || p.expect?.priorCoding === true;
  const classified = gates.plane.classifySurfacePlane({
    message,
    mode,
    explicitMode: p.mode || null,
    mutatePrimary: false,
    priorCoding,
  });
  // Continuity priorCoding is session-aware — prefer classifier when flagged.
  const surface = classified.plane;
  const e = p.expect || {};

  if (e.surfacePlane && surface !== e.surfacePlane) {
    failures.push(`surfacePlane=${surface} want=${e.surfacePlane}`);
  }
  if (e.shell_net === true && !gates.cap.requiresShellNetCapability(message)) {
    failures.push('shell_net_miss');
  }
  if (e.shell_net === false && gates.cap.requiresShellNetCapability(message)) {
    failures.push('shell_net_unexpected');
  }
  if (e.explainBypass === true && !gates.cap.shouldBypassToolLoopForExplain(message)) {
    failures.push('explainBypass_miss');
  }
  if (e.noIdeForce === true) {
    if (gates.plane.surfaceAllowsIdeEditForce(surface)) {
      failures.push('ide_force_on_non_coding');
    }
  }
  if (e.brandPrefer === true && surface !== 'knowledge') {
    failures.push('brand_not_knowledge');
  }

  return {
    id: p.id,
    family: p.family,
    planeWant: p.plane,
    surface,
    workMode: 'model',
    failures,
    ok: failures.length === 0,
  };
}

function scoreChainOffline(gates, chain) {
  const stepScores = [];
  let priorCoding = false;
  for (const raw of chain.steps) {
    const step = resolveStep({ ...raw, priorCoding: raw.priorCoding || priorCoding });
    const scored = scorePattern(gates, step);
    stepScores.push(scored);
    if (scored.surface === 'coding' || step.plane === 'coding') priorCoding = true;
    if (step.expect?.priorCoding) priorCoding = true;
  }
  return {
    id: chain.id,
    title: chain.title,
    ok: stepScores.every((s) => s.ok),
    steps: stepScores,
  };
}

async function createSession() {
  const once = async () => {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`sessions ${res.status}: ${text.slice(0, 200)}`);
    return String(JSON.parse(text).id);
  };
  try {
    return await once();
  } catch (e) {
    if (!isInfraFetchError(e)) throw e;
    console.log(`  sessions infra retry (${e instanceof Error ? e.message : e})`);
    await waitForApi(base, 12_000);
    await sleep(800);
    return once();
  }
}

async function approve(id) {
  await fetch(`${base}/chat/tool-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, approved: true }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

async function streamChat(sessionId, message, mode) {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Node fetch drops duplicate case-insensitive keys — single session header only.
      'x-cqr-session': sessionId,
    },
    body: JSON.stringify({ message, mode: mode || 'web_dev', attachments: [] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text();
    return { content: '', error: `HTTP ${res.status}: ${t.slice(0, 200)}`, ms: Date.now() - t0 };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let approvals = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const block of parts) {
      const line = block
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'tool_approval' && ev.id) {
          approvals += 1;
          await approve(String(ev.id));
        }
        if (ev.type === 'content_replace' && (ev.text || ev.content)) {
          content = String(ev.text || ev.content);
        }
        if (ev.type === 'token' && ev.text) content += String(ev.text);
        if (ev.type === 'done' && (ev.content || ev.text)) {
          content = String(ev.content || ev.text);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { content, approvals, ms: Date.now() - t0 };
}

function scoreLiveReply(gates, step, content) {
  const failures = [];
  const codingAbandon =
    /파일\s*수정\s*도구가\s*실행되지|edit_file을\s*호출하지|코드\s*칩으로\s*같은\s*요청/i.test(
      content,
    );
  const pasteAsk =
    /(?:로컬\s*)?터미널에서.{0,40}(?:실행|명령).{0,40}(?:결과|보내|붙여)|결과를\s*보내\s*주|paste\s+the\s+output/i.test(
      content,
    );
  const denial =
    gates.cap.contentDeniesAvailableCapability(content)
    || gates.guards.contentClaimsToolsUnavailable(content);
  const defer =
    gates.claims.contentDefersDebugToUser(content)
    || pasteAsk
    || (typeof gates.cap.contentDefersRemoteInspectRead === 'function'
      && gates.cap.contentDefersRemoteInspectRead(content))
    || (typeof gates.cap.contentDefersPendingShellWork === 'function'
      && gates.cap.contentDefersPendingShellWork(content));
  const uiDump =
    typeof gates.plane.contentDumpsUiTargetMap === 'function'
    && gates.plane.contentDumpsUiTargetMap(content);
  const statusDump =
    typeof gates.plane.contentDumpsStatusReview === 'function'
    && gates.plane.contentDumpsStatusReview(content);

  if (step.expect?.noIdeForce || step.plane === 'knowledge' || step.plane === 'secretary') {
    if (codingAbandon) failures.push('coding_abandon');
  }
  if (step.plane === 'secretary' || /붙여|터미널에서/.test(step.text)) {
    if (pasteAsk) failures.push('user_paste_ask');
  }
  // Live P06/P86 soft-pass: UI-map / CURRENT_STATUS novel on secretary.
  if (step.plane === 'secretary' && (uiDump || statusDump)) {
    failures.push(uiDump ? 'ui_target_map_dump' : 'status_review_dump');
  }
  // Live no_self_deny soft-pass: grounded `.my_agent_remote` + trailing ### browser 404 novel.
  if (
    (step.plane === 'knowledge' || step.plane === 'secretary')
    && (
      /(\.my_agent_remote[/\\])|(근거\s*[:：].{0,96}README)/i.test(content)
      || (/my_automaton/i.test(content) && /(?:점진|패키지|도메인|Python)/i.test(content))
    )
    && /#{1,3}\s*browser\b/i.test(content)
  ) {
    failures.push('browser_novel');
  }
  // Finish-rewrite honesty stubs are not live pass (task still incomplete).
  if (
    step.plane === 'knowledge'
    && /공개\s*저장소\s*조사가\s*아직\s*끝나지|README를\s*read_file로\s*읽은\s*뒤/i.test(content)
  ) {
    failures.push('inspect_incomplete');
  }
  if (
    (step.plane === 'secretary' || step.plane === 'coding')
    && /배포\/빌드가\s*아직\s*끝나지/.test(content)
    && /run_terminal로/i.test(content)
  ) {
    failures.push('shell_incomplete');
  }
  // Live P87 false soft-pass: plan-only deploy path bullets after handoff strip
  // (no run evidence, no incomplete stub).
  if (
    (step.plane === 'secretary' || step.plane === 'coding')
    && !failures.includes('shell_incomplete')
    && /deploy\/output/i.test(content)
    && /(?:절차를\s*사용|정의되어\s*있)/i.test(content)
    && !/(?:통과했|생성됐|확인했|설치본|run_terminal|아직\s*끝나지)/i.test(content)
  ) {
    failures.push('shell_incomplete');
  }
  // Live tiny-mutate soft-pass while Supervisor blocked (probe_miss / diag_unverified).
  if (
    /reason\s*=\s*(?:probe_miss|diag_unverified)|Supervisor\s*outcome-gate가\s*차단|완료\s*주장이\s*증거와\s*맞지/i.test(
      content,
    )
  ) {
    failures.push('supervisor_block');
  }
  if (denial && !/작업\s*폴더.{0,24}연결/i.test(content)) {
    // Outcome-gate / partial status is not “tools unavailable”
    // HITL Accept honesty is product truth (not capability denial).
    // Empty-model retry template is infra, not user-workaround.
    if (
      !/완료로\s*처리|반영된\s*변경이\s*없|판단\s*불가|제공된\s*정보만/i.test(content)
      && !/빈\s*응답을\s*반환|같은\s*요청을\s*다시\s*보내/i.test(content)
      && !(
        typeof gates.cap.contentReportsHonestHitlAccept === 'function'
        && gates.cap.contentReportsHonestHitlAccept(content)
      )
    ) {
      failures.push('capability_denial');
    }
  }
  if (defer && step.plane !== 'coding' && !failures.includes('user_paste_ask')) {
    failures.push('user_deferral');
  }
  // Knowledge README handoff — always fail soft even if other defer gates miss.
  if (
    step.plane === 'knowledge'
    && !failures.includes('user_deferral')
    && typeof gates.cap.contentDefersRemoteInspectRead === 'function'
    && gates.cap.contentDefersRemoteInspectRead(content)
  ) {
    failures.push('user_deferral');
  }
  // P102 absolute-path reachability / phrase-contamination handoff soft-pass.
  if (
    step.plane === 'knowledge'
    && !failures.includes('user_deferral')
    && /호스트에서\s*(?:찾을\s*수\s*없|열\s*수\s*없)/i.test(content)
    && (/확인되면.{0,48}(?:요약|읽)/i.test(content)
      || /요청\s*문구가\s*경로에\s*함께\s*포함/i.test(content))
  ) {
    failures.push('user_deferral');
  }
  // Secretary shell handoff — always fail soft.
  if (
    step.plane === 'secretary'
    && !failures.includes('user_deferral')
    && typeof gates.cap.contentDefersPendingShellWork === 'function'
    && gates.cap.contentDefersPendingShellWork(content)
  ) {
    failures.push('user_deferral');
  }
  if (!String(content || '').trim()) failures.push('empty');
  if (/모델이\s*빈\s*응답|empty\s+response|같은\s*요청을\s*다시\s*보내/i.test(content)) {
    failures.push('empty_or_infra');
  }

  return {
    ok: failures.length === 0,
    failures,
    codingAbandon,
    preview: String(content || '').slice(0, 900),
  };
}

async function runLiveChains(gates) {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).then((r) =>
    r.json(),
  );
  if (!health?.ok) throw new Error('API health not ok — start:api on :10200');

  // Focus live: core planes + cursor-voice chains (cost-aware)
  const defaultLive = [
    'C_repo_inspect',
    'C_toy_mutate',
    'C_continue_deploy',
    'C_local_docs',
    'C_discord_pivot',
  ];
  const liveIds = (process.env.MY_AGENT_PATTERN_LIVE_CHAINS || defaultLive.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pick = CHAINS.filter((c) => liveIds.includes(c.id));
  if (!pick.length) {
    throw new Error(`no live chains matched: ${liveIds.join(',')}`);
  }
  const results = [];
  for (const chain of pick) {
    console.log(`\n==== LIVE ${chain.id} ====`);
    let sessionId = await createSession();
    const steps = [];
    let priorCoding = false;
    for (const raw of chain.steps) {
      const step = resolveStep({ ...raw, priorCoding: raw.priorCoding || priorCoding });
      console.log(`→ ${step.id}: ${step.text.slice(0, 80)}`);
      try {
        await bindWorkspaceForPlane(base, step.plane || (priorCoding ? 'coding' : 'knowledge'));
      } catch {
        /* license / manager may block — continue on global root */
      }
      const mode = step.mode || (step.plane === 'coding' ? 'web_dev' : 'chat');
      // P86: secretary turns are long — warm health before SSE stream.
      if (step.plane === 'secretary') {
        await waitForApi(base, 10_000);
        await sleep(600);
      }
      const rawRes = await withInfraRetry(
        async (attempt) => {
          const sid = attempt >= 2 ? await createSession().catch(() => sessionId) : sessionId;
          if (sid !== sessionId) sessionId = sid;
          return streamChat(sid, step.text, mode);
        },
        { base, extra: 3 },
      );
      const score = scoreLiveReply(gates, step, rawRes.content || '');
      if (rawRes.error) {
        score.failures.push('http_error');
        score.ok = false;
      }
      steps.push({
        id: step.id,
        plane: step.plane,
        ms: rawRes.ms,
        approvals: rawRes.approvals || 0,
        ...score,
        error: rawRes.error || null,
      });
      console.log(
        `  ${score.ok ? 'PASS' : 'FAIL'} ${score.failures.join(',') || '-'} (${Math.round((rawRes.ms || 0) / 1000)}s)`,
      );
      // Cooldown so SSE/proxy recover between long secretary turns (P86 fetch flake).
      await new Promise((r) => setTimeout(r, 1200));
      if (step.plane === 'coding') priorCoding = true;
    }
    results.push({
      id: chain.id,
      ok: steps.every((s) => s.ok && !s.error),
      steps,
    });
    // Inter-chain pause — C_continue_deploy P86 often followed a long prior chain.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return results;
}

async function main() {
  console.log(`pattern-chain-backtest patterns=${PATTERNS.length} chains=${CHAINS.length} live=${live}`);
  if (PATTERNS.length < 50) {
    throw new Error(`catalog ${PATTERNS.length} < 50`);
  }
  const toy = ensureToy();
  console.log(`toy workbench → ${toy}`);

  // mine report
  spawnSync(process.execPath, [path.join(root, 'tools/lab/user-pattern-mine.mjs')], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  const gates = await loadGates();
  const patternScores = PATTERNS.map((p) => scorePattern(gates, p));
  const chainScores = CHAINS.map((c) => scoreChainOffline(gates, c));

  const pPass = patternScores.filter((s) => s.ok).length;
  const cPass = chainScores.filter((s) => s.ok).length;

  let liveResults = null;
  let liveNote = 'skipped';
  if (live) {
    const livePath = path.join(outDir, 'pattern-chain-live.json');
    if (existsSync(livePath)) {
      try {
        const prev = JSON.parse(readFileSync(livePath, 'utf8'));
        if (Array.isArray(prev.live) && prev.live.length && prev.live.every((c) => c.ok)) {
          writeFileSync(
            path.join(outDir, 'pattern-chain-live.last-ok.json'),
            `${JSON.stringify(prev, null, 2)}\n`,
            'utf8',
          );
        }
      } catch {
        /* ignore */
      }
    }
    liveResults = await runLiveChains(gates);
    writeFileSync(
      livePath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), live: liveResults }, null, 2)}\n`,
      'utf8',
    );
    liveNote = `${liveResults.filter((r) => r.ok).length}/${liveResults.length}`;
  } else {
    // Offline run must NOT embed prior live into SUMMARY as if this invocation ran live
    // (anti-illusion: preserved evidence stays in pattern-chain-live.json only).
    liveResults = null;
    liveNote = 'skipped (offline; prior evidence not in offline report)';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    toy,
    liveRan: live,
    summary: {
      patterns: `${pPass}/${patternScores.length}`,
      chainsOffline: `${cPass}/${chainScores.length}`,
      live: liveNote,
    },
    patternFails: patternScores.filter((s) => !s.ok),
    chainFails: chainScores.filter((s) => !s.ok),
    patterns: patternScores,
    chains: chainScores,
    live: liveResults,
  };

  const jsonPath = path.join(outDir, 'pattern-chain-backtest.json');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const md = [
    '# Pattern + chain backtest',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    `| Suite | Result |`,
    `|-------|--------|`,
    `| Patterns (≥50) | **${payload.summary.patterns}** |`,
    `| Chains offline | **${payload.summary.chainsOffline}** |`,
    `| Live chains | ${payload.summary.live} |`,
    `| Toy | \`${toy}\` |`,
    '',
    '## Pattern failures',
    '',
  ];
  if (!payload.patternFails.length) md.push('_none_');
  for (const f of payload.patternFails) {
    md.push(`- \`${f.id}\`: ${f.failures.join('; ')} (got plane=${f.surface})`);
  }
  md.push('', '## Chain offline failures', '');
  if (!payload.chainFails.length) md.push('_none_');
  for (const f of payload.chainFails) {
    md.push(`- \`${f.id}\`: ${f.steps.filter((s) => !s.ok).map((s) => s.id + ':' + s.failures.join(',')).join(' | ')}`);
  }
  if (liveResults) {
    md.push('', '## Live chains', '');
    for (const r of liveResults) {
      md.push(`### ${r.ok ? 'PASS' : 'FAIL'} \`${r.id}\``);
      for (const s of r.steps) {
        md.push(
          `- ${s.ok ? 'PASS' : 'FAIL'} \`${s.id}\` ${s.failures.join('|') || 'ok'} · ${Math.round(s.ms / 1000)}s`,
        );
        md.push(`  - ${String(s.preview || s.error || '').replace(/\n/g, ' ').slice(0, 180)}`);
      }
      md.push('');
    }
  }
  const mdPath = path.join(outDir, 'pattern-chain-backtest-report.md');
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8');
  console.log(`\n=== SUMMARY patterns ${payload.summary.patterns} chains ${payload.summary.chainsOffline} live ${payload.summary.live} ===`);
  console.log(mdPath);

  const liveOk = !live || !liveResults || liveResults.every((r) => r.ok);
  // Offline bar: ≥90% patterns + all chains (do not fail offline on prior LIVE fails)
  const offlineOk = pPass / patternScores.length >= 0.9 && cPass === chainScores.length;
  process.exit(offlineOk && liveOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
