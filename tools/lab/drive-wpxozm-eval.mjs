#!/usr/bin/env node
/**
 * Drive MY Agent against a workspace for the 재테크·부동산 master eval.
 * Usage: node tools/lab/drive-wpxozm-eval.mjs
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = process.env.MY_AGENT_API || 'http://127.0.0.1:10200';
const WORKSPACE = process.env.CQR_EVAL_WORKSPACE || String.raw`C:\Users\Temp\Desktop\현철\코딩연습\wpxozm`;
const outDir = path.join(WORKSPACE, '_my_agent_eval');
mkdirSync(outDir, { recursive: true });

const MESSAGE = `AGENT 모드로 진행. 작업 폴더는 이미 바인딩됨.

목표: 「재테크 및 부동산 보고서」 웹 앱 + 검증된 종합 분석 보고서를 이 워크스페이스에 완성.

필수 산출물 (디스크에 실제 파일):
1) 실행 가능한 웹 앱 (index.html + app.js + styles.css 최소, 또는 Vite/React 단일 페이지)
   - 재테크 포트폴리오 요약, 부동산 매물/관심지역 메모, 보고서 미리보기/내보내기(마크다운 또는 인쇄)
   - 로컬 스토리지로 데이터 유지
2) docs/MARKET_REPORT.md — 시장·경쟁·타겟 종합 보고서 (한국어, 근거/가정 명시)
3) docs/ACCEPTANCE.md — 완료 증거: 변경 파일 목록, 스모크 방법, diagnostics 메모
4) README.md — 실행 방법

제약:
- 완료=증거. 파일 없으면 완료 선언 금지.
- MY Agent 제품 소스(ui/workspace, shell) 수정 금지. 이 워크스페이스만.
- 문서·검색 보조가 필요하면 markitdown_convert / repomix_pack / ast_grep_search 활용.
- 브라우저 검증 가능하면 Playwright로 로컬 HTML 스모크.

지금 구현 시작. Understanding Card 짧게 → mutate → verify.`;

async function jfetch(pathname, opts = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const logPath = path.join(outDir, `drive-${Date.now()}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const say = (s) => {
    const line = `[${new Date().toISOString()}] ${s}`;
    console.log(line);
    log.write(`${line}\n`);
  };

  say(`API=${API} WORKSPACE=${WORKSPACE}`);

  const health = await jfetch('/health');
  say(`health ${health.status} ${JSON.stringify(health.data).slice(0, 300)}`);
  if (!health.ok) process.exit(1);

  const ws = await jfetch('/config/dev-workspace', {
    method: 'PUT',
    body: JSON.stringify({ dev_workspace_root: WORKSPACE }),
  });
  say(`dev-workspace ${ws.status} ${JSON.stringify(ws.data).slice(0, 400)}`);
  if (!ws.ok) process.exit(1);

  const sess = await jfetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'wpxozm 재테크·부동산 eval' }),
  });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session ${sess.status} id=${sessionId}`);
  if (!sessionId) {
    say(`session body ${JSON.stringify(sess.data)}`);
    process.exit(1);
  }

  const body = {
    message: MESSAGE,
    model: 'auto',
    mode: 'web_dev',
    attachments: [],
  };

  say('POST /chat/stream (web_dev) …');
  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CQR-Session': sessionId,
    },
    body: JSON.stringify(body),
  });
  say(`stream HTTP ${res.status}`);
  if (!res.ok || !res.body) {
    say(await res.text());
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistant = '';
  const statuses = [];
  const mutates = [];
  let doneEvt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const block of parts) {
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const t = evt.type;
      if (t === 'status' && evt.text) {
        statuses.push(evt.text);
        say(`status: ${String(evt.text).slice(0, 200)}`);
      } else if (t === 'token' && evt.text) {
        assistant += evt.text;
      } else if (t === 'content_replace' && evt.text) {
        assistant = evt.text;
      } else if (t === 'workspace_mutate') {
        const paths = Array.isArray(evt.paths) ? evt.paths : [];
        mutates.push(...paths);
        say(`mutate: ${paths.join(', ')}`);
      } else if (t === 'tool' || t === 'tool_start' || t === 'tool_result') {
        say(`tool: ${JSON.stringify(evt).slice(0, 240)}`);
      } else if (t === 'done' || t === 'error') {
        doneEvt = evt;
        say(`${t}: ${JSON.stringify(evt).slice(0, 400)}`);
      }
    }
  }

  const summary = {
    at: new Date().toISOString(),
    api: API,
    workspace: WORKSPACE,
    sessionId,
    mutatePaths: [...new Set(mutates)],
    statusCount: statuses.length,
    assistantChars: assistant.length,
    assistantTail: assistant.slice(-2000),
    done: doneEvt,
    logPath,
  };
  writeFileSync(path.join(outDir, 'drive-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'assistant-final.md'), assistant || '(empty)');
  say(`DONE summary → ${path.join(outDir, 'drive-summary.json')}`);
  log.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
