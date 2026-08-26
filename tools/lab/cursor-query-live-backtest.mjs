#!/usr/bin/env node
/**
 * Live backtest against a running MY Agent core API (SSE + HITL auto-approve).
 *
 *   $env:MY_AGENT_API_BASE='http://127.0.0.1:10200'
 *   node tools/lab/cursor-query-live-backtest.mjs
 *
 * Uses /chat/stream (mode web_dev by default). Approves tool_approval instantly.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bindWorkspaceForPlane } from './lab-workspace-bind.mjs';
import { withInfraRetry, isInfraFetchError, waitForApi, sleep } from './lab-live-http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
const liveDir = path.join(outDir, 'cursor-bt-live');
mkdirSync(liveDir, { recursive: true });

const base = (
  process.env.MY_AGENT_API_BASE
  || process.env.CQR_E2E_BASE_URL
  || 'http://127.0.0.1:10200'
).replace(/\/$/, '');

const TIMEOUT_MS = Number(process.env.MY_AGENT_LIVE_BT_TIMEOUT_MS || 420_000);
const MODE = process.env.MY_AGENT_LIVE_BT_MODE || 'web_dev';

/** Focused live suite — coding / knowledge / secretary planes (cost-aware). */
const SUITE = [
  {
    id: 'gh_explain',
    plane: 'knowledge',
    message:
      'https://github.com/jose87ldj/my_automaton 이 공개 깃 저장소에 대해 짧게 설명해. run_terminal로 git clone --depth 1 한 뒤 README·구조 기준. 코드 수정 금지. 사용자가 터미널 돌리게 시키지 마.',
    expect: {
      noCapabilityDenial: true,
      noCodingAbandon: true,
      toolGround: /(?:clone|README|automaton|package|pyproject|src|도메인|Python)/i,
    },
  },
  {
    id: 'overview_explain',
    plane: 'knowledge',
    message: 'MY Agent 프로젝트 개요를 한국어 3문장으로만 설명해. 파일 수정하지 마.',
    expect: {
      noCapabilityDenial: true,
      noCodingAbandon: true,
      toolGround: /(?:CQR|에이전트|워크스페이스|채팅|API|도구|Realuse|실사용)/i,
    },
  },
  {
    id: 'no_self_deny',
    plane: 'knowledge',
    message:
      '이 채팅에는 터미널이 없다며 거절하지 말고, 공개 저장소 https://github.com/jose87ldj/my_automaton 의 한 줄 목적만 README 근거로 말해. 수정 금지.',
    expect: {
      noCapabilityDenial: true,
      noCodingAbandon: true,
      toolGround: /(?:automaton|package|업무|도메인|Python|README|점진)/i,
    },
  },
  {
    id: 'secretary_no_paste',
    plane: 'secretary',
    message:
      '터미널에서 git clone 하라고 시키지 마. 공개 repo 설명이 필요하면 네가 도구로 하고, 못 하면 작업 폴더 연결만 정직하게 말해.',
    expect: {
      noCapabilityDenial: true,
      noCodingAbandon: true,
      noUserPasteAsk: true,
    },
  },
  {
    id: 'workspace_tiny_mutate',
    plane: 'coding',
    message:
      '작업 모드 AGENT. 현재 작업 폴더 README.md가 있으면 맨 아래에 한 줄만 추가: `# live-bt-ok`. 없으면 write_file로 README.md 생성. 검증 길게 금지. 짧은 완료.',
    expect: {
      noCapabilityDenial: true,
      mutateHint: true,
    },
  },
  {
    id: 'secretary_hitl',
    plane: 'secretary',
    message:
      '질문만: run_terminal에 Accept가 뜨면 내가 눌러야 해? 한 문장. 단어 Accept와 승인 포함. UI 파일 경로·타이틀바·ChatPane 나열 금지. 붙여넣기 시키지 마. 코드 수정 금지.',
    expect: {
      noCapabilityDenial: true,
      noCodingAbandon: true,
      noUserPasteAsk: true,
      toolGround: /(?:Accept|눌러|승인|사용자)/i,
    },
  },
  {
    id: 'oo_continue_short',
    plane: 'secretary',
    message: 'ㅇㅇ 짧게만. 지금 상태만 알려줘. 수정 금지.',
    expect: {
      noCapabilityDenial: true,
      noCodingAbandon: true,
      noUserPasteAsk: true,
    },
  },
];

function ensureDistGates() {
  const p = path.join(root, 'core/dist/agent/agent-capability-policy.js');
  if (!existsSync(p)) {
    const b = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    if (b.status !== 0) throw new Error(b.stderr || b.stdout || 'build failed');
  }
}

async function loadGates() {
  ensureDistGates();
  const t = Date.now();
  const cap = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-capability-policy.js')).href + `?t=${t}`
  );
  const claims = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-claim-gates.js')).href + `?t=${t}`
  );
  const guards = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/tool-content-guards.js')).href + `?t=${t}`
  );
  const plane = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/agent-surface-plane.js')).href + `?t=${t}`
  );
  return { cap, claims, guards, plane };
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
    const doc = JSON.parse(text);
    if (!doc.id) throw new Error(`no session id: ${text.slice(0, 200)}`);
    return String(doc.id);
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

async function approve(approvalId) {
  const res = await fetch(`${base}/chat/tool-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: approvalId, approved: true }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}

/**
 * @returns {Promise<{ content: string, mode: string|null, model: string|null, events: object[], approvals: number, ms: number, error?: string }>}
 */
async function streamChat(sessionId, message, modeOverride) {
  const t0 = Date.now();
  const requestMode = modeOverride || MODE;
  const res = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cqr-session': sessionId,
    },
    body: JSON.stringify({
      message,
      mode: requestMode,
      attachments: [],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text();
    return {
      content: '',
      mode: null,
      model: null,
      events: [],
      approvals: 0,
      ms: Date.now() - t0,
      error: `HTTP ${res.status}: ${t.slice(0, 300)}`,
    };
  }
  if (!res.body) {
    const t = await res.text();
    return parseSseText(t, t0, 0);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let approvals = 0;
  const events = [];
  let content = '';
  let mode = null;
  let model = null;
  let donePayload = null;

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
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      events.push({ type: ev.type, t: Date.now() - t0 });
      if (ev.type === 'tool_approval' && ev.id) {
        approvals += 1;
        await approve(String(ev.id)).catch(() => false);
      }
      // Code agent final answer is content_replace (not token-streamed).
      if (ev.type === 'content_replace' && (ev.text || ev.content)) {
        content = String(ev.text || ev.content || '');
      }
      if (ev.type === 'answer' && ev.text) content += String(ev.text);
      if (ev.type === 'token' && ev.text) content += String(ev.text);
      if (ev.type === 'status' && ev.text) {
        events.push({ type: 'status', text: String(ev.text).slice(0, 160), t: Date.now() - t0 });
      }
      if (ev.type === 'done') {
        donePayload = ev;
        // done often has no body — keep content_replace
        if (ev.content) content = String(ev.content);
        else if (ev.text) content = String(ev.text);
        if (ev.mode) mode = String(ev.mode);
        if (ev.model) model = String(ev.model);
      }
      if (ev.type === 'meta') {
        if (ev.mode) mode = String(ev.mode);
        if (ev.model) model = String(ev.model);
        if (ev.routing?.mode) mode = String(ev.routing.mode);
      }
      if (ev.type === 'error') {
        content = content || String(ev.message || ev.error || 'error event');
      }
    }
  }
  // residual
  if (buf.trim()) {
    const line = buf
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (line) {
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'done' && (ev.content || ev.text)) {
          content = String(ev.content || ev.text);
          mode = mode || (ev.mode ? String(ev.mode) : null);
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!content && donePayload) {
    content = String(donePayload.content || donePayload.text || '');
  }

  // Session final message fallback
  if (!content.trim()) {
    try {
      const s = await fetch(`${base}/sessions/${sessionId}`, {
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json());
      const msgs = s.messages || s.history || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant' && msgs[i].content) {
          content = String(msgs[i].content);
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    content,
    mode,
    model,
    events,
    approvals,
    ms: Date.now() - t0,
    done: donePayload,
  };
}

function parseSseText(text, t0, approvals) {
  const events = [];
  let content = '';
  let mode = null;
  let model = null;
  for (const block of text.split('\n\n')) {
    const line = block
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim());
      events.push({ type: ev.type });
      if (ev.type === 'done') {
        content = String(ev.content || ev.text || content);
        mode = ev.mode ? String(ev.mode) : mode;
        model = ev.model ? String(ev.model) : model;
      }
    } catch {
      /* ignore */
    }
  }
  return { content, mode, model, events, approvals, ms: Date.now() - t0 };
}

function scoreCase(gates, item, result) {
  const content = String(result.content || '');
  const failures = [];
  const codingAbandon =
    /파일\s*수정\s*도구가\s*실행되지|edit_file을\s*호출하지|코드\s*칩으로\s*같은\s*요청/i.test(
      content,
    );
  const userPasteAsk =
    /(?:로컬\s*)?터미널에서.{0,40}(?:실행|명령).{0,40}(?:결과|보내|붙여)|결과를\s*보내\s*주|paste\s+the\s+output|find\s*결과.{0,20}붙여/i.test(
      content,
    );
  const denial =
    gates.cap.contentDeniesAvailableCapability(content)
    || gates.guards.contentClaimsToolsUnavailable(content);
  const defer =
    gates.claims.contentDefersDebugToUser(content)
    || userPasteAsk
    || (typeof gates.cap.contentDefersRemoteInspectRead === 'function'
      && gates.cap.contentDefersRemoteInspectRead(content))
    || (typeof gates.cap.contentDefersPendingShellWork === 'function'
      && gates.cap.contentDefersPendingShellWork(content));

  if (item.expect.noCodingAbandon && codingAbandon) {
    failures.push('coding_abandon_on_non_coding_plane');
  }
  if (item.expect.noUserPasteAsk && userPasteAsk) {
    failures.push('user_paste_ask');
  }
  // Empty / infra retry templates are hard fails (never weak soft-pass).
  if (
    !content.trim()
    || /모델이\s*빈\s*응답|empty\s+response/i.test(content)
    || /같은\s*요청을\s*다시\s*보내/i.test(content)
  ) {
    failures.push('empty_or_infra');
  }
  if (item.expect.noCapabilityDenial && (denial || defer) && !codingAbandon) {
    // Protocol-failure templates that mention Tool not found are scored via codingAbandon /
    // knowledge-specific copy; avoid double-counting honest setup asks.
    if (!/작업\s*폴더.{0,24}연결/i.test(content) && !/빈\s*응답을\s*반환/i.test(content)) {
      failures.push(denial ? 'capability_denial' : 'user_deferral');
    }
  }
  // Knowledge README/clone handoff soft-pass even when expect flags omit noCapabilityDenial.
  if (
    item.plane === 'knowledge'
    && !failures.includes('user_deferral')
    && typeof gates.cap.contentDefersRemoteInspectRead === 'function'
    && gates.cap.contentDefersRemoteInspectRead(content)
  ) {
    failures.push('user_deferral');
  }
  // P102 absolute-path reachability / phrase-contamination handoff soft-pass.
  if (
    item.plane === 'knowledge'
    && !failures.includes('user_deferral')
    && /호스트에서\s*(?:찾을\s*수\s*없|열\s*수\s*없)/i.test(content)
    && (/확인되면.{0,48}(?:요약|읽)/i.test(content)
      || /요청\s*문구가\s*경로에\s*함께\s*포함/i.test(content))
  ) {
    failures.push('user_deferral');
  }
  // Live secretary_no_paste / P86: status novel or UI-map dump soft-passed hardOk.
  if (item.plane === 'secretary') {
    if (typeof gates.plane?.contentDumpsUiTargetMap === 'function' && gates.plane.contentDumpsUiTargetMap(content)) {
      failures.push('ui_target_map_dump');
    }
    if (typeof gates.plane?.contentDumpsStatusReview === 'function' && gates.plane.contentDumpsStatusReview(content)) {
      failures.push('status_review_dump');
    }
    // HITL Accept Q answered with chrome dump (even if dump detector misses pair).
    if (
      typeof gates.plane?.looksLikeHitlAcceptQuestion === 'function'
      && item.expect?.toolGround
      && /MainWindow|ChatPane|타이틀바/i.test(content)
      && !failures.includes('ui_target_map_dump')
    ) {
      // Only when suite id looks like HITL
      if (/hitl|accept/i.test(String(item.id || ''))) {
        failures.push('ui_target_map_dump');
      }
    }
  }
  // Live no_self_deny: ### browser novel after `.my_agent_remote` grounding soft-passed hardOk.
  if (
    (item.plane === 'knowledge' || item.plane === 'secretary')
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
    item.plane === 'knowledge'
    && /공개\s*저장소\s*조사가\s*아직\s*끝나지|README를\s*read_file로\s*읽은\s*뒤/i.test(content)
  ) {
    failures.push('inspect_incomplete');
  }
  if (
    (item.plane === 'secretary' || item.plane === 'coding')
    && /배포\/빌드가\s*아직\s*끝나지/.test(content)
    && /run_terminal로/i.test(content)
  ) {
    failures.push('shell_incomplete');
  }
  // Mirror pattern-chain: plan-only deploy bullets without run evidence.
  if (
    (item.plane === 'secretary' || item.plane === 'coding')
    && !failures.includes('shell_incomplete')
    && /deploy\/output/i.test(content)
    && /(?:절차를\s*사용|정의되어\s*있)/i.test(content)
    && !/(?:통과했|생성됐|확인했|설치본|run_terminal|아직\s*끝나지)/i.test(content)
  ) {
    failures.push('shell_incomplete');
  }
  if (item.expect.toolGround && content.length > 20 && !item.expect.toolGround.test(content)) {
    if (content.length < 40) failures.push('empty_or_short');
    else failures.push('weak_tool_ground');
  }
  if (item.expect.mutateHint) {
    const fixtureReadme = path.join(root, 'data', '_realuse_lab', 'app', 'README.md');
    let diskOk = false;
    try {
      if (existsSync(fixtureReadme)) {
        diskOk = /#\s*live-bt-ok/.test(readFileSync(fixtureReadme, 'utf8'));
      }
    } catch {
      /* ignore */
    }
    const textOk = /#\s*live-bt-ok|live-bt-ok/.test(content);
    if (!diskOk && !textOk) failures.push('no_mutate_evidence');
    // Live workspace_tiny_mutate soft-passed hardOk while Supervisor blocked (probe_miss).
    if (
      /reason\s*=\s*(?:probe_miss|diag_unverified)|Supervisor\s*outcome-gate가\s*차단|완료\s*주장이\s*증거와\s*맞지/i.test(
        content,
      )
    ) {
      failures.push('supervisor_block');
    }
  }
  if (result.error) failures.push('http_error');
  if (!content.trim() && !result.error) failures.push('empty_content');

  const hardFails = failures.filter((f) => f !== 'weak_tool_ground');
  return {
    ok: hardFails.length === 0,
    hardOk: hardFails.length === 0,
    denial,
    defer,
    codingAbandon,
    failures,
  };
}

async function main() {
  console.log(`live backtest → ${base} mode=${MODE} timeout=${TIMEOUT_MS}ms`);
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).then((r) =>
    r.json(),
  );
  if (!health?.ok) throw new Error(`health not ok: ${JSON.stringify(health)}`);
  console.log(
    `health ok v${health.version} code=${health.llm_runtime?.code_agent_provider}/${health.llm_runtime?.code_agent_model}`,
  );

  const gates = await loadGates();
  const results = [];

  for (const item of SUITE) {
    console.log(`\n==== ${item.id} ====`);
    console.log(item.message.slice(0, 120));
    try {
      const w = await bindWorkspaceForPlane(base, item.plane || 'knowledge');
      console.log(`workspace=${w}`);
    } catch (e) {
      console.log(`workspace bind skip: ${e instanceof Error ? e.message : e}`);
    }
    let sessionId = await createSession();
    console.log(`session ${sessionId}`);
    const mode =
      item.plane === 'coding'
        ? 'web_dev'
        : item.plane === 'knowledge' || item.plane === 'secretary'
          ? 'chat'
          : MODE;
    const raw = await withInfraRetry(
      async (attempt) => {
        if (attempt >= 2) {
          sessionId = await createSession().catch(() => sessionId);
        }
        return streamChat(sessionId, item.message, mode);
      },
      { base, extra: 3 },
    );
    const score = scoreCase(gates, item, raw);
    const row = {
      id: item.id,
      sessionId,
      ms: raw.ms,
      mode: raw.mode,
      model: raw.model,
      approvals: raw.approvals,
      events: raw.events?.map((e) => e.type).slice(0, 40),
      contentPreview: String(raw.content || '').slice(0, 600),
      contentLen: String(raw.content || '').length,
      error: raw.error || null,
      ...score,
    };
    results.push(row);
    writeFileSync(
      path.join(liveDir, `${item.id}.json`),
      JSON.stringify({ item, raw: { ...raw, content: String(raw.content || '').slice(0, 12000) }, score }, null, 2),
      'utf8',
    );
    console.log(
      `${score.hardOk ? 'PASS' : 'FAIL'} ms=${raw.ms} approvals=${raw.approvals} failures=${score.failures.join(',') || '-'} len=${row.contentLen}`,
    );
    console.log((row.contentPreview || raw.error || '').slice(0, 280));
  }

  const hardPass = results.filter((r) => r.hardOk).length;
  const planeOf = Object.fromEntries(SUITE.map((s) => [s.id, s.plane]));
  const byPlane = (plane) => results.filter((r) => planeOf[r.id] === plane);
  const knowledge = byPlane('knowledge');
  const coding = byPlane('coding');
  const secretary = byPlane('secretary');
  const knowledgeHard = knowledge.filter((r) => r.hardOk).length;
  const codingHard = coding.filter((r) => r.hardOk).length;
  const secretaryHard = secretary.filter((r) => r.hardOk).length;
  // Bars for maturity 95: knowledge 100% when n≤5 else ≥90%; coding/secretary absolute
  const knowledgeBarOk =
    knowledge.length === 0
    || knowledgeHard === knowledge.length
    || (knowledge.length > 5 && knowledgeHard / knowledge.length >= 0.9);
  const codingBarOk = coding.length === 0 || codingHard === coding.length;
  const secretaryBarOk = secretary.length === 0 || secretaryHard === secretary.length;
  const noCodingAbandonOnKnowledge = knowledge.every((r) => !r.codingAbandon);
  const barsOk = knowledgeBarOk && codingBarOk && secretaryBarOk && noCodingAbandonOnKnowledge;
  const payload = {
    generatedAt: new Date().toISOString(),
    base,
    mode: MODE,
    health: {
      version: health.version,
      code_agent: health.llm_runtime?.code_agent_model,
    },
    summary: {
      hardPass,
      total: results.length,
      rate: results.length ? hardPass / results.length : 0,
      knowledgeHard: `${knowledgeHard}/${knowledge.length}`,
      codingHard: `${codingHard}/${coding.length}`,
      secretaryHard: `${secretaryHard}/${secretary.length}`,
      barsOk,
    },
    results,
  };
  const jsonPath = path.join(outDir, 'cursor-query-live-backtest.json');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const md = [
    '# Cursor live backtest (core API)',
    '',
    `Base: \`${base}\` · ${payload.generatedAt}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Cases | ${results.length} |`,
    `| Hard pass | **${hardPass}/${results.length}** |`,
    `| Knowledge bar (≥75%) | **${knowledgeHard}/${knowledge.length}** ${knowledgeBarOk ? 'ok' : 'FAIL'} |`,
    `| Coding bar | **${codingHard}/${coding.length}** ${codingBarOk ? 'ok' : 'FAIL'} |`,
    `| Secretary bar | **${secretaryHard}/${secretary.length}** ${secretaryBarOk ? 'ok' : 'FAIL'} |`,
    `| Model | ${health.llm_runtime?.code_agent_model || '—'} |`,
    '',
    '## Per case',
    '',
  ];
  for (const r of results) {
    md.push(
      `### ${r.hardOk ? 'PASS' : 'FAIL'} \`${r.id}\` (${Math.round(r.ms / 1000)}s, approvals=${r.approvals})`,
    );
    md.push('');
    md.push(`- failures: ${r.failures.join(', ') || 'none'}`);
    md.push(`- mode/model: ${r.mode || '—'} / ${r.model || '—'}`);
    md.push(`- preview: ${r.contentPreview.replace(/\n/g, ' ').slice(0, 240)}`);
    md.push('');
  }
  const mdPath = path.join(outDir, 'cursor-query-live-backtest-report.md');
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8');
  console.log(
    `\n=== SUMMARY hard ${hardPass}/${results.length} bars=${barsOk ? 'ok' : 'FAIL'} knowledge=${knowledgeHard}/${knowledge.length} coding=${codingHard}/${coding.length} secretary=${secretaryHard}/${secretary.length} ===`,
  );
  console.log(mdPath);
  console.log(jsonPath);

  // Feedback append to improvement plan
  const planPath = path.join(root, 'tools', 'lab', 'CURSOR_BACKTEST_IMPROVEMENT_PLAN.md');
  if (existsSync(planPath)) {
    const append = [
      '',
      '---',
      '',
      `## Live run (${payload.generatedAt})`,
      '',
      `- API: \`${base}\``,
      `- Result: **${hardPass}/${results.length}** hard pass · plane bars ${barsOk ? 'ok' : 'FAIL'}`,
      `- Knowledge ${knowledgeHard}/${knowledge.length} · coding ${codingHard}/${coding.length} · secretary ${secretaryHard}/${secretary.length}`,
      ...results.map(
        (r) =>
          `- \`${r.id}\`: ${r.hardOk ? 'PASS' : 'FAIL'} ${r.failures.join('|') || 'ok'} · ${Math.round(r.ms / 1000)}s · approvals=${r.approvals}`,
      ),
      `- Report: \`data/_skill_tool_lab/cursor-query-live-backtest-report.md\``,
      '',
    ].join('\n');
    writeFileSync(planPath, readFileSync(planPath, 'utf8') + append, 'utf8');
  }

  // Plane bars (knowledge ≥75%, coding/secretary 100%, no coding-abandon on knowledge)
  process.exit(barsOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
