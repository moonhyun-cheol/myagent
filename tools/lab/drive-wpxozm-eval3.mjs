#!/usr/bin/env node
/**
 * Re-drive after ASK/workspace fixes: implement 재테크·부동산 app in wpxozm via MY Agent.
 * The built-in loop owns deterministic mutation.
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const API = process.env.MY_AGENT_API || 'http://127.0.0.1:10200';
const WORKSPACE = process.env.CQR_EVAL_WORKSPACE || String.raw`C:\Users\Temp\Desktop\현철\코딩연습\wpxozm`;
const outDir = path.join(WORKSPACE, '_my_agent_eval');
mkdirSync(outDir, { recursive: true });

const MESSAGE = `web_dev AGENT. 바인딩된 이 워크스페이스에 프로그램을 만들어줘. 지금 파일 생성·작성 실행.

만들 것 (디스크에 실제 생성):
1. index.html, styles.css, app.js — 재테크·부동산 보고서 웹앱
   - 포트폴리오 요약, 부동산 메모, 마크다운 보고서 미리보기/내보내기, localStorage
2. docs/MARKET_REPORT.md — 한국어 시장·경쟁·타겟 분석 (가정 명시)
3. docs/ACCEPTANCE.md — 생성 파일 목록과 실행 방법
4. README.md — 실행 방법

제약: MY Agent 제품 소스(ui/workspace, shell)는 건드리지 마. 이 폴더만 write_file/edit_file/apply_patch.
완료=증거. Understanding Card 짧게 → mutate → node --check.`;

async function jfetch(pathname, opts = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
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
  const logPath = path.join(outDir, `drive3-${Date.now()}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const say = (s) => {
    const line = `[${new Date().toISOString()}] ${s}`;
    console.log(line);
    log.write(`${line}\n`);
  };

  const health = await jfetch('/health');
  say(`health ${health.status}`);
  if (!health.ok) process.exit(1);

  await jfetch('/config/dev-workspace', {
    method: 'PUT',
    body: JSON.stringify({ dev_workspace_root: WORKSPACE }),
  });
  const sess = await jfetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'wpxozm drive3 post-fix' }),
  });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);

  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CQR-Session': sessionId,
    },
    body: JSON.stringify({ message: MESSAGE, model: 'auto', mode: 'web_dev', attachments: [] }),
  });
  say(`HTTP ${res.status}`);
  if (!res.ok || !res.body) {
    say(await res.text());
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistant = '';
  const mutates = [];
  const statuses = [];
  let done = null;

  while (true) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const block of parts) {
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'status' || parsed.type === 'status') {
        const s = parsed.message || parsed.status || JSON.stringify(parsed).slice(0, 200);
        statuses.push(s);
        say(`status: ${s}`);
      }
      if (parsed.type === 'workspace_mutate' || event === 'workspace_mutate') {
        const paths = parsed.paths || parsed.mutatedPaths || [];
        mutates.push(...paths);
        say(`mutate: ${paths.join(', ')}`);
      }
      if (parsed.type === 'token' || parsed.delta) {
        assistant += parsed.delta || parsed.text || '';
      }
      if (parsed.type === 'answer' || parsed.content) {
        if (typeof parsed.content === 'string') assistant = parsed.content;
      }
      if (parsed.type === 'done' || event === 'done') {
        done = parsed;
        say(`done: ${JSON.stringify(parsed).slice(0, 240)}`);
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
    statusesHead: statuses.slice(0, 40),
    assistantChars: assistant.length,
    assistantTail: assistant.slice(-800),
    done,
    logPath,
    disk: {
      index: existsSync(path.join(WORKSPACE, 'index.html')),
      app: existsSync(path.join(WORKSPACE, 'app.js')),
      styles: existsSync(path.join(WORKSPACE, 'styles.css')),
      readme: existsSync(path.join(WORKSPACE, 'README.md')),
      market: existsSync(path.join(WORKSPACE, 'docs', 'MARKET_REPORT.md')),
      acceptance: existsSync(path.join(WORKSPACE, 'docs', 'ACCEPTANCE.md')),
    },
  };
  const summaryPath = path.join(outDir, 'drive3-summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  writeFileSync(path.join(outDir, 'assistant3-final.md'), assistant || '(empty)', 'utf8');
  say(`DONE summary → ${summaryPath}`);
  say(`disk=${JSON.stringify(summary.disk)} mutates=${summary.mutatePaths.length}`);
  const ok =
    summary.disk.index && summary.disk.app && summary.disk.styles && summary.disk.market;
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
